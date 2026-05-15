# RUNBOOK — Instituto Dr. Igor

> Última atualização: 2026-05-15. Para arquitetura completa, leia `docs/ARCHITECTURE.md`.

## Sumário

1. [Diagnóstico rápido](#diagnóstico-rápido)
2. [Pausar Igor em runtime](#pausar-igor-em-runtime)
3. [Pausar workflow específico](#pausar-workflow-específico)
4. [Habilitar / desabilitar envio real](#habilitar--desabilitar-envio-real)
5. [Configurar atendente específico (assignee_id)](#configurar-atendente-específico-assignee_id)
6. [Trocar credencial sem reimportar workflows](#trocar-credencial-sem-reimportar-workflows)
7. [Disparar smoke manual](#disparar-smoke-manual)
8. [Erro em produção — primeira checagem](#erro-em-produção--primeira-checagem)
9. [Restaurar workflow a partir do JSON canonical](#restaurar-workflow-a-partir-do-json-canonical)
10. [Tabela `settings` — chaves operacionais](#tabela-settings--chaves-operacionais)
11. [IDs n8n canônicos](#ids-n8n-canônicos)

---

## Diagnóstico rápido

### Status global do health check
```sql
SELECT payload->>'overall_status' AS status,
       payload->'counts' AS counts_24h,
       payload->'services' AS services,
       created_at
FROM events
WHERE event_type='health_check'
ORDER BY created_at DESC LIMIT 1;
```
Esperado: `overall_status='healthy'`, 5 services `status='ok'`.

### Mensagens recentes
```sql
SELECT m.created_at, m.sender_type, left(m.content, 80) AS preview,
       c.state, c.ai_enabled, c.human_locked
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.created_at > now() - interval '1 hour'
ORDER BY m.created_at DESC LIMIT 20;
```

### Erros recentes
```sql
SELECT created_at, payload->>'workflow_name' AS wf,
       payload->>'last_node' AS node,
       payload->>'error_message' AS err
FROM events
WHERE event_type='infra_error' AND created_at > now() - interval '1 hour'
ORDER BY created_at DESC LIMIT 20;
```

---

## Pausar Igor em runtime

Kill switch global — bloqueia TODAS as mensagens novas:
```sql
UPDATE public.settings SET value='false'::jsonb, updated_at=now()
WHERE key='ai_enabled_global';
```
Efeito: IGOR_01 condition 2 bloqueia, registra `events('inbound_blocked', reason='ai_disabled_global')`. Não interrompe execuções em andamento.

Retomar:
```sql
UPDATE public.settings SET value='true'::jsonb, updated_at=now()
WHERE key='ai_enabled_global';
```

---

## Pausar workflow específico

Para pausar só um workflow (sem afetar outros):
```sql
UPDATE public.settings
SET value = jsonb_set(value::jsonb, '{IGOR_01}', 'false'::jsonb),
    updated_at = now()
WHERE key='workflows_enabled';
```
Substitua `IGOR_01` por qualquer das chaves: IGOR_01..IGOR_08. Workflow respeita o gate `workflows_enabled.IGOR_XX === false` no início.

---

## Habilitar / desabilitar envio real

Default seguro: `dry_run_send=true` e `allow_real_whatsapp_send=false` → Evolution `sendText` é trocado por `events('dry_run_send')`.

Para habilitar envio real (cuidado — manda WhatsApp de verdade):
```sql
UPDATE public.settings SET value='false'::jsonb, updated_at=now() WHERE key='dry_run_send';
UPDATE public.settings SET value='true'::jsonb, updated_at=now() WHERE key='allow_real_whatsapp_send';
```

Voltar pra dry run:
```sql
UPDATE public.settings SET value='true'::jsonb, updated_at=now() WHERE key='dry_run_send';
UPDATE public.settings SET value='false'::jsonb, updated_at=now() WHERE key='allow_real_whatsapp_send';
```

Esses gates são lidos pelo node `Load Gates` no início de IGOR_03 e IGOR_05.

---

## Configurar atendente específico (assignee_id)

Por default (`null`), handoff faz apenas team assignment. Para atribuir conversa a um atendente específico no Chatwoot:
```sql
UPDATE public.settings SET value='5'::jsonb, updated_at=now()
WHERE key='chatwoot_human_assignee_id';
```
Substitua `5` pelo `user_id` do agente no Chatwoot. Para voltar a team-only:
```sql
UPDATE public.settings SET value='null'::jsonb, updated_at=now()
WHERE key='chatwoot_human_assignee_id';
```

---

## Trocar credencial sem reimportar workflows

1. UI do n8n → Credentials → encontrar pelo nome (e.g., `igor_evolution_api`).
2. Edit → atualizar valor.
3. Save.

Todos os workflows que referenciam pelo nome são automaticamente atualizados — sem re-import.

---

## Disparar smoke manual

Usar `IGOR_TEST_Smoke_Trigger` (id `G8pMteuirc2yZgq5`):

1. Configurar telefone do operador (uma vez):
   ```sql
   UPDATE public.settings SET value='"5562998621000"'::jsonb, updated_at=now()
   WHERE key='smoke_test_phone';
   ```
   Formato: `55+DDD+9digits`, sem `+` ou espaços (13 chars).

2. Abrir `IGOR_TEST_Smoke_Trigger` no n8n UI → botão **Execute Workflow**.

3. WhatsApp do operador recebe mensagem em segundos. Responder via WhatsApp dispara IGOR_01 via webhook Evolution.

---

## Erro em produção — primeira checagem

```sql
-- 1. Há erros recentes?
SELECT count(*) FROM events WHERE event_type='infra_error' AND created_at > now() - interval '15 minutes';

-- 2. Qual workflow está falhando?
SELECT payload->>'workflow_name' AS wf, count(*)
FROM events WHERE event_type='infra_error' AND created_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;

-- 3. Detalhes do último erro
SELECT payload->>'workflow_name' AS wf, payload->>'last_node' AS node,
       payload->>'error_message' AS err, created_at
FROM events WHERE event_type='infra_error'
ORDER BY created_at DESC LIMIT 5;
```

Se identificar workflow problemático, pausar via section "Pausar workflow específico" enquanto investiga.

---

## Restaurar workflow a partir do JSON canonical

JSONs em `n8n/workflows/IGOR_*.json` são source-of-truth. Para restaurar via REST:

```bash
# Usar credenciais do .claude/CREDENCIAIS.md — substituir N8N_BASE_URL e N8N_API_KEY pelos valores reais
WF_ID="nC6ZhCVNn1fQiKfB"
curl -X PUT \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  "$N8N_BASE_URL/api/v1/workflows/$WF_ID" \
  --data-binary @n8n/workflows/IGOR_01_Inbound_AfterHours.json
```

Ou via MCP (preferido): `mcp__n8n-mcp__update_workflow` com SDK code.

---

## Tabela `settings` — chaves operacionais

```sql
SELECT key, value FROM public.settings ORDER BY key;
```

| Key | Tipo | Default | Uso |
|-----|------|---------|-----|
| `ai_enabled_global` | bool | true | kill switch global (IGOR_01 cond 2) |
| `workflows_enabled` | jsonb obj | IGOR_01-08 true | flag por workflow (IGOR_01 cond 3) |
| `after_hours_start` / `_end` | string `HH:MM` | "18:30" / "07:30" | janela horária (IGOR_01 cond 8) |
| `timezone` | string IANA | "America/Sao_Paulo" | timezone do check de horário |
| `holidays` | jsonb array `YYYY-MM-DD` | `[]` | feriados (IGOR_01 cond 9) |
| `holiday_policy` | enum | `after_hours_force` | comportamento em feriado |
| `dry_run_send` | bool | true | bloqueia Evolution sendText (IGOR_03/05) |
| `allow_real_whatsapp_send` | bool | false | toggle prod/test send |
| `chatwoot_human_assignee_id` | int OR null | null | atendente específico (null = team-only — IGOR_05) |
| `human_team_id` | int | 1 | team Chatwoot p/ handoff |
| `human_inbox_id` | int | 1 | inbox Chatwoot principal |
| `human_inbox_identifier` | string | "vRrf8MeDTe9DsH11RB3ZRCug" | identifier API channel |
| `smoke_test_phone` | string OR null | null | telefone do operador p/ IGOR_TEST_Smoke_Trigger |
| `smoke_test_message` | string | (texto default) | mensagem do smoke |
| `do_not_contact_keywords` | jsonb array | (lista PT-BR) | palavras opt-out (futuro) |
| `campaign_optout_threshold` | jsonb obj | `{window_size:20, max_optouts:3}` | auto-pausa campanha |

---

## IDs n8n canônicos

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
| IGOR_TEST_Smoke_Trigger | `G8pMteuirc2yZgq5` |

### Credenciais n8n por nome
| Nome | ID | Tipo |
|------|-----|------|
| `igor_chatwoot_api` | `x8StLhAFnYjQxUFg` | httpHeaderAuth (`api_access_token`) |
| `igor_evolution_api` | `DDhbwLsNclqTA18X` | httpHeaderAuth (`apikey`) |
| `igor_openai` | `LlVkZBRsy5tm6FjJ` | openAiApi (Bearer) |
| `igor_supabase_postgres` | `Z7DeBop4nK4JlIXO` | postgres (session pooler) |
| `igor_redis_embedded` | `ayVMY7Njm6ecLLuc` | redis (local) |
