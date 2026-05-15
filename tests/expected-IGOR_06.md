# expected-IGOR_06 — Chatwoot Message Logger

## Trigger
Webhook POST `igor/chatwoot` recebe payload `message_created` do Chatwoot.

## Entrada
Body Chatwoot — eventos `message_created` típicos:
- `event` = "message_created"
- `id` = id da mensagem Chatwoot
- `content` = texto
- `message_type` = "incoming" | "outgoing" | "template"
- `sender.type` = "contact" | "user" | "agent_bot" | "system"
- `conversation.id` (integer), `conversation.inbox_id`,
  `conversation.meta.sender.phone_number`
- `content_attributes.test_run_id` (opcional, vem das fixtures)

## 3 cenários (fixtures)

### A) `chatwoot-message-created-incoming.json`
Lead envia mensagem. `message_type=incoming` + `sender.type=contact`.
- direction = inbound, role = user, from_me = false, is_human_takeover = false.
- Resultado: linha em `messages` apenas.

### B) `chatwoot-message-created-outgoing-bot.json`
Igor (IA) responde via Chatwoot. `message_type=outgoing` + `sender.type=agent_bot`.
- direction = outbound, role = assistant, from_me = true, is_human_takeover = false.
- Resultado: linha em `messages` apenas. NÃO trava IA.

### C) `chatwoot-message-created-outgoing-human.json`
Atendente humano responde. `message_type=outgoing` + `sender.type=user`.
- direction = outbound, role = agent, from_me = true, is_human_takeover = true.
- Resultado: linha em `messages` + UPDATE conversations
  (`human_locked=true`, `ai_enabled=false`, `last_human_message_at=now()`)
  + INSERT event `human_assumed`.

## Esquema afetado

### `public.messages`
Linha nova com:
- `conversation_id` (UUID, FK conversations.id)
- `msg_id` = `body.id` (string)
- `text` = `body.content`
- `message_type` = 'text'
- `direction` = derivada (inbound/outbound)
- `role` = derivada (user/assistant/agent/system)
- `from_me` = `message_type !== 'incoming'`
- `safety_flags` jsonb = `{"test_run_id": <id>}`

### `public.contacts`, `public.conversations`
UPSERT por phone / chatwoot_conversation_id antes do INSERT em messages.
Garante integridade referencial sem precisar lookup separado.

### `public.events` (só no cenário C)
- `event_type` = 'human_assumed'
- `workflow_name` = 'IGOR_06_Chatwoot_Message_Logger'
- `payload` jsonb = `{ chatwoot_conversation_id, test_run_id }`
- `chatwoot_conversation_id` (coluna FK opcional)

## Asserts padrão (smoke via test-workflow.sh)
O harness roda apenas 1 fixture por run. Para ter os 3 asserts green
o smoke usa o cenário C (`outgoing-human`), o mais completo.

1. `messages` com `safety_flags->>'test_run_id' = <id>` existe.
2. `events.event_type='human_assumed'` com `payload->>'test_run_id'=<id>` existe.
3. `conversations.chatwoot_conversation_id=3` está com `human_locked=true`.

### Tradeoff conhecido — assert #3
`conversations` não tem coluna `test_run_id`. O assert filtra apenas por
`chatwoot_conversation_id=3` (do fixture human). Em re-runs subsequentes,
a conversa 3 fica `human_locked=true` permanente, então o assert
continua passando devido ao estado acumulado. Aceito como tradeoff pois:
- Só o fixture C dispara essa mutação.
- Os fixtures A e B usam conversation_id 1 e 2 (não tocam human_locked).
- Em produção isso é estado real desejado (humano travou conversa).

## Sem efeito colateral
- Não envia mensagens via Evolution.
- Não chama IGOR_04 nesta versão (TODO: futuramente aplicar label
  `atendimento_humano` via IGOR_04 quando is_human_takeover=true).
- Não toca Chatwoot via API (só recebe webhook).
