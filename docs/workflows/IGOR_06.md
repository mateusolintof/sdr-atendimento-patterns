# IGOR_06_Chatwoot_Message_Logger

## Trigger
`n8n-nodes-base.webhook` — POST `igor/chatwoot` (responseMode = responseNode).

Chatwoot envia eventos para esse endpoint (configurar no
Chatwoot Inbox → Webhook quando autorizado em produção).

## Nodes em ordem
1. **Chatwoot Webhook** — POST `igor/chatwoot`, body sob `$json.body`.
2. **IF Event Filter** — `body.event === 'message_created'`?
   - false → **Response NoOp** (204, body vazio).
   - true → continua.
3. **Normalize Message** (Code, runOnceForEachItem) — extrai:
   - `phone` (sanitizado de `conversation.meta.sender.phone_number`)
   - `chatwoot_conversation_id` (int), `chatwoot_inbox_id` (int)
   - `msg_id` (string, do `body.id`), `content`
   - `direction` (incoming→inbound, demais→outbound)
   - `role` (contact→user, agent_bot→assistant, user→agent, system→system)
   - `from_me` (`message_type !== 'incoming'`)
   - `is_human_takeover` (`outgoing` AND `sender.type === 'user'`)
   - `test_run_id` (de `content_attributes.test_run_id`)
4. **Upsert Contact + Conversation + Insert Message** (Postgres `executeQuery`)
   — uma única query CTE:
   - UPSERT `contacts` por `phone` (ON CONFLICT bump `updated_at`).
   - UPSERT `conversations` por `chatwoot_conversation_id` (cria se não existe).
   - INSERT em `messages` com FK válida.
   - `safety_flags` jsonb propaga `test_run_id`.
5. **IF Is Human Takeover** — `is_human_takeover === true`?
   - false → Response Success direto.
   - true → mutação extra de bloqueio.
6. **Update + Log Human Assumed** (Postgres `executeQuery`) — CTE:
   - UPDATE `conversations` SET `human_locked=true`, `ai_enabled=false`,
     `last_human_message_at=now()`, `updated_at=now()`.
   - INSERT `events('human_assumed', 'IGOR_06_…', payload, chatwoot_conversation_id)`.
7. **Response Success** — JSON `{"ok": true}`, status 200.

## Conexões
```
Chatwoot Webhook → IF Event Filter
  [false] → Response NoOp
  [true]  → Normalize Message
            → Upsert Contact + Conversation + Insert Message
            → IF Is Human Takeover
              [false] → Response Success
              [true]  → Update + Log Human Assumed → Response Success
```

## Mutações produzidas
- **`public.contacts`**: UPSERT por phone (idempotente, bump `updated_at`).
- **`public.conversations`**: UPSERT por `chatwoot_conversation_id`. No cenário
  human-takeover, UPDATE `human_locked`, `ai_enabled`, `last_human_message_at`.
- **`public.messages`**: 1 linha por mensagem Chatwoot espelhada.
- **`public.events`**: 1 linha `event_type='human_assumed'` quando humano assume
  (apenas cenário C).

## Credentials usadas
- `igor_supabase_postgres` (Postgres, Session Pooler).

## Comportamento exato
- `body.event !== 'message_created'` → 204 sem mutação.
- Sender `contact` (incoming) → espelha apenas. Não trava.
- Sender `agent_bot` (outgoing) → espelha apenas. NÃO trava IA (é o próprio Igor).
- Sender `user` (outgoing) → espelha + trava IA (`human_locked=true`,
  `ai_enabled=false`) + log `human_assumed`.

## TODO v2 (intencionalmente fora desta task)
- Chamar IGOR_04 via executeWorkflow para aplicar label `atendimento_humano`
  quando `is_human_takeover=true`. Hoje apenas registra evento — evita
  acoplamento dos testes.
- Suportar `message_updated`, `conversation_status_changed`, `conversation_resolved`
  para refletir mudanças de estado em `conversations.state`.
- Anti-replay: dedup por `msg_id` (Chatwoot pode reentregar webhooks).

## Como outros workflows acionam
Webhook direto do Chatwoot (POST). Configurar no Chatwoot quando
`ALLOW_PRODUCTION_MUTATIONS=true`. Em teste, o `scripts/test-workflow.sh`
detecta trigger webhook e POSTa direto no path.

## Como testar localmente
```
bash scripts/test-workflow.sh IGOR_06_Chatwoot_Message_Logger \
  fixtures/chatwoot-message-created-outgoing-human.json
```

3 fixtures disponíveis:
- `chatwoot-message-created-incoming.json` — lead.
- `chatwoot-message-created-outgoing-bot.json` — Igor IA (não trava).
- `chatwoot-message-created-outgoing-human.json` — atendente (trava IA).
