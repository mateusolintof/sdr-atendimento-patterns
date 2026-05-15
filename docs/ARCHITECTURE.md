# ARCHITECTURE — Instituto Dr. Igor (Source of Truth)

> Este arquivo é a **fonte de verdade arquitetural** do projeto Igor. Agentes revisores e novos agentes devem ler ESTE arquivo primeiro antes de tocar em código ou workflows. Discrepâncias entre código atual e este documento → corrigir o código (não o doc), ou abrir débito explícito em `docs/superpowers/debt/`.

> Versão: 2026-05-15 (pós Fase B + Fase C wiring).

---

## 1. Topologia de serviços

```
WhatsApp (lead/atendente)
    ↕
Evolution API (Portainer / VPS)
    ├─ instance: convert-teste (testes) OU dr.igor (prod)
    ├─ webhook MESSAGES_UPSERT → n8n /webhook/igor/inbound
    └─ Chatwoot Integration nativa → cria/atualiza conv+contact em Chatwoot
        e injeta chatwootConversationId + chatwootInboxId no webhook
    ↕
Chatwoot self-hosted (Portainer / VPS)
    ├─ Inbox "Igor After Hours" (id=1, Channel::Api, identifier=vRrf8MeDTe9DsH11RB3ZRCug)
    ├─ Account ID: 2
    ├─ Webhook do inbox → n8n /webhook/igor/chatwoot (eventos message_created)
    ├─ Team "Atendimento Humano" (id=1)
    └─ Custom attributes + labels (34 labels + 15 attrs já seeded)
    ↕
n8n self-hosted (Portainer / VPS, https://n8n.almaconvert.com.br)
    ├─ 7 workflows IGOR_* + 1 IGOR_07 + 2 IGOR_AUX_* + 2 IGOR_TEST_*
    ├─ Webhook /igor/inbound → IGOR_01 (router 12 condições)
    ├─ Webhook /igor/chatwoot → IGOR_06 (logger + human takeover)
    └─ Schedule */10min → IGOR_08 (health check)
    ↕
Supabase Cloud (PostgREST + SQL Editor manual para migrations)
    ├─ Tabelas: contacts, conversations, leads, messages, events, settings,
    │           conversation_summaries, campaign_runs, campaign_contacts,
    │           assignments
    └─ 9 migrations aplicadas (001-009)
Redis embedded em n8n (credencial igor_redis_embedded)
    └─ chaves: igor:lock:inbound:{phone}, igor:batch:{phone}, igor:batch:marker:{phone}
OpenAI (api.openai.com)
    ├─ gpt-5.4-mini (Alice agent — IGOR_03)
    ├─ gpt-4o-transcribe (audio — IGOR_02)
    └─ gpt-4o-mini (vision — IGOR_02)
```

## 2. Fluxo end-to-end (happy path receptivo fora-expediente)

```
1. Lead manda WhatsApp para número do convert-teste
2. Evolution recebe → cria/atualiza conv em Chatwoot via integração nativa
3. Evolution dispara webhook MESSAGES_UPSERT → /webhook/igor/inbound (com chatwootConversationId já populado)
4. IGOR_01 executa 12 condições determinísticas em ordem:
   ├─ fromMe? → block
   ├─ ai_enabled_global=false? → block (settings)
   ├─ workflows_enabled.IGOR_01=false? → block (settings)
   ├─ phone inválido? → block + events('invalid_phone')
   ├─ contact.do_not_contact=true? → block + chama IGOR_04 (label optout)
   ├─ conversation.human_locked OR NOT ai_enabled? → block
   ├─ campaign_contacts ativo? → log placeholder IGOR_12 (não existe ainda)
   ├─ inside business hours? → block (settings.after_hours_start/end/timezone)
   ├─ holiday? → apply holiday_policy=after_hours_force
   ├─ Redis lock SET NX EX 30 → conflict: batch fragment + return
   ├─ messageType≠text? → executeWorkflow IGOR_02 (mídia)
   └─ executeWorkflow IGOR_03 (agente Alice)
5. IGOR_03 (Alice):
   ├─ compliance fast-path (should_handoff||safety_flags) → IGOR_05 direto
   └─ langchain.agent → tools (IGOR_04, AUX_save_lead, AUX_update_conv, IGOR_05)
   └─ Reply path: Format → SplitOut → SplitInBatches → Presence → SendGate → Wait → Log
6. Send gate: IF settings gate aberto → Evolution sendText; ELSE events('dry_run_send')
7. Evolution Chatwoot Integration espelha resposta IA no Chatwoot (sender_type=agent_bot)
8. Atendente humana vê tudo no painel Chatwoot
9. Quando atendente responder via Chatwoot UI:
   ├─ Chatwoot dispara webhook message_created → /webhook/igor/chatwoot
   ├─ IGOR_06 detecta outgoing+user → UPDATE conversation.human_locked=true
   └─ Chama IGOR_04 label atendimento_humano
10. IA para de responder (IGOR_01 condition 6 bloqueia em próxima inbound)
```

