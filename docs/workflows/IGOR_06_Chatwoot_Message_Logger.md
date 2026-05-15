# IGOR_06_Chatwoot_Message_Logger

## Identificação
- **n8n_id**: `xpXRENR7Hoo2W5p3`
- **n8n URL**: `https://n8n.almaconvert.com.br/workflow/xpXRENR7Hoo2W5p3`
- **Estado inicial**: `active: false` (ativação manual no UI após Fase C).
- **Tipo**: webhook receiver (Chatwoot → INSERT messages + bloqueio determinístico de IA).

## Contrato literal (de `docs/IMPLEMENTATION_PLAN.md:173-183`)

```text
- Trigger: webhook (POST /webhook/igor/chatwoot) recebendo eventos Chatwoot.
- Entrada: payload message_created do Chatwoot.
- Decisões:
  - body.event === 'message_created' (filtra outros eventos).
  - Se message_type === 'outgoing' e sender.type === 'user' (agente humano):
    → SET conversations.human_locked = true, ai_enabled = false.
    → Aplicar label 'atendimento_humano' VIA IGOR_04.
    → Insert events('human_assumed').
  - Se sender.type === 'agent_bot' → não trava (é o próprio Igor).
  - Sempre insere `messages` (espelhamento).
- LLM: não.
- Mutações: conversations, messages, events; Chatwoot label via IGOR_04.
- Observabilidade: human_assumed, message_mirrored.
```

## Debt fix (commit revertido `f116f35`)

Na versão anterior a chamada IGOR_04 com label `atendimento_humano` estava
**ausente**. Esta reconstrução adiciona:

- `executeWorkflow` chamando IGOR_04 (`AJF7dhGrqJEXMLqz`) com `labels_to_add: ['atendimento_humano', 'ai_disabled']` E `custom_attributes.conversation: {automation_state: 'human_assigned', lead_status: 'humano_em_atendimento', taken_at}`.

Documentado em `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` §5.

## Gates aplicados
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger) — **persistido no JSON canônico** (`settings.errorWorkflow`). Aplicado via REST API PUT após `create_workflow_from_code`.
- `active: false` por padrão — **persistido no JSON canônico**. Ativação manual no UI após validação em Fase C + autorização explícita do usuário.
- `tags: ['igor', 'inbound', 'webhook', 'fase-b-rebuild']` — **persistido no JSON canônico**. Tag `webhook` criada via REST API quando ausente.
- `availableInMCP: true` — habilita gestão via n8n MCP (`archive_workflow`, `get_workflow_details` etc).
- `executionOrder: 'v1'` — n8n moderno.
- Webhook **não** tem `settings.workflows_enabled.IGOR_06` check — workflow só processa o que o Chatwoot manda (a fonte é Chatwoot via webhook config).

## Entradas (webhook body — schema Chatwoot)

| campo (body)                                  | tipo         | uso |
|-----------------------------------------------|--------------|-----|
| `event`                                       | string       | filter `=== 'message_created'`. |
| `id`                                          | int          | `msg_id` em messages + events. |
| `message_type`                                | string       | `incoming` ou `outgoing` (direciona `_branch`). |
| `content`                                     | string       | gravado em `messages.text`. |
| `created_at`                                  | timestamptz  | `messages.created_at` e `conversations.last_human_message_at` (no human takeover). |
| `sender.id` / `sender.type` / `sender.name`   | mixed        | `sender_type` define `_branch` em conjunto com `message_type`. |
| `conversation.id`                             | int          | mapeia para `conversations.chatwoot_conversation_id`. |
| `conversation.contact_inbox.contact_id`       | int          | passado para IGOR_04 como `chatwoot_contact_id`. |
| `additional_attributes.test_run_id`           | string       | propaga em `payload.test_run_id` de todos os events para fixtures de Fase C. |
| `account.id`                                  | int          | metadata. |

## Node-by-node summary

