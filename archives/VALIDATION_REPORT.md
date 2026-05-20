# VALIDATION_REPORT — Instituto Dr. Igor

> Última atualização: 2026-05-15 — pós Fase C (Inbound completo + integrações wireded + IGOR_TEST_Smoke_Trigger criado).

## Resumo executivo

| Frente | Status |
|--------|--------|
| Fase 0 — Auditoria | ✅ |
| Fase 1 — Plano funcional | ✅ |
| Fase 2 — Supabase migrations (001-012) | ✅ aplicadas |
| Fase 3 — Chatwoot seed (34 labels + 15 attrs + team + agent bot) | ✅ |
| Inbound — 7 workflows + AUX + helpers | ✅ todos construídos, ativos, integração Evolution↔Chatwoot↔n8n wired |
| Frente Campanha — 4 workflows pendentes (IGOR_10, IGOR_12, IGOR_13; IGOR_09 é script Python já existente; IGOR_11 deferido inline) | ❌ não construídos |

## Workflows IGOR_* — estado vivo

| Workflow | n8n ID | Nodes | Trigger | Active |
|----------|--------|-------|---------|--------|
| `IGOR_01_Inbound_AfterHours` | `nC6ZhCVNn1fQiKfB` | 59 | webhook `/igor/inbound` | ✅ active (com **BYPASS de business hours** em código — dívida) |
| `IGOR_02_Media_Normalizer` | `GBmG9WZzW2p8Nn6f` | 27 | callable | ✅ active |
| `IGOR_03_Agent_AfterHours` | `iQCVbe1P8dC0vhay` | 27 | callable | ✅ active |
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | 21 | callable | ✅ active |
| `IGOR_05_Finalize_Handoff` | `N31QcdrNVE5AOZdu` | 25 | callable | ✅ active |
| `IGOR_06_Chatwoot_Message_Logger` | `xpXRENR7Hoo2W5p3` | 17 | webhook `/igor/chatwoot` | ✅ active |
| `IGOR_07_Error_Logger` | `ZrsbaSTlW5bqMEaS` | (preserved) | errorTrigger | ✅ active |
| `IGOR_08_Health_Check` | `cDpDA1QdIH9wHAlN` | 21 | cron `*/10 * * * *` | ✅ active |
| `IGOR_AUX_save_lead_partial` | `hRogDlGsgQxGwnD8` | (preserved) | callable | ✅ active |
| `IGOR_AUX_update_conversation_state` | `mFuRPrGGt7yWVqEw` | (preserved) | callable | ✅ active |
| `IGOR_TEST_Smoke_Trigger` | `G8pMteuirc2yZgq5` | 6 | manualTrigger | manual (active flag irrelevante) |

## Integrações operacionais wireded

- **Chatwoot inbox** "Igor After Hours" (id=1, `inbox_identifier=vRrf8MeDTe9DsH11RB3ZRCug`, Channel::Api).
- **Evolution Chatwoot Integration** habilitada na instância `convert-teste` apontando para a inbox acima.
- **Evolution webhook** MESSAGES_UPSERT → `https://n8n.almaconvert.com.br/webhook/igor/inbound`.
- **Chatwoot webhook do inbox** → `https://n8n.almaconvert.com.br/webhook/igor/chatwoot`.
- **Credencial `igor_evolution_api`** (id `DDhbwLsNclqTA18X`) criada e wireded em IGOR_03/05/08 + IGOR_TEST_Smoke_Trigger.
- **Credencial `igor_chatwoot_api`** (id `x8StLhAFnYjQxUFg`) wireded em IGOR_04/05/08.

## Cobertura funcional

### Inbound — bloqueios determinísticos (IGOR_01)
- ✅ fromMe → block + events('inbound_blocked', reason='fromMe')
- ✅ ai_enabled_global=false → block
- ✅ workflows_enabled.IGOR_01=false → block
- ✅ phone inválido → events('invalid_phone')
- ✅ do_not_contact=true → CALL IGOR_04 (label optout) + block
- ✅ conversation human_locked OR ai_enabled=false → block
- ✅ campaign_contacts ativo → log placeholder IGOR_12 (Frente Campanha pendente)
- ✅ dentro de horário → block (com BYPASS atualmente)
- ✅ feriado → holiday_policy `after_hours_force`
- ✅ Redis lock conflict → batch fragment via RPUSH+marker
- ✅ messageType≠text → CALL IGOR_02
- ✅ happy path → CALL IGOR_04 ('fora_expediente') + CALL IGOR_03