## 3. Inventário de workflows + n8n IDs

### Receptivo fora-expediente (Fase B done)

| Workflow | n8n ID | Trigger | Nodes | Status |
|----------|--------|---------|-------|--------|
| `IGOR_01_Inbound_AfterHours` | `nC6ZhCVNn1fQiKfB` | webhook `/igor/inbound` | 59 | inactive |
| `IGOR_02_Media_Normalizer` | `GBmG9WZzW2p8Nn6f` | callable | 27 | inactive |
| `IGOR_03_Agent_AfterHours` | `iQCVbe1P8dC0vhay` | callable | 26 | inactive |
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | callable | 21 | inactive |
| `IGOR_05_Finalize_Handoff` | `N31QcdrNVE5AOZdu` | callable | 24 | inactive |
| `IGOR_06_Chatwoot_Message_Logger` | `xpXRENR7Hoo2W5p3` | webhook `/igor/chatwoot` | 17 | inactive |
| `IGOR_07_Error_Logger` | `ZrsbaSTlW5bqMEaS` | errorTrigger | (preserved) | active |
| `IGOR_08_Health_Check` | `cDpDA1QdIH9wHAlN` | cron `*/10 * * * *` | 21 | inactive |
| `IGOR_AUX_save_lead_partial` | `hRogDlGsgQxGwnD8` | callable | (preserved) | active |
| `IGOR_AUX_update_conversation_state` | `mFuRPrGGt7yWVqEw` | callable | (preserved) | active |

### Campanha ativa (não implementado — Fase D futura)
IGOR_09, IGOR_10, IGOR_11, IGOR_12, IGOR_13 — ver `docs/IMPLEMENTATION_PLAN.md §2`.

## 4. Credenciais canônicas

**TODAS criadas via UI n8n** (Credentials → Add Credential). Workflows referenciam por NOME (n8n liga automaticamente).

| Nome canônico | Tipo n8n | Header / Conn | Uso |
|---------------|----------|---------------|-----|
| `igor_chatwoot_api` | httpHeaderAuth | header `api_access_token` | Chatwoot REST (IGOR_04/05/06/08) |
| `igor_evolution_api` | httpHeaderAuth | header `apikey` | Evolution sendText/presence/ping (IGOR_03/05/08) |
| `igor_openai` | openAiApi | Bearer | OpenAI (IGOR_02/03/08) |
| `igor_supabase_postgres` | postgres | conn string | Supabase Postgres (todos) |
| `igor_redis_embedded` | redis | local | Redis lock/batch (IGOR_01/08) |

## 5. Configuração externa — onde os valores ficam

| Tipo de valor | Onde fica | Como workflow lê |
|---------------|-----------|------------------|
| **Credentials** (API keys, tokens) | UI n8n → Credentials | referência por nome no node |
| **URLs / IDs / instance names** | HARDCODED no JSON do workflow | parameter literal |
| **Gates operacionais** (DRY_RUN, ALLOW_REAL_WHATSAPP_SEND) | `settings` table no Supabase | Postgres node "Load Gates" no início → $node['Load Gates'].first().json.X |
| **Settings de negócio** (business hours, holidays, workflows_enabled) | `settings` table | Postgres SELECT (IGOR_01 já faz) |
| **Secrets em código** | NUNCA | inválido |