| # | Node name                              | Type                                    | Função |
|---|----------------------------------------|-----------------------------------------|--------|
| 1 | Chatwoot Webhook                       | `webhook@2.1` POST /webhook/igor/chatwoot | recebe payload. response 200, `firstEntryJson`. |
| 2 | IF event=message_created               | `if@2.3`                                | filtro determinístico: `$json.body.event === 'message_created'`. onFalse → log + filtered response; onTrue → normalize. |
| 3 | INSERT event_filtered                  | `postgres@2.6` (executeQuery)           | onFalse path: INSERT `events('event_filtered', {reason, event, message_type, test_run_id})`. |
| 4 | Filtered Response                      | `set@3.4`                               | onFalse path: emit `{ok: true, branch: 'event_filtered'}` para o merge final. |
| 5 | Normalize Chatwoot Message             | `code@2` (runOnceForAllItems)           | extrai todos os campos, coerce types, classifica `_branch` (`human_takeover` / `bot_noop` / `inbound_noop` / `unhandled`), seta `direction`, `role`, `from_me`. |
| 6 | UPSERT Messages                        | `postgres@2.6` (executeQuery)           | INSERT INTO messages SELECT c.id FROM conversations c WHERE chatwoot_conversation_id=$8; ON CONFLICT (msg_id) DO UPDATE. `continueOnFail: true`. |
| 7 | INSERT message_mirrored                | `postgres@2.6` (executeQuery)           | INSERT events('message_mirrored', {msg_id, message_type, sender_type, direction, role, from_me, branch, content_length, test_run_id}). |
| 8 | Route By Branch                        | `switch@3.4` (rules; fallback=extra)    | 4 outputs: human_takeover, bot_noop, inbound_noop, unhandled (fallback). |
| 9 | UPDATE conversations SET human_locked  | `postgres@2.6` (executeQuery)           | human_takeover branch: UPDATE conversations SET human_locked=true, ai_enabled=false, state='human_assigned', last_human_message_at=$1, updated_at=now() WHERE chatwoot_conversation_id=$2. |
|10 | CALL IGOR_04 atendimento_humano        | `executeWorkflow@1.3`                   | invoca IGOR_04 com `labels_to_add: ['atendimento_humano','ai_disabled']` + `custom_attributes.conversation: {automation_state, lead_status, taken_at}`. `waitForSubWorkflow: true`. `continueOnFail: true`. |
|11 | INSERT human_assumed                   | `postgres@2.6` (executeQuery)           | INSERT events('human_assumed', {chatwoot_conversation_id, chatwoot_contact_id, agent_user_id, agent_user_name, msg_id, taken_at, labels_applied, test_run_id}). |
|12 | Human Takeover Output                  | `set@3.4`                               | emit `{ok: true, branch: 'human_takeover'}` para merge[1]. |
|13 | Bot NoOp Output                        | `set@3.4`                               | emit `{ok: true, branch: 'bot_noop'}` para merge[2]. |
|14 | Inbound NoOp Output                    | `set@3.4`                               | emit `{ok: true, branch: 'inbound_noop'}` para merge[3]. |
|15 | INSERT unhandled_message_type          | `postgres@2.6` (executeQuery)           | fallback branch: INSERT events('unhandled_message_type', {msg_id, message_type, sender_type, reason, test_run_id}). |
|16 | Unhandled Output                       | `set@3.4`                               | emit `{ok: true, branch: 'unhandled'}` para merge[4]. |
|17 | Merge Branches                         | `merge@3.2` (append, numberInputs=5)    | consolida as 5 saídas para o response do webhook (`responseMode: 'lastNode'`). |

## Fluxo de conexões

```
Chatwoot Webhook
  → IF event=message_created
      onFalse → INSERT event_filtered → Filtered Response → Merge Branches[0]
      onTrue  → Normalize Chatwoot Message
                  → UPSERT Messages
                      → INSERT message_mirrored
                          → Route By Branch
                              case 0 (human_takeover) → UPDATE conversations → CALL IGOR_04 → INSERT human_assumed → Human Takeover Output → Merge Branches[1]
                              case 1 (bot_noop)       → Bot NoOp Output → Merge Branches[2]
                              case 2 (inbound_noop)   → Inbound NoOp Output → Merge Branches[3]
                              case 3 (fallback)       → INSERT unhandled_message_type → Unhandled Output → Merge Branches[4]
```

## Credenciais usadas
- `igor_supabase_postgres` (postgres) — 6 nós Postgres.
- Auth do webhook: **none** (Chatwoot envia direto; segurança via IP whitelist no firewall do n8n, fora do escopo deste workflow).
- A chamada IGOR_04 usa credenciais do IGOR_04 (transitivo: `igor_chatwoot_api`).

## SQL crítico

### UPSERT messages
```sql
INSERT INTO public.messages (conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me, created_at)
SELECT c.id, NULLIF($1::text,''), $2::text, NULL, COALESCE(NULLIF($3::text,''),'text'),
       $4::text, $5::text, $6::boolean, COALESCE(NULLIF($7::text,'')::timestamptz, now())
FROM public.conversations c
WHERE c.chatwoot_conversation_id = NULLIF($8::text, '')::int
ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE
SET text = EXCLUDED.text, direction = EXCLUDED.direction, role = EXCLUDED.role, from_me = EXCLUDED.from_me;
```
Usa `008_messages_msgid_unique.sql` (UNIQUE parcial em `msg_id WHERE msg_id IS NOT NULL`).

