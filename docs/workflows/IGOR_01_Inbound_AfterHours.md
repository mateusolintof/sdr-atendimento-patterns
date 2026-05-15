# IGOR_01_Inbound_AfterHours

Webhook de entrada da Evolution API (eventos `MESSAGES_UPSERT`) com matriz de
bloqueio determinístico v1.

## Trigger

- `POST /webhook/igor/inbound`
- `responseMode = responseNode` (sempre responde 200 com JSON).

## Pipeline v1

1. **Webhook Inbound** — recebe payload Evolution.
2. **Extract Fields** — normaliza:
   - `phone` (regex `\D` removido de `data.key.remoteJid`).
   - `fromMe` (boolean).
   - `messageType` (`conversation`→`text`, `audioMessage`→`audio`, etc.).
   - `text` (`message.conversation` ou `extendedTextMessage.text`).
   - `chatwoot_conversation_id`, `chatwoot_inbox_id`.
   - `test_run_id`, `_test_hour_override` (test-only).
3. **IF From Me**:
   - `fromMe===true` → **Log Blocked FromMe** (`events('inbound_blocked', reason='from_me')`) → 200 NoOp.
4. **Lookup Settings** — busca `ai_enabled_global` + `after_hours_window`.
5. **Compute Routing** — calcula:
   - `aiGlobal` (kill switch).
   - `phoneValid` (regex `^55\d{11}$`).
   - `isAfterHours` (hora ≥ start OU < end, com `_test_hour_override` opcional).
   - `blocked` = primeiro motivo encontrado (`ai_disabled_global` | `invalid_phone` | `within_hours`) ou `null`.
6. **IF Blocked**:
   - `blocked !== null` → **Log Blocked Generic** → 200 com `{ blocked }`.
   - senão → continua.
7. **Lookup Conversation State** — query LEFT JOIN garante 1 row mesmo quando conversa não existe; retorna `human_locked`, `ai_enabled`, `conversation_exists`.
8. **Merge Conversation State** — combina com payload anterior.
9. **IF Conversation Blocked**:
   - `human_locked || !ai_enabled` → **Log Blocked Conversation** (`reason='conversation_locked'`) → 200.
   - senão → **Log Routed** (`events('inbound_routed', target_workflow='IGOR_03', current_flow='after_hours')`) → 200.

## Matriz de bloqueio (ordem em v1)

| # | Condição | Reason gravado |
|---|----------|----------------|
| 1 | `fromMe===true` | `from_me` |
| 2 | `ai_enabled_global===false` | `ai_disabled_global` |
| 3 | phone não bate `^55\d{11}$` | `invalid_phone` |
| 4 | janela DE EXPEDIENTE (hora ∈ [end, start)) | `within_hours` |
| 5 | `conversations.human_locked` ou `ai_enabled=false` | `conversation_locked` |

Todos terminam em 200 NoOp com `events('inbound_blocked', payload.reason=…)`.

## Test seam

`_test_hour_override` (integer 0-23) força a hora avaliada. Em produção esse
campo nunca vem; em fixtures de smoke é usado para evitar esperar 18:30. TODO
hardening: adicionar guard `process.env.IGOR_ENV !== 'production'` para ignorar
o campo em prod.

## Credenciais

- `igor_supabase_postgres` — lookups (`settings`, `conversations`) + INSERT em
  `events`.

## TODOs v2

- **Per-workflow gate** (`settings.workflows_enabled.IGOR_01`) deliberadamente
  NÃO consultado em v1 — o seed traz a chave em `false` e não há ferramenta
  segura para alternar via testes. Reintroduzir junto com /admin tooling.
- **Redis lock + RPUSH batching** (`igor:lock:inbound:{phone}` + `igor:batch:…`)
  para combater races quando o lead manda várias mensagens em poucos segundos.
  Credential `igor_redis_embedded` ainda não conferida.
- **Chamada para IGOR_02** (Media Normalizer) quando `messageType !== 'text'`.
  Hoje workflow registra `inbound_routed` e termina — não normaliza mídia.
- **Chamada para IGOR_03** (Agent After-Hours) quando este existir (wave 4).
  Hoje workflow só grava `target_workflow='IGOR_03'` como sinal.
- **Lookup `contacts.do_not_contact`** para bloqueio de opt-out antes de
  responder.
- **Lookup `campaign_contacts`** para detectar resposta de campanha em curso
  (rota para IGOR_12 quando este existir).
- **Tratamento de feriados** (`settings.holidays`) com mesma semântica de
  after-hours.

## Smoke tests

```bash
# canônico (after-hours happy) — 3 asserts ✓
bash scripts/test-workflow.sh IGOR_01_Inbound_AfterHours fixtures/evolution-text-after-hours.json

# fromMe (manual)
curl -X POST $N8N_WEBHOOK_URL/webhook/igor/inbound -d @fixtures/evolution-fromme.json -H "Content-Type: application/json"

# within-hours (manual)
curl -X POST $N8N_WEBHOOK_URL/webhook/igor/inbound -d @fixtures/evolution-within-hours.json -H "Content-Type: application/json"
```

## Status

- v1 importado (id `YxFzT0XaP39tstua`), ativo.
- 3 asserts ✓ via `test-workflow.sh` (after-hours happy).
- Cenários `from_me` e `within_hours` validados manualmente.