### Mídia (IGOR_02)
- ✅ texto → passthrough
- ✅ áudio → gpt-4o-transcribe real
- ✅ imagem com caption → passthrough
- ✅ imagem sem caption → gpt-4o-mini vision com prompt PT-BR restritivo
- ✅ documento PDF → extractFromFile + regex clínico
- ✅ unknown → handoff `midia_desconhecida`

### Compliance + Reply path (IGOR_03)
- ✅ Fast-path antes do agente (should_handoff || safety_flags.clinical/sensitive_image/payment_proof)
- ✅ Compliance → CALL IGOR_05 direto, agent não roda
- ✅ Agent Alice: lmChatOpenAi gpt-5.4-mini + Postgres Chat Memory + 4 toolWorkflows (IGOR_04, IGOR_AUX_save_lead, IGOR_AUX_update_conv, IGOR_05)
- ✅ Reply path: Format → SplitOut → SplitInBatches → Presence → SendGate → Wait → Log

### Handoff (IGOR_05)
- ✅ UPDATE conversations (state, ai_enabled, human_locked, assigned_team_id)
- ✅ UPDATE leads (status, handoff_at) — gated por `lead_id`
- ✅ CALL IGOR_04 (handoff_done + ai_disabled + aguardando_atendente; remove qualificacao_rapida + callback_solicitado)
- ✅ Private note PT-BR template literal
- ✅ Assign team + assignee opcional (via `settings.chatwoot_human_assignee_id`)
- ✅ Send gate REAL: `settings.allow_real_whatsapp_send` AND `!settings.dry_run_send`

### Logger Chatwoot (IGOR_06)
- ✅ Filtra `event=message_created`
- ✅ UPSERT messages (depende de migration 008 partial UNIQUE em msg_id)
- ✅ Switch por (message_type, sender_type)
- ✅ Human takeover (outgoing+user) → UPDATE conversations + CALL IGOR_04 (`atendimento_humano`) + events('human_assumed')

### Health Check (IGOR_08)
- ✅ Cron */10min
- ✅ 5 service pings: n8n, Chatwoot, Evolution, OpenAI, Supabase
- ✅ Counts 24h (events, infra_errors, opt_outs, messages, leads, campaign_contacts)
- ✅ Race detection (ai_enabled=true recebendo msg humana últimos 10min)
- ✅ Orphan batches (Redis KEYS `igor:batch:*`)
- ✅ Thresholds → healthy / degraded / critical
- ✅ events('health_check') + IF critical → events('health_alert')

## Dívida atual

### 🔴 CRÍTICA
- **IGOR_01 BYPASS de business hours em código**: Code node "Check Business Hours + Holiday" retorna `inside_business_hours: false` hardcoded (`/* BYPASS smoke test 2026-05-15 */`). Necessário **reverter antes de prod**.

### 🟠 ALTA
- **IGOR_01 over-engineering** (59 nodes): pattern atual usa 3 nodes por condição de bloqueio (IF + INSERT block + Resp set) = ~36 nodes só nas branches de block. Refatoração possível: 1 Code que recebe `block_reason` e faz INSERT+respond unificado → ~12 nodes total. Não bloqueia execução, mas dificulta manutenção.

### 🟡 MÉDIA
- **Code nodes que poderiam ser Set / Edit Fields** (declarativos): IGOR_02 "Audio Format" / "Text Format" / "Image w/ Caption Format" / "Unknown Format"; IGOR_03 "Agent Output"; algumas saídas em IGOR_05. Não funcional, é qualidade idiomática n8n.
- **SDK files dessincronizados com JSON canonical**: IGOR_03 e IGOR_05 (subagent anterior não adicionou node "Load Gates" ao SDK source). JSON canonical é source-of-truth atual.

### 🟢 BAIXA
- **IGOR_TEST_Smoke_Trigger** envia ping bot→user. Pattern original do usuário era simular mensagem ENTRANTE (POST direto no webhook IGOR_01 com payload fake). Refazer se decidir voltar a esse modelo.

## Pendências user-side para fechar smoke

- Confirmar que credenciais n8n estão presentes (vide `docs/ARCHITECTURE.md §5`).
- Confirmar settings table com todas as keys (vide `docs/ARCHITECTURE.md §6`).
- Decidir sobre o BYPASS de business hours antes de prod.
- Construir os 3 workflows da Frente Campanha (`IGOR_10`, `IGOR_12`, `IGOR_13`) — design em `docs/ARCHITECTURE.md §4`.

## Estado git

Use `git log --oneline -30` para ver o changelog completo. Tags relevantes não foram criadas (decisão: histórico só em commits e timestamp no `docs/ARCHITECTURE.md §12`).
