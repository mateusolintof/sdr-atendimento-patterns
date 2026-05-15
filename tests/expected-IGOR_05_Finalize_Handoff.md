# Expected results — IGOR_05_Finalize_Handoff

Mapa de observações esperadas por fixture. Executado pelo runner de Fase C com `mcp__n8n-mcp__execute_workflow` + asserts SQL. Cada fixture roda em isolamento; cada assert deve retornar `actual = expected`.

## Preconditions (DB seed antes do smoke)

```sql
-- Contatos
INSERT INTO public.contacts (id, phone) VALUES
  ('00000000-0000-0000-0000-000000008001'::uuid, '5511900000001'),
  ('00000000-0000-0000-0000-000000008002'::uuid, '5511900000002'),
  ('00000000-0000-0000-0000-000000008003'::uuid, '5511900000003'),
  ('00000000-0000-0000-0000-000000008004'::uuid, '5511900000004')
ON CONFLICT DO NOTHING;

-- Conversations (chatwoot_conversation_id INT — coincide com fixtures)
INSERT INTO public.conversations
  (id, contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state, ai_enabled, human_locked)
VALUES
  ('10000000-0000-0000-0000-000000009001'::uuid, '00000000-0000-0000-0000-000000008001'::uuid, 9001, 1, 'ai_after_hours', true, false),
  ('10000000-0000-0000-0000-000000009002'::uuid, '00000000-0000-0000-0000-000000008002'::uuid, 9002, 1, 'ai_after_hours', true, false),
  ('10000000-0000-0000-0000-000000009003'::uuid, '00000000-0000-0000-0000-000000008003'::uuid, 9003, 1, 'ai_after_hours', true, false),
  ('10000000-0000-0000-0000-000000009004'::uuid, '00000000-0000-0000-0000-000000008004'::uuid, 9004, 1, 'ai_after_hours', true, false)
ON CONFLICT DO NOTHING;

-- Leads
INSERT INTO public.leads (id, contact_id, conversation_id, status)
VALUES
  ('00000000-0000-0000-0000-000000000005'::uuid, '00000000-0000-0000-0000-000000008001'::uuid, '10000000-0000-0000-0000-000000009001'::uuid, 'novo'),
  ('00000000-0000-0000-0000-000000000007'::uuid, '00000000-0000-0000-0000-000000008003'::uuid, '10000000-0000-0000-0000-000000009003'::uuid, 'novo'),
  ('00000000-0000-0000-0000-000000000009'::uuid, '00000000-0000-0000-0000-000000008004'::uuid, '10000000-0000-0000-0000-000000009004'::uuid, 'novo')
ON CONFLICT DO NOTHING;
```

## Fixture: `IGOR_05_handoff_with_lead_callback.json`

**Cenário**: handoff after-hours completo com lead_id, callback_period, summary.

**Mutações esperadas**:
- `conversations` WHERE `chatwoot_conversation_id=9001` → `state='human_assigned'`, `ai_enabled=false`, `human_locked=true`, `assigned_team_id` populado, `updated_at=now()`.
- `leads` WHERE `id='00000000-0000-0000-0000-000000000005'` → `status='aguardando_atendente'`, `handoff_at` preenchido, `updated_at=now()`.
- `events` 1 row `handoff_complete` com `payload->>'test_run_id'='IGOR_05_FIXTURE_with_lead_callback'`, `payload->>'handoff_reason'='after_hours_callback'`, `payload->>'owner_flow'='after_hours'`, `payload->>'callback_period'='amanhã de manhã'`.
- `events` 1 row `dry_run_send` (default seguro: `ALLOW_REAL_WHATSAPP_SEND=false`).
- `events` 0 row `whatsapp_sent`.

**Chamada IGOR_04**: sub-workflow chamado com:
```json
{
  "chatwoot_conversation_id": "9001",
  "chatwoot_contact_id": "8001",
  "labels_to_add": ["handoff_done", "ai_disabled", "aguardando_atendente"],
  "labels_to_remove": ["qualificacao_rapida", "callback_solicitado"],
  "custom_attributes": {
    "conversation": {
      "automation_state": "human_assigned",
      "lead_status": "aguardando_atendente",
      "handoff_reason": "after_hours_callback",
      "handoff_at": "<ISO timestamp>",
      "callback_period": "amanhã de manhã",
      "owner_flow": "after_hours",
      "ai_enabled": false
    },
    "contact": {}
  },
  "test_run_id": "IGOR_05_FIXTURE_with_lead_callback"
}
```

