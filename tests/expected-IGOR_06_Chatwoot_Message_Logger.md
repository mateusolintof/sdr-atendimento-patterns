# expected — IGOR_06_Chatwoot_Message_Logger

Webhook (`POST /webhook/igor/chatwoot`) recebe payloads do Chatwoot. Filtro
determinístico (`event === 'message_created'`), espelhamento de mensagens em
`public.messages`, e bloqueio de IA quando atendente humano responde
(`message_type=outgoing` + `sender.type=user`).

## Trigger
Webhook `n8n-nodes-base.webhook@2.1` em `POST /webhook/igor/chatwoot`.
`responseMode: 'lastNode'`, response HTTP 200 com JSON `{ok, branch}`.

## Payload de entrada
Schema `message_created` do Chatwoot (campos críticos):

```text
event                 : 'message_created' (REQUIRED para passar filter)
id                    : <int> (msg_id)
message_type          : 'incoming' | 'outgoing'
content               : <string>
created_at            : ISO timestamp
sender                : { id, type: 'contact' | 'user' | 'agent_bot', name? }
conversation          : { id, contact_inbox: { contact_id }, additional_attributes? }
additional_attributes : { test_run_id? }  // propaga em events
account               : { id }
```

## Decisões determinísticas

### Filter 1 — event === 'message_created'
- Se `body.event !== 'message_created'` → INSERT `events('event_filtered', {reason, event, message_type, test_run_id})` + response 200 `{ok: true, branch: 'event_filtered'}`. **NÃO** espelha, **NÃO** trava.
- Se `body.event === 'message_created'` → segue para normalize.

### Normalize Chatwoot Message
Code node extrai campos e classifica `_branch`:
- `outgoing + user`      → `human_takeover`
- `outgoing + agent_bot` → `bot_noop`
- `incoming + contact`   → `inbound_noop`
- qualquer outra combinação → `unhandled`

### Mirror universal (todas as mensagens válidas)
1. UPSERT `public.messages` (ON CONFLICT msg_id DO UPDATE) com `direction`, `role`, `from_me`.
2. INSERT `events('message_mirrored', {msg_id, message_type, sender_type, branch, content_length, test_run_id})`.

### Switch por branch

| Output | Branch         | Ações                                                                                     |
|--------|----------------|-------------------------------------------------------------------------------------------|
| 0      | human_takeover | UPDATE conversations → CALL IGOR_04 → INSERT events('human_assumed') → Human Takeover Output → merge[1] |
| 1      | bot_noop       | Bot NoOp Output → merge[2]                                                                |
| 2      | inbound_noop   | Inbound NoOp Output → merge[3]                                                            |
| 3 (fallback) | unhandled | INSERT events('unhandled_message_type') → Unhandled Output → merge[4]                     |

### Human Takeover (output 0)
1. UPDATE `public.conversations` SET `human_locked=true, ai_enabled=false, state='human_assigned', last_human_message_at=created_at, updated_at=now()` WHERE `chatwoot_conversation_id = $2`.
2. `executeWorkflow` IGOR_04 (`AJF7dhGrqJEXMLqz`) com payload:
   - `chatwoot_conversation_id`: do payload.
   - `chatwoot_contact_id`: do `conversation.contact_inbox.contact_id`.
   - `labels_to_add`: `['atendimento_humano', 'ai_disabled']`.
   - `labels_to_remove`: `[]`.
   - `custom_attributes.conversation`: `{automation_state: 'human_assigned', lead_status: 'humano_em_atendimento', taken_at: created_at}`.
   - `custom_attributes.contact`: `{}`.
   - `test_run_id`: propaga.
3. INSERT `events('human_assumed', {chatwoot_conversation_id, chatwoot_contact_id, agent_user_id, agent_user_name, msg_id, taken_at, labels_applied: ['atendimento_humano','ai_disabled'], test_run_id})`.
4. Emite `{ok: true, branch: 'human_takeover'}` no merge.

### Bot NoOp / Inbound NoOp
Apenas emitem `{ok: true, branch: '<noop>'}` no merge. Não tocam conversations.

### Unhandled
INSERT `events('unhandled_message_type', {msg_id, message_type, sender_type, reason: 'unhandled_combo', test_run_id})` + `{ok: true, branch: 'unhandled'}` no merge.