### ⚠️ PROIBIDO: `$env.X` em qualquer node

`.env` do repositório é **apenas referência visual** para o agente — NÃO é importado nos containers. Container n8n bloqueia `$env` access via `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (default). Em runtime aparece `[ERROR: access to env vars denied]` → workflow falha.

n8n Variables `$vars.X` também NÃO disponível (Enterprise-only em self-hosted).

### Valores canônicos (para hardcode em workflows)

| Variável (era $env.X) | Valor hardcode |
|-----------------------|----------------|
| `CHATWOOT_BASE_URL` | `https://chat.almaconvert.com.br` |
| `CHATWOOT_ACCOUNT_ID` | `2` |
| `CHATWOOT_INBOX_ID` | `1` |
| `CHATWOOT_INBOX_IDENTIFIER` | `vRrf8MeDTe9DsH11RB3ZRCug` |
| `CHATWOOT_HUMAN_TEAM_ID` | (consulte .env — 1) |
| `CHATWOOT_HUMAN_ASSIGNEE_ID` | (consulte .env — 1) |
| `EVOLUTION_BASE_URL` | `https://evo.almaconvert.com.br` |
| `EVOLUTION_INSTANCE_NAME` | `convert-teste` (test) ou `dr.igor` (prod) |
| `N8N_BASE_URL` | `https://n8n.almaconvert.com.br` |

## 6. Tabela `settings` (Supabase) — chaves operacionais

Aplicada via migrations 003 + 009 (ambas idempotentes).

| key | tipo value | uso |
|-----|------------|-----|
| `ai_enabled_global` | bool | kill switch global (IGOR_01 cond 2) |
| `workflows_enabled` | jsonb obj | flag por workflow IGOR_XX (IGOR_01 cond 3) |
| `after_hours_start` | string `"HH:MM"` | janela após-expediente (IGOR_01 cond 8) |
| `after_hours_end` | string `"HH:MM"` | janela após-expediente (IGOR_01 cond 8) |
| `timezone` | string IANA | timezone para business hours (IGOR_01 cond 8) |
| `holidays` | jsonb array YYYY-MM-DD | feriados (IGOR_01 cond 9) |
| `holiday_policy` | string enum | `after_hours_force` | `block_completely` |
| `do_not_contact_keywords` | jsonb array | palavras PT-BR opt-out (futuro) |
| `campaign_optout_threshold` | jsonb obj | 3-em-20 auto-pausa (IGOR_10 futuro) |
| `human_team_id` | int | team Chatwoot p/ handoff |
| `human_inbox_id` | int | inbox Chatwoot principal |
| `human_inbox_identifier` | string | identifier API channel |

**Falta (TODO Fase C)**:
- `dry_run_send` (bool, equivalente IGOR_DRY_RUN)
- `allow_real_whatsapp_send` (bool, equivalente ALLOW_REAL_WHATSAPP_SEND)
- `evolution_base_url` (string)
- `evolution_instance_name` (string) ← pode usar pra prod/test toggle dinâmico
- `chatwoot_base_url`, `chatwoot_account_id` (strings/int)

## 7. Princípios arquiteturais inegociáveis

