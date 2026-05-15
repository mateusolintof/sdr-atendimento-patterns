# RUNBOOK — Instituto Dr. Igor

> Última atualização: 2026-05-15 (pós Fase B + Fase C reviews).

## Sumário

1. [Fase C — Smoke Tests (next step para você)](#fase-c--smoke-tests)
2. [Diagnóstico rápido](#diagnóstico-rápido)
3. [Pausar Igor em runtime](#pausar-igor-em-runtime)
4. [Pausar workflow específico](#pausar-workflow-específico)
5. [Trocar credencial sem reimportar workflows](#trocar-credencial-sem-reimportar-workflows)
6. [Reprocessar mensagem perdida](#reprocessar-mensagem-perdida)
7. [Conta sob ataque / opt-out em massa](#conta-sob-ataque--opt-out-em-massa)
8. [Restaurar backup de workflows](#restaurar-backup-de-workflows)

---

## Fase C — Smoke Tests

### Pré-requisitos OBRIGATÓRIOS (user-side)

Antes de rodar smoke tests, complete na ordem:

#### 1. Aplicar migration 008 no Supabase
- Abra Supabase SQL Editor.
- Cole o conteúdo de `supabase/migrations/008_messages_msgid_unique.sql`.
- Execute. Idempotente (`CREATE UNIQUE INDEX IF NOT EXISTS`).
- Verificar: `\d messages` deve mostrar `uq_messages_msgid_partial` como partial UNIQUE.

#### 2. Criar credencial `igor_evolution_api` no n8n
- UI n8n → Credentials → New → `HTTP Header Auth`.
- Nome: `igor_evolution_api`.
- Header: `apikey`.
- Value: o valor de `EVOLUTION_API_KEY` do `.env` (NÃO exponha no commit history).
- Save.

#### 3. Confirmar/wire credentials nos HTTP nodes
Verificar em cada workflow que os HTTP nodes têm a credencial correta selecionada:

| Workflow | HTTP Node | Credencial esperada |
|----------|-----------|---------------------|
| IGOR_04 | GET Current Labels | `igor_chatwoot_api` (httpHeaderAuth header `api_access_token`) |
| IGOR_04 | POST Merged Labels | `igor_chatwoot_api` |
| IGOR_04 | POST Conversation Attrs | `igor_chatwoot_api` |
| IGOR_04 | PUT Contact Attrs | `igor_chatwoot_api` |
| IGOR_05 | Private Note | `igor_chatwoot_api` |
| IGOR_05 | Assign Team | `igor_chatwoot_api` |
| IGOR_05 | Assign Assignee | `igor_chatwoot_api` |
| IGOR_05 | Evolution sendText | `igor_evolution_api` (header `apikey`) |
| IGOR_06 | (sem HTTP externo — só postgres + executeWorkflow) | — |
| IGOR_08 | Chatwoot Ping | `igor_chatwoot_api` |
| IGOR_08 | Evolution Ping | `igor_evolution_api` (criar antes) |
| IGOR_08 | OpenAI Ping | `igor_openai` (já wired) |
| IGOR_02 | Audio Fetch URL | (nenhuma — URL pública) |
| IGOR_02 | Audio Transcribe | `igor_openai` (já wired) |
| IGOR_02 | Image Vision | `igor_openai` (já wired) |
| IGOR_02 | Image Fetch URL | (nenhuma — URL pública) |
| IGOR_03 | Presence Composing | `igor_evolution_api` |
| IGOR_03 | Send WhatsApp | `igor_evolution_api` |

#### 4. Confirmar settings em Supabase
```sql
-- Verifique se settings existem
SELECT key, value FROM settings WHERE key IN (
  'ai_enabled_global',
  'workflows_enabled',
  'holidays',
  'holiday_policy',
  'after_hours_start',
  'after_hours_end',
  'timezone'
);

-- Se faltar algum, inserir:
INSERT INTO settings (key, value) VALUES
  ('ai_enabled_global', 'true'),
  ('workflows_enabled', '{"IGOR_01":true,"IGOR_02":true,"IGOR_03":true,"IGOR_04":true,"IGOR_05":true,"IGOR_06":true,"IGOR_08":true}'),
  ('holidays', '[]'),
  ('holiday_policy', 'after_hours_force'),
  ('after_hours_start', '18:30'),
  ('after_hours_end', '07:30'),
  ('timezone', 'America/Sao_Paulo')
ON CONFLICT (key) DO NOTHING;
```

#### 5. Confirmar env vars no container n8n
Acesse o container n8n e confirme:
- `CHATWOOT_BASE_URL`
- `CHATWOOT_ACCOUNT_ID`
- `EVOLUTION_BASE_URL`
- `EVOLUTION_INSTANCE_NAME`
- `N8N_BASE_URL`
- `IGOR_DRY_RUN` (default `true` para smoke)
- `ALLOW_REAL_WHATSAPP_SEND` (default `false` para smoke)

### Executar 10 smoke tests obrigatórios

Os 10 smoke tests do `IMPLEMENTATION_PLAN.md §10` cobrem:

| # | Cenário | Fixture | Workflow alvo | Asserts |
|---|---------|---------|---------------|---------|
| 1 | texto fora expediente (happy path) | `fixtures/IGOR_01_text_afterhours.json` | IGOR_01 | events('inbound_routed_to_IGOR_03'), conversations.state='ai_after_hours' |
| 2 | áudio fora expediente | `fixtures/IGOR_01_audio_afterhours.json` | IGOR_01 → IGOR_02 → IGOR_03 | events('media_normalized'), messages.transcript não-vazio |
| 3 | imagem com caption | `fixtures/IGOR_02_image_with_caption.json` | IGOR_02 | branch image_with_caption, normalized_text=caption |
| 4 | documento clínico | `fixtures/IGOR_02_document_clinical.json` | IGOR_02 → IGOR_05 (compliance) | safety_flags.clinical=true, should_handoff=true, events('handoff_complete') |
| 5 | fromMe | `fixtures/IGOR_01_fromme.json` | IGOR_01 | events('inbound_blocked', reason='fromMe'), zero downstream |
| 6 | opt-out | `fixtures/IGOR_01_optout.json` (pré-seed contacts.do_not_contact=true) | IGOR_01 → IGOR_04 | events('inbound_blocked', reason='opt_out'), label `optout` |
| 7 | human takeover | `fixtures/IGOR_06_message_created_outgoing_human.json` | IGOR_06 → IGOR_04 | conversations.human_locked=true, label `atendimento_humano`, events('human_assumed') |
| 8 | handoff completo | `fixtures/IGOR_05_handoff_with_lead_callback.json` | IGOR_05 → IGOR_04 | leads.status='aguardando_atendente', labels handoff_done/ai_disabled, events('handoff_complete') |
| 9 | dry_run send | `fixtures/IGOR_05_handoff_dry_run.json` (env IGOR_DRY_RUN=true) | IGOR_05 | events('dry_run_send') em vez de Evolution call |
| 10 | batch lock held | 2x `fixtures/IGOR_01_batch_lock_held.json` em sequência rápida | IGOR_01 | primeira passa, segunda → events('inbound_batched', reason='lock_held') |

### Executar smoke via n8n MCP

Para cada fixture:

```bash
# Carregar fixture
FIXTURE=$(cat fixtures/IGOR_01_text_afterhours.json)

# Executar workflow (use n8n MCP `execute_workflow` ou REST API direta)
# Via REST:
set -a; source .env; set +a
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
  "$N8N_BASE_URL/api/v1/workflows/<WORKFLOW_ID>/execute" \
  -d "{\"workflowData\": $FIXTURE}"

# Aguardar execução (verificar status via GET /executions/{id})

# Rodar asserts
psql $POSTGRES_URL -f tests/asserts-IGOR_01_Inbound_AfterHours.sql
```

### Critério de aprovação

- Todos os 10 smoke tests passam asserts.
- Zero erros no IGOR_07_Error_Logger.
- Health check (IGOR_08) reporta `overall_status='healthy'` após bateria.
- Nenhuma mensagem real enviada por WhatsApp (`ALLOW_REAL_WHATSAPP_SEND=false`).

### Ativação produção

Após smoke 100% green:

1. Mude ENV: `IGOR_DRY_RUN=false`, `ALLOW_REAL_WHATSAPP_SEND=true`.
2. Crie credencial Evolution se ainda não criada.
3. Configure número de teste autorizado no `.env` (`EVOLUTION_TEST_NUMBER`).
4. Active workflows na ordem:
   - IGOR_07 (já ativo).
   - IGOR_08 (cron health).
   - IGOR_04, IGOR_02 (callables wave 1).
   - IGOR_06, IGOR_05 (wave 2).
   - IGOR_03 (wave 4 — agent).
   - IGOR_01 (webhook inbound — último, pois ele dispara o pipeline inteiro).
5. Aponte webhook Evolution para `/webhook/igor/inbound`.
6. Aponte webhook Chatwoot para `/webhook/igor/chatwoot`.
7. Monitore IGOR_08 events('health_check') por 1h.
8. Envie mensagem de teste do número autorizado para validar end-to-end.

---

## Diagnóstico rápido

### Status global
```sql
SELECT * FROM events
WHERE event_type='health_check'
ORDER BY created_at DESC LIMIT 1;
```

Resultado esperado: `overall_status='healthy'`, `services` com 5 itens `status='ok'`.

### Mensagens recentes
```sql
SELECT m.created_at, m.role, m.sender_type, left(m.content, 80) as content_preview,
       c.state, c.ai_enabled, c.human_locked
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.created_at > now() - interval '1 hour'
ORDER BY m.created_at DESC LIMIT 20;
```

### Erros recentes
```sql
SELECT created_at, payload->>'workflow_name' as wf, payload->>'last_node' as node,
       payload->>'error_message' as err
FROM events
WHERE event_type='infra_error' AND created_at > now() - interval '1 hour'
ORDER BY created_at DESC LIMIT 20;
```

---

## Pausar Igor em runtime

```sql
UPDATE settings SET value='false' WHERE key='ai_enabled_global';
```

Efeito: IGOR_01 condition 2 bloqueia todas as mensagens novas (events('inbound_blocked', reason='ai_disabled_global')). Não interrompe execuções em andamento.

Retomar:
```sql
UPDATE settings SET value='true' WHERE key='ai_enabled_global';
```

---

## Pausar workflow específico

```sql
UPDATE settings
SET value = jsonb_set(value::jsonb, '{IGOR_01}', 'false'::jsonb)
WHERE key='workflows_enabled';
```

Substitua `IGOR_01` pelo workflow alvo. Efeito: workflow respeita o gate `workflows_enabled.IGOR_XX === false`.

---

## Trocar credencial sem reimportar workflows

1. UI n8n → Credentials → encontrar credencial pelo nome (e.g., `igor_evolution_api`).
2. Edit → atualizar valor.
3. Save.

Todos os workflows que referenciam pelo nome são automaticamente atualizados (resolução por nome no momento da execução).

---

## Reprocessar mensagem perdida

Se uma mensagem chegou mas não foi processada (e.g., n8n estava down):

1. Capture o payload Evolution do log Chatwoot.
2. Use `curl -X POST $N8N_BASE_URL/webhook/igor/inbound -d @payload.json`.

---

## Conta sob ataque / opt-out em massa

```sql
-- Pausar global
UPDATE settings SET value='false' WHERE key='ai_enabled_global';

-- Marcar contas suspeitas
UPDATE contacts SET do_not_contact=true
WHERE phone IN (SELECT phone FROM contacts_under_attack);

-- Verificar atacks recent
SELECT count(*) FROM events
WHERE event_type='opt_out' AND created_at > now() - interval '1 hour';
```

---

## Restaurar backup de workflows

JSONs canonical em `n8n/workflows/IGOR_*.json` são source-of-truth. Para restaurar:

```bash
set -a; source .env; set +a
for f in n8n/workflows/IGOR_*.json; do
  ID=$(jq -r .id "$f")
  curl -X PUT -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
    "$N8N_BASE_URL/api/v1/workflows/$ID" --data-binary "@$f"
done
```

---

## Workflow IDs canônicos (atual)

| Workflow | n8n ID |
|----------|--------|
| IGOR_01_Inbound_AfterHours | `nC6ZhCVNn1fQiKfB` |
| IGOR_02_Media_Normalizer | `GBmG9WZzW2p8Nn6f` |
| IGOR_03_Agent_AfterHours | `iQCVbe1P8dC0vhay` |
| IGOR_04_Tool_Labels_Attributes | `AJF7dhGrqJEXMLqz` |
| IGOR_05_Finalize_Handoff | `N31QcdrNVE5AOZdu` |
| IGOR_06_Chatwoot_Message_Logger | `xpXRENR7Hoo2W5p3` |
| IGOR_07_Error_Logger | `ZrsbaSTlW5bqMEaS` |
| IGOR_08_Health_Check | `cDpDA1QdIH9wHAlN` |
| IGOR_AUX_save_lead_partial | `hRogDlGsgQxGwnD8` |
| IGOR_AUX_update_conversation_state | `mFuRPrGGt7yWVqEw` |
