# RUNBOOK — Instituto Dr. Igor

> Última atualização: 2026-05-20. Para arquitetura completa, leia `docs/ARCHITECTURE.md`.

## Sumário

1. [Diagnóstico rápido](#diagnóstico-rápido)
2. [Pausar Igor em runtime](#pausar-igor-em-runtime)
3. [Pausar workflow específico](#pausar-workflow-específico)
4. [Configurar atendente específica (assignee_id)](#configurar-atendente-específica-assignee_id)
5. [Trocar credencial sem reimportar workflows](#trocar-credencial-sem-reimportar-workflows)
6. [Erro em produção — primeira checagem](#erro-em-produção--primeira-checagem)
7. [Reativar / pausar workflows via API n8n](#reativar--pausar-workflows-via-api-n8n)
8. [Comutar instância Evolution (teste ↔ produção)](#comutar-instância-evolution-teste--produção)
9. [Tabela `settings` — chaves operacionais](#tabela-settings--chaves-operacionais)
10. [IDs n8n canônicos](#ids-n8n-canônicos)
11. [Resposta a incident "Alice respondeu erroneamente"](#resposta-a-incident-alice-respondeu-erroneamente)

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
SELECT m.created_at, m.role, m.direction, left(m.text, 80) AS preview,
       c.state, c.owner_flow, c.ai_enabled, c.human_locked
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
Efeito: `Compute Gates` em `IGOR_Inbound` retorna `block_reason='ai_disabled_global'`, registra `events('inbound_blocked')`. Não interrompe execuções em andamento.

Retomar:
```sql
UPDATE public.settings SET value='true'::jsonb, updated_at=now()
WHERE key='ai_enabled_global';
```

---

## Pausar workflow específico

Para pausar só um workflow (sem afetar outros) via flag em `settings.workflows_enabled`:
```sql
UPDATE public.settings
SET value = jsonb_set(value::jsonb, '{IGOR_Inbound}', 'false'::jsonb),
    updated_at = now()
WHERE key='workflows_enabled';
```
Chaves válidas: `IGOR_Inbound`, `IGOR_Campaign_Sender`. (Os demais — IGOR_Handoff/IGOR_Chatwoot_Logger/IGOR_04/IGOR_07/IGOR_08 — são callables ou helpers sem gate próprio.)

Para pausar via **publish flag** do próprio n8n (mais agressivo — desativa o trigger inteiro):
```bash
# Via MCP
mcp__n8n-mcp__unpublish_workflow workflowId=<ID>
# Via REST
curl -X POST "$N8N_BASE_URL/api/v1/workflows/$WF_ID/deactivate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Para a campanha promo, pausar via `campaign_runs.status`:
```sql
UPDATE public.campaign_runs SET status='pausado', updated_at=now()
WHERE id='00000000-0000-0000-0000-000000000001';
```
`IGOR_Campaign_Sender` lê `campaign_runs.status='ativo'` no `Load Campaign State`. Sem campanha ativa → `Compute Gates` retorna `skip_reason='no_active_campaign'`.

---

## Configurar atendente específica (assignee_id)

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

Todos os workflows que referenciam pelo nome são automaticamente atualizados — sem re-import. ESSA é a principal vantagem de credenciais pelo nome em vez de variáveis de ambiente.

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

## Reativar / pausar workflows via API n8n

Via MCP (preferido):
```
mcp__n8n-mcp__publish_workflow   workflowId=6hXJpXn139z6WCYW   # IGOR_Inbound
mcp__n8n-mcp__unpublish_workflow workflowId=6hXJpXn139z6WCYW
```

Via REST direto (use API key do `.claude/CREDENCIAIS.md` — variável `N8N_API_KEY`):
```bash
curl -X POST "$N8N_BASE_URL/api/v1/workflows/$WF_ID/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
curl -X POST "$N8N_BASE_URL/api/v1/workflows/$WF_ID/deactivate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

---

## Comutar instância Evolution (teste ↔ produção)

⚠️ **Regra crítica pós-incident 2026-05-18**: nunca habilitar webhook em **ambas** as instâncias simultaneamente. O `IGOR_Inbound` aceita qualquer payload válido, então 2 webhooks ativos = mensagens reais de produção podem disparar Alice durante teste.

Para **migrar para teste** (convert-teste):
```bash
# 1. Desabilitar webhook + chatwoot na instância de produção
curl -X POST "https://evo.almaconvert.com.br/webhook/set/dr.igor" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  --data '{"webhook":{"enabled":false,"url":"https://n8n.almaconvert.com.br/webhook/igor/inbound","headers":{},"byEvents":false,"base64":true,"events":["MESSAGES_UPSERT"]}}'

# 2. Habilitar webhook na instância de teste
curl -X POST "https://evo.almaconvert.com.br/webhook/set/convert-teste" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  --data '{"webhook":{"enabled":true,"url":"https://n8n.almaconvert.com.br/webhook/igor/inbound","headers":{},"byEvents":false,"base64":true,"events":["MESSAGES_UPSERT"]}}'

# 3. Habilitar Chatwoot integration na convert-teste (mesma config da prod)
curl -X POST "https://evo.almaconvert.com.br/chatwoot/set/convert-teste" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  --data '{"enabled":true,"accountId":"2","token":"<CHATWOOT_API_TOKEN>","url":"https://chat.almaconvert.com.br","nameInbox":"Igor After Hours","signMsg":false,"reopenConversation":true,"conversationPending":false,"mergeBrazilContacts":false,"importContacts":false,"importMessages":false,"autoCreate":true,"organization":"Instituto Dr. Igor (Teste)"}'
```

URLs no `Send WhatsApp` + `Presence Composing` do `IGOR_Inbound` usam **expressão dinâmica** `={{ $('Extrair Campos').first().json.instance }}` — funcionam pra qualquer instância sem patch.

Para **voltar pra produção** (dr.igor): inverter os comandos.

---

## Tabela `settings` — chaves operacionais

```sql
SELECT key, value FROM public.settings ORDER BY key;
```

| Key | Tipo | Default | Uso |
|-----|------|---------|-----|
| `ai_enabled_global` | bool | true | kill switch global (`Compute Gates`) |
| `workflows_enabled` | jsonb obj | `IGOR_Inbound:true, IGOR_Campaign_Sender:true` | flag por workflow |
| `after_hours_start` / `_end` | string `HH:MM` | "18:30" / "07:30" | janela horária do receptivo |
| `timezone` | string IANA | "America/Sao_Paulo" | timezone do check de horário |
| `holidays` | jsonb array `YYYY-MM-DD` | `[]` | feriados |
| `holiday_policy` | enum | `after_hours_force` | em feriado IA atua o dia todo |
| `chatwoot_human_assignee_id` | int OR null | null | atendente específica (null = team-only) |
| `ai_team_id` | int | 3 | team "ia após-expediente" |
| `human_daytime_team_id` | int | 1 | team "atendimento humano" |
| `handoff_queue_team_id` | int | 4 | team "aguardando retorno" (pós-handoff Alice) |
| `promo_team_id` | int | 5 | team "promoção maio 2026" |
| `max_alice_turns` | int | 6 | turnos máximos da Alice antes de forçar handoff |
| `do_not_contact_keywords` | jsonb array | (lista PT-BR) | palavras opt-out |
| `campaign_optout_threshold` | jsonb obj | `{window_size:20, max_optouts:3}` | auto-pausa campanha |
| `human_inbox_id` | int | 1 | inbox Chatwoot único |
| `human_inbox_identifier` | string | "vRrf8MeDTe9DsH11RB3ZRCug" | identifier API channel |

> **NÃO use mais** (removidos do schema vigente): `dry_run_send`, `allow_real_whatsapp_send`, `smoke_test_phone`, `smoke_test_message`, `human_team_id`, `after_hours_window`. Caso encontre referências em código antigo, remova.

---

## IDs n8n canônicos

| Workflow | n8n ID | Ativo |
|----------|--------|-------|
| `IGOR_Inbound` | `6hXJpXn139z6WCYW` | controlado por publish flag |
| `IGOR_Handoff` | `mfB7MGpCYSPQvRSx` | controlado por publish flag |
| `IGOR_Chatwoot_Logger` | `xpXRENR7Hoo2W5p3` | controlado por publish flag |
| `IGOR_Campaign_Sender` | `4NzqtCS3ZGrwSVnB` | controlado por publish flag + `campaign_runs.status` |
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | sempre ativo (callable) |
| `IGOR_07_Error_Logger` | `ZrsbaSTlW5bqMEaS` | sempre ativo (errorTrigger) |
| `IGOR_08_Health_Check` | `cDpDA1QdIH9wHAlN` | sempre ativo (schedule `*/10`) |
| `IGOR_TEST_Smoke_Trigger` | `G8pMteuirc2yZgq5` | desativado por default — só ligar quando vai fazer smoke |
| `IGOR_TEST_Failing_Workflow` | `m6QeFfLQRa94G5PJ` | fixture do IGOR_07 |
| `IGOR_TEST_Trampoline` | `enmJo4zpLEvvfuOH` | fixture do IGOR_07 |

### Credenciais n8n por nome
| Nome | ID | Tipo | Header / Conn |
|------|-----|------|---------------|
| `igor_chatwoot_api` | `x8StLhAFnYjQxUFg` | httpHeaderAuth | `api_access_token` |
| `igor_evolution_api` | `DDhbwLsNclqTA18X` | httpHeaderAuth | `apikey` |
| `igor_openai` | (auto) | openAiApi | Bearer |
| `igor_supabase_postgres` | `Z7DeBop4nK4JlIXO` | postgres | session pooler |
| `igor_redis_embedded` | `ayVMY7Njm6ecLLuc` | redis | local |

### Teams Chatwoot (account 2)
| ID | Nome | Quando recebe conversa |
|---|---|---|
| 1 | atendimento humano | Movido pelo `IGOR_Inbound` quando dentro do expediente OU jornada já iniciada OU `IGOR_Chatwoot_Logger` detecta humano respondendo |
| 3 | ia após-expediente | Atribuído pelo `IGOR_Inbound` quando Alice vai assumir lead novo fora do expediente |
| 4 | aguardando retorno | Atribuído pelo `IGOR_Handoff` quando Alice completa qualificação (qualified OU unqualified) |
| 5 | promoção maio 2026 | Atribuído pelo `IGOR_Campaign_Sender` ~3-5s após cada envio |

---

## Resposta a incident "Alice respondeu erroneamente"

Em 2026-05-18 ocorreu incident onde Alice respondeu mensagens de pacientes existentes (não-leads-novos) porque o webhook estava ativo nas 2 instâncias simultaneamente, e o gate `journey_started_at IS NULL` retornava `true` pra pacientes que nunca tinham passado pelo IGOR_Inbound antes.

**Procedimento de contenção** (10 segundos):
```bash
# 1. Pausar TODOS workflows com webhook
mcp__n8n-mcp__unpublish_workflow workflowId=6hXJpXn139z6WCYW  # IGOR_Inbound
mcp__n8n-mcp__unpublish_workflow workflowId=mfB7MGpCYSPQvRSx  # IGOR_Handoff
mcp__n8n-mcp__unpublish_workflow workflowId=xpXRENR7Hoo2W5p3  # IGOR_Chatwoot_Logger
mcp__n8n-mcp__unpublish_workflow workflowId=4NzqtCS3ZGrwSVnB  # IGOR_Campaign_Sender

# 2. Desabilitar webhooks nas duas instâncias Evolution
curl -X POST "https://evo.almaconvert.com.br/webhook/set/dr.igor" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  --data '{"webhook":{"enabled":false,...}}'
curl -X POST "https://evo.almaconvert.com.br/webhook/set/convert-teste" \
  -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  --data '{"webhook":{"enabled":false,...}}'
```

**Identificar conversas afetadas**:
```sql
SELECT m.conversation_id, c.contact_id, ct.name, ct.phone, m.text, m.created_at
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
JOIN contacts ct ON ct.id = c.contact_id
WHERE m.role='assistant' AND m.direction='outbound'
  AND m.created_at > now() - interval '1 hour'
ORDER BY m.created_at DESC;
```

**Conter conversas afetadas** (impede Alice de tocar de novo):
```sql
-- Marca conversation como human_daytime
UPDATE public.conversations
SET owner_flow='human_daytime', ai_enabled=false, human_locked=true, updated_at=now()
WHERE id IN (<lista_conv_ids>);

-- Aplicar label permanente no Chatwoot (via API): ai_disabled
```

Causa raiz e plano de correção (defesa em profundidade) — ver seção "Lições do incident 2026-05-18" em `../tasks.md`.