## LLM
Nenhuma. Workflow é determinístico puro.

## Cobertura por fixture

| Fixture                                          | event filter | _branch         | mirror (events + messages) | UPDATE conv | CALL IGOR_04 | events('human_assumed') | events('unhandled_message_type') | events('event_filtered') |
|--------------------------------------------------|--------------|-----------------|----------------------------|-------------|--------------|-------------------------|----------------------------------|--------------------------|
| `IGOR_06_message_created_incoming.json`          | PASS         | inbound_noop    | sim                        | nao         | nao          | 0                       | 0                                | 0                        |
| `IGOR_06_message_created_outgoing_human.json`    | PASS         | human_takeover  | sim                        | **sim**     | **sim** (`['atendimento_humano','ai_disabled']`) | **1**             | 0                                | 0                        |
| `IGOR_06_message_created_outgoing_bot.json`      | PASS         | bot_noop        | sim                        | nao         | nao          | 0                       | 0                                | 0                        |
| `IGOR_06_event_conversation_updated.json`        | **FAIL**     | n/a             | nao                        | nao         | nao          | 0                       | 0                                | **1**                    |

## Eventos esperados em `public.events`

Filtrar por `payload->>'test_run_id'`:

### IGOR_06_FIXTURE_incoming
- 1× `message_mirrored` (workflow_name=IGOR_06; payload.branch=inbound_noop).
- 0× `human_assumed`, `event_filtered`, `unhandled_message_type`, `label_added`.

### IGOR_06_FIXTURE_outgoing_human
- 1× `message_mirrored` (branch=human_takeover).
- 1× `human_assumed` (payload.chatwoot_conversation_id=9602, agent_user_id=17, labels_applied=['atendimento_humano','ai_disabled']).
- 1× `label_added` (workflow_name=IGOR_04, label=atendimento_humano).
- 1× `label_added` (workflow_name=IGOR_04, label=ai_disabled).
- 1× `attribute_set` (workflow_name=IGOR_04, scope=conversation).
- `conversations.human_locked=true` para conv 9602.

### IGOR_06_FIXTURE_outgoing_bot
- 1× `message_mirrored` (branch=bot_noop).
- 0× `human_assumed`, `label_added` (IGOR_04 não chamado).
- `conversations.human_locked=false` para conv 9603.

### IGOR_06_FIXTURE_event_other
- 1× `event_filtered` (payload.event='conversation_updated').
- 0× `message_mirrored`, `human_assumed`, `messages` rows.

## Pré-requisito de fixtures
As conversations referenciadas (`chatwoot_conversation_id` 9601, 9602, 9603) devem
existir em `public.conversations` antes de executar os fixtures. Fase C deve:

```sql
INSERT INTO public.contacts (phone, name) VALUES
  ('+5511999990601', 'Lead Teste IGOR06 Inbound'),
  ('+5511999990602', 'Lead Teste IGOR06 Human Takeover'),
  ('+5511999990603', 'Lead Teste IGOR06 Bot')
ON CONFLICT (phone) DO NOTHING;

INSERT INTO public.conversations (contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state, ai_enabled, human_locked)
SELECT id, 9601, 1, 'open', true, false FROM public.contacts WHERE phone = '+5511999990601'
ON CONFLICT (chatwoot_conversation_id) DO NOTHING;
-- (mesma estrutura para 9602, 9603)
```

A conversa 9604 do `event_other` é só `event_filtered` — não precisa de row em
`conversations` porque o filter para antes do mirror.

## Side effects fora de Postgres
- Chamada HTTP via IGOR_04 para `${CHATWOOT_BASE_URL}/api/v1/accounts/{account_id}/conversations/{conv}/labels` (POST). Em modo dry-run de Fase C, a credencial `igor_chatwoot_api` aponta para mock OU rolla com modo `continueOnFail`. O assert é sobre `events('label_added')` que o IGOR_04 grava antes do POST HTTP — então mesmo se o Chatwoot real falhar, o event existe.

## Settings persistidos (em JSON canônico pós-PATCH)
- `active: false`
- `settings.errorWorkflow: 'ZrsbaSTlW5bqMEaS'` (IGOR_07_Error_Logger).
- `settings.executionOrder: 'v1'`
- `settings.availableInMCP: true`
- `tags: ['igor', 'inbound', 'webhook', 'fase-b-rebuild']`