1. **Harness Engineering**: regras determinísticas em Code/IF/Switch/SQL/Redis-locks. LLM apenas para resposta conversacional + transcrição + visão.
2. **NO SIMPLIFICATIONS**: spec do `docs/logica-fluxo-igor-receptivo-fora-expediente.md` é literal. Se faltar info, perguntar — nunca decidir simplificação sozinho. Vide débito histórico em `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md`.
3. **Workflow inativo por padrão**: TODOS os IGOR_* nascem com `active: false`. Ativação manual no UI após smoke green.
4. **errorWorkflow universal**: cada workflow tem `settings.errorWorkflow = ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
5. **Gates de segurança**: `IGOR_DRY_RUN=true` bloqueia Evolution sendText. `ALLOW_REAL_WHATSAPP_SEND=false` é default. Ambos em `settings` table (vide §6 TODOs).
6. **Source of truth dual**: JSON canonical em `n8n/workflows/IGOR_*.json` é o que vale (foi PUT'd para n8n). `*.sdk.ts` é apenas script gerador, NÃO é regenerável sem perder `settings`/`tags`/`active` (vide SOURCE OF TRUTH NOTICE no header de cada SDK).

## 8. Pattern de hardcode (referência ASX)

ASX workflows em `docs/referencias/workflows-asx/` rodam em produção há meses. Eles hardcodam URLs e instance:
```
https://api.agenciaprospect.space/message/sendText/ASX_SDR
https://chat.agenciaprospect.space/api/v1/accounts/1/conversations/{{ $node['Validate Input'].json.chatwoot_conversation_id }}/assignments
```

Igor deve seguir o mesmo padrão (sem `$env`).

## 9. Documentos relacionados

- **Lógica funcional** (DON'T simplify):
  - `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
  - `docs/logica-fluxo-igor-agente-ativo-promocao.md`
- **Plano operacional**:
  - `docs/IMPLEMENTATION_PLAN.md` (§2 catálogo, §3 sub-workflows, §7 credentials)
  - `docs/WORKFLOW_PLAN.md` (Fase 4)
  - `docs/RUNBOOK.md` (smoke + diagnostics)
- **Status / pendências**:
  - `docs/VALIDATION_REPORT.md` (status atual de cada workflow)
  - `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` (débito histórico, todo resolvido)
- **Memórias do agente**:
  - `~/.claude/projects/.../memory/MEMORY.md` (índice — 4 entradas hoje)
  - `feedback_nunca_simplificar_e_asx_e_referencia.md`
  - `feedback_env_file_is_reference_only.md` ← regra `$env` proibido
  - `project_decisoes_fase_0.md`
- **Plans (Fase B + C)**:
  - `docs/superpowers/plans/2026-05-15-fase-b-inbound-rebuild.md`
  - `~/.claude/plans/elegant-tinkering-chipmunk.md` (Fase C integração)

## 10. Checklist para revisor agent

Ao revisar um workflow novo/modificado:

- [ ] Grep `$env\.` no JSON → zero hits (qualquer hit = bug).
- [ ] Grep `$vars\.` no JSON → zero hits (n8n Variables não disponível).
- [ ] `settings.errorWorkflow = "ZrsbaSTlW5bqMEaS"` setado.
- [ ] `active: false` setado (workflows nascem inativos).
- [ ] `tags` contém `igor` + `fase-b-rebuild` (ou tag de fase corrente).
- [ ] Credenciais referenciadas por nome canonical (§4) — sem hardcode de tokens.
- [ ] URLs hardcoded com valores canonicos (§5).
- [ ] `onError: continueRegularOutput` em postgres/redis nodes onde falha não pode bloquear pipeline (especialmente IGOR_08).
- [ ] Code nodes não têm `TODO`, `stub`, `_skip_X`, `placeholder` literal.
- [ ] Workflow validates limpo via `mcp__n8n-mcp__validate_workflow`.
- [ ] JSON canonical em `n8n/workflows/IGOR_*.json` está em sync com n8n live (re-export após PUT).
- [ ] Contrato espec ↔ implementação: ler `docs/logica-fluxo-igor-receptivo-fora-expediente.md` § correspondente + `docs/IMPLEMENTATION_PLAN.md §2 IGOR_XX` e cruzar com nodes.

## 11. Mudanças recentes

| Data | Evento | Commits |
|------|--------|---------|
| 2026-05-15 | Fase A reset (revert 6 simplified commits + DELETE n8n) | 6 reverts |
| 2026-05-15 | Fase B rebuild (7 workflows NO SIMPLIFICATIONS) | 8 feat + fixes |
| 2026-05-15 | Fase C wiring Evolution credential + onError IGOR_08 | `334b124` |
| 2026-05-15 | Fase C integração inbox + Evolution↔Chatwoot + webhooks | `225bbe0` |
| 2026-05-15 | Migration 009 settings (chaves separadas + activate IGOR_01..08) | `d328338` |