### UPDATE conversations (human takeover)
```sql
UPDATE public.conversations
SET human_locked = true,
    ai_enabled = false,
    state = 'human_assigned',
    last_human_message_at = COALESCE(NULLIF($1::text,'')::timestamptz, now()),
    updated_at = now()
WHERE chatwoot_conversation_id = NULLIF($2::text, '')::int
RETURNING id, chatwoot_conversation_id, human_locked, ai_enabled, state;
```

## IGOR_04 invocation contract

```json
{
  "chatwoot_conversation_id": "<conv id>",
  "chatwoot_contact_id": "<contact id>",
  "labels_to_add": ["atendimento_humano", "ai_disabled"],
  "labels_to_remove": [],
  "custom_attributes": {
    "conversation": {
      "automation_state": "human_assigned",
      "lead_status": "humano_em_atendimento",
      "taken_at": "<message.created_at>"
    },
    "contact": {}
  },
  "test_run_id": "<propagado>"
}
```

`mode: 'once'`, `waitForSubWorkflow: true`, `continueOnFail: true` — se IGOR_04
falhar (ex: Chatwoot API down), o erro propaga para `IGOR_07` mas o
fluxo principal não trava (UPDATE conversations + INSERT human_assumed
continuam executando antes da chamada IGOR_04 só se reordenarmos; **na ordem
atual** a chamada IGOR_04 acontece ENTRE o UPDATE conversations e o INSERT
human_assumed; com `continueOnFail`, mesmo se IGOR_04 explodir, o
`human_assumed` ainda grava — o bloqueio determinístico está garantido pelo
UPDATE no Postgres, e a label no Chatwoot é best-effort observability).

## Fixtures e asserts
- 4 fixtures em `fixtures/IGOR_06_*.json`:
  - `IGOR_06_message_created_incoming.json` — lead falando; `inbound_noop`.
  - `IGOR_06_message_created_outgoing_human.json` — atendente humana; `human_takeover`.
  - `IGOR_06_message_created_outgoing_bot.json` — Igor IA; `bot_noop` (não trava).
  - `IGOR_06_event_conversation_updated.json` — event != message_created; filter NoOp.
- Asserts em `tests/asserts-IGOR_06_Chatwoot_Message_Logger.sql` (22 asserts).
- Matriz expected em `tests/expected-IGOR_06_Chatwoot_Message_Logger.md`.

## Riscos e mitigations

1. **Webhook sem auth**: Chatwoot envia direto. Mitigation: IP whitelist no
   reverse proxy ou `httpHeaderAuth` em Fase D (follow-up #43).
2. **Race entre IGOR_06 (humano) e IGOR_03 (IA respondendo)**: se IA já está
   gerando resposta quando humano responde, IGOR_03 ainda pode enviar. IGOR_03
   deve checar `human_locked=true` antes do reply path (verificado em
   `docs/workflows/IGOR_03_*.md`).
3. **Conversation 9601/9602/9603 não existirem**: UPSERT messages e UPDATE
   conversations no-op. Asserts esperam 1 row → falham. Fase C deve semear via
   fixture setup (vide `expected-IGOR_06_*.md`).
4. **IGOR_04 falhar (Chatwoot down)**: `continueOnFail: true` → fluxo
   continua, errorWorkflow IGOR_07 grava `infra_error`. Label não aparece no
   Chatwoot mas o bloqueio Postgres já está aplicado.

## TODOs (Fase C)
- Smoke test integrado: POST cada fixture para `/webhook/igor/chatwoot` em
  staging, rodar asserts, validar comportamento.
- Seed conversations 9601/9602/9603 no fixture setup.
- Validar IGOR_04 labels via Chatwoot API real (não só via events Postgres).

## Reviewer notes
- Filter event=message_created está implementado e gravado em events. ✓
- Mirror universal sempre (3 fixtures válidas → 3 rows messages). ✓
- HUMAN_TAKEOVER chamado APENAS para outgoing+user. ✓
- Chamada IGOR_04 com labels EXATAS `['atendimento_humano','ai_disabled']` + `custom_attributes.conversation`. ✓ (debt fix)
- UPDATE conversations SET human_locked=true, ai_enabled=false, state='human_assigned'. ✓
- errorWorkflow + tags + active=false persistidos no JSON canônico pós-PATCH (linhas 7, 786-788, 824/836/842). ✓
- SOURCE OF TRUTH NOTICE no SDK. ✓