**Chatwoot HTTP esperadas** (mock ou real conforme ambiente):
- `POST /api/v1/accounts/{ACCOUNT}/conversations/9001/messages` body com `private: true`, `message_type: outgoing`, `content_type: text`, `content` começando com `📋 *Resumo automático Igor (handoff after_hours)*` e contendo `Motivo: after_hours_callback`, `Período preferido de retorno: amanhã de manhã`.
- `POST /api/v1/accounts/{ACCOUNT}/conversations/9001/assignments` body `{team_id: $CHATWOOT_HUMAN_TEAM_ID}`.
- (Condicional) `POST /api/v1/accounts/{ACCOUNT}/conversations/9001/assignments` body `{assignee_id: $CHATWOOT_HUMAN_ASSIGNEE_ID}` SE env setado.

**Output final do workflow**: `{ ok: true, lead_updated: true, labels_applied: true, message_sent: 'dry', send_mode: 'dry_run', test_run_id: 'IGOR_05_FIXTURE_with_lead_callback' }`.

## Fixture: `IGOR_05_handoff_no_lead.json`

**Cenário**: handoff compliance sem lead_id (lead não existe ainda na tabela).

**Mutações esperadas**:
- `conversations` WHERE `chatwoot_conversation_id=9002` → `state='human_assigned'`, `ai_enabled=false`, `human_locked=true`.
- `leads` → **NENHUM UPDATE** (branch "Has lead_id?" → false).
- `events` 1 row `handoff_complete` com `handoff_reason='compliance_hold'`, `lead_id` ausente/null/empty.
- `events` 1 row `dry_run_send`.

**Chamada IGOR_04**: chamado COM `labels_to_add` igual, mas `custom_attributes.conversation.callback_period` ausente do payload (`callback_period` opcional). Não envia `chatwoot_contact_id` se vier null.

**Chatwoot**: private note sem linha "Período preferido de retorno" (`callback_period` ausente). Texto:
```
📋 *Resumo automático Igor (handoff after_hours)*

Motivo: compliance_hold

Resumo da conversa:
Lead enviou mensagem que disparou regra de compliance...
...
```

## Fixture: `IGOR_05_handoff_compliance_clinical.json`

**Cenário**: handoff por documento clínico sensível (compliance hard-fail no normalizer). Tem lead_id.

**Mutações esperadas**:
- `conversations` WHERE `chatwoot_conversation_id=9003` → `state='human_assigned'`.
- `leads` WHERE `id='00000000-0000-0000-0000-000000000007'` → `status='aguardando_atendente'`, `handoff_at` preenchido.
- `events` 1 row `handoff_complete` com `handoff_reason='documento_clinico_sensivel'`, `owner_flow='after_hours'`.
- `events` 1 row `dry_run_send`.

**Chamada IGOR_04**: `custom_attributes.conversation.handoff_reason='documento_clinico_sensivel'`.

**Chatwoot**: private note com Motivo `documento_clinico_sensivel`.

## Fixture: `IGOR_05_handoff_dry_run.json`

**Cenário**: gate explícito — workflow detecta `IGOR_DRY_RUN=true` ou `ALLOW_REAL_WHATSAPP_SEND=false` e desvia para `dry_run_send`.

**Mutações esperadas**:
- `conversations` WHERE `chatwoot_conversation_id=9004` → `state='human_assigned'`.
- `leads` WHERE `id='00000000-0000-0000-0000-000000000009'` → `status='aguardando_atendente'`.
- `events` 1 row `handoff_complete`.
- `events` exatamente 1 row `dry_run_send` com `payload->>'reason'` setado (ex.: `'allow_real_whatsapp_send=false'` ou `'igor_dry_run=true'`).
- `events` 0 row `whatsapp_sent`.

## Send-gate decision matrix

| ALLOW_REAL_WHATSAPP_SEND | IGOR_DRY_RUN | Resultado |
|---|---|---|
| `'true'` | `'false'` | branch real → `POST {EVOLUTION_BASE_URL}/message/sendText/{INSTANCE}` + `events('whatsapp_sent')` |
| `'true'` | `'true'` ou unset | branch dry → `events('dry_run_send', reason='igor_dry_run=true')` |
| `'false'` ou unset | qualquer | branch dry → `events('dry_run_send', reason='allow_real_whatsapp_send=false')` |
| qualquer | qualquer (env não setado) | branch dry → `events('dry_run_send')` |

**Estado atual** (Fase B): `ALLOW_REAL_WHATSAPP_SEND=false` no `.env.example` por default seguro. Asserts assumem dry path.

## Out of scope para asserts SQL

- Validação literal do template PT-BR no body da POST private note (precisa intercept HTTP — feito em smoke com Chatwoot mock).
- Validação de assignment payload (idem — depende de mock).
- Verificação do conteúdo exato passado para IGOR_04 (asserts dele cobrem isso via test_run_id em cascata).
