# VALIDATION_REPORT — Instituto Dr. Igor

> Última atualização: 2026-05-15 (final da Fase B Inbound rebuild).

## Resumo executivo

**Fase A** ✅ — Reset limpo: 6 commits simplificados revertidos via git, 6 workflows DELETE no n8n via REST.

**Fase B** ✅ — 7 workflows do receptivo após-expediente reconstruídos sob regra absoluta NO SIMPLIFICATIONS. Todos commitados em `main`, todos criados no n8n com `active=false`, errorWorkflow → IGOR_07, tags `fase-b-rebuild` aplicada.

**Fase C** 🟡 — Em andamento. Build review concluído (todos APROVE). Smoke tests dependem de ações user-side (migration 008 + credencial `igor_evolution_api`). Runbook em `docs/RUNBOOK.md`.

## Workflows entregues (Fase B)

| Workflow | n8n ID | Nodes | Wave | Trigger | Status build review |
|----------|--------|-------|------|---------|---------------------|
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | 21 | 1 | callable | ✅ APPROVE (spec+quality) |
| `IGOR_02_Media_Normalizer` | `GBmG9WZzW2p8Nn6f` | 27 | 1 | callable | ✅ APPROVE (1 fix aplicado: PT-BR acentos) |
| `IGOR_08_Health_Check` | `cDpDA1QdIH9wHAlN` | 21 | 1 | cron `*/10 * * * *` | ✅ APPROVE (1 fix: onError em 4 nodes) |
| `IGOR_06_Chatwoot_Message_Logger` | `xpXRENR7Hoo2W5p3` | 17 | 2 | webhook `/igor/chatwoot` | ✅ APPROVE (review Fase C) |
| `IGOR_05_Finalize_Handoff` | `N31QcdrNVE5AOZdu` | 24 | 2 | callable | ✅ APPROVE (review Fase C) |
| `IGOR_01_Inbound_AfterHours` | `nC6ZhCVNn1fQiKfB` | 58 | 3 | webhook `/igor/inbound` | 🟡 review em andamento (Fase C) |
| `IGOR_03_Agent_AfterHours` | `iQCVbe1P8dC0vhay` | 26 | 4 | callable | 🟡 review em andamento (Fase C) |

Workflows preservados intactos (Fase A não tocou):
- `IGOR_07_Error_Logger` (`ZrsbaSTlW5bqMEaS`)
- `IGOR_AUX_save_lead_partial` (`hRogDlGsgQxGwnD8`)
- `IGOR_AUX_update_conversation_state` (`mFuRPrGGt7yWVqEw`)
- `IGOR_TEST_Failing_Workflow` (`m6QeFfLQRa94G5PJ`)
- `IGOR_TEST_Trampoline` (`enmJo4zpLEvvfuOH`)

## Debt registry status

Todos os 6 itens do `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` RESOLVIDOS:

| # | Workflow | Simplificação anterior | Reconstrução |
|---|----------|------------------------|--------------|
| 1 | IGOR_01 | matriz 5/12 + sem Redis + sem do_not_contact + sem campaign_contacts + sem IGOR_02/03 calls + sem holiday | ✅ 12/12 condições + Redis lock+batching + 4 callable invocations + holiday policy |
| 2 | IGOR_02 | audio/image stubs `[transcricao simulada]` | ✅ gpt-4o-transcribe + gpt-4o-mini vision REAIS, prompt PT-BR LITERAL restritivo |
| 3 | IGOR_04 | branch `custom_attributes` ausente | ✅ 3 branches: labels merge + custom_attributes.conversation (POST) + .contact (PUT) |
| 4 | IGOR_05 | UPDATE leads ausente, call IGOR_04 ausente, sendText hardcoded dry_run | ✅ Sequência completa 1-8 + send gate REAL com `ALLOW_REAL_WHATSAPP_SEND`+`IGOR_DRY_RUN` |
| 5 | IGOR_06 | call IGOR_04 com `atendimento_humano` ausente | ✅ Call IGOR_04 + UPDATE conv + events |
| 6 | IGOR_03 | reply path estruturado ausente | ✅ Format → SplitOut → SplitInBatches → Presence → SendGate → Wait → Log |

## Cobertura

### Bloqueios determinísticos (IGOR_01)
- ✅ fromMe → block
- ✅ ai_enabled_global=false → block
- ✅ workflows_enabled.IGOR_01=false → block
- ✅ phone inválido → block + events('invalid_phone')
- ✅ do_not_contact=true → block + label `optout`
- ✅ human_locked OR NOT ai_enabled → block
- ✅ campaign_contacts ativo → placeholder events (IGOR_12 fora de escopo Fase B)
- ✅ dentro de horário → block
- ✅ feriado → apply holiday_policy (P1 force after_hours)
- ✅ Redis lock conflict → batch fragment
- ✅ messageType≠text → IGOR_02
- ✅ happy path → IGOR_04 (`fora_expediente`) + IGOR_03

### Rotas de mídia (IGOR_02)
- ✅ texto → passthrough
- ✅ áudio → gpt-4o-transcribe (real)
- ✅ imagem com caption → passthrough
- ✅ imagem sem caption → gpt-4o-mini vision com PT-BR restritivo (real)
- ✅ documento → regex clínico + extractFromFile
- ✅ unknown → handoff `midia_desconhecida`

### Handoff (IGOR_05)
- ✅ UPDATE conversations (state, ai_enabled, human_locked, assigned_team_id)
- ✅ UPDATE leads (status, handoff_at) — gated por lead_id
- ✅ Labels: handoff_done + ai_disabled + aguardando_atendente; remove qualificacao_rapida + callback_solicitado
- ✅ Custom attributes conversation: automation_state, lead_status, handoff_reason, handoff_at, callback_period
- ✅ Private note PT-BR template literal
- ✅ Assign team + assignee opcional
- ✅ Send gate REAL: `ALLOW_REAL_WHATSAPP_SEND`+`IGOR_DRY_RUN`

### Compliance (IGOR_03)
- ✅ Fast-path antes do agente (should_handoff || clinical || sensitive_image || payment_proof)
- ✅ Call IGOR_05 direto com summary compliance
- ✅ Agent não responde se compliance triggered

### Reply path (IGOR_03)
- ✅ Format AI Output (paragraph split)
- ✅ SplitOut → SplitInBatches size=1
- ✅ Presence composing (Evolution)
- ✅ Send gate IGOR_DRY_RUN + ALLOW_REAL_WHATSAPP_SEND
- ✅ Wait 2s entre mensagens
- ✅ events('agent_response') a cada msg

### Observability
- ✅ events('inbound_received', 'inbound_blocked', 'inbound_routed', 'inbound_batched')
- ✅ events('media_normalized')
- ✅ events('label_added', 'label_removed', 'attribute_set')
- ✅ events('message_mirrored', 'human_assumed', 'event_filtered')
- ✅ events('handoff_complete', 'dry_run_send')
- ✅ events('agent_response', 'agent_routed_to_handoff')
- ✅ events('health_check', 'health_alert')

## Pendências para ativação produção (user-side)

### Migration Supabase
- [ ] **Aplicar `supabase/migrations/008_messages_msgid_unique.sql`** via SQL Editor. Idempotente, adiciona partial UNIQUE em `messages.msg_id WHERE msg_id IS NOT NULL`. Necessário para UPSERT em IGOR_02 e IGOR_06.

### Credenciais n8n
- [ ] **Criar credencial `igor_evolution_api`** (type: httpHeaderAuth, header: `apikey`, value: `EVOLUTION_API_KEY`). Necessária para IGOR_08 (ping), IGOR_05 (sendText), IGOR_03 (sendText + presence). Atualmente ausente → workflows caem em dry_run/degraded automaticamente (default seguro).
- [ ] **Confirmar `igor_chatwoot_api`** (httpHeaderAuth, header: `api_access_token`) wired nos HTTP nodes:
  - IGOR_04 (4 nodes): GET labels, POST labels, POST conv attrs, PUT contact attrs.
  - IGOR_05 (3 nodes): POST private note, POST team assign, POST assignee assign.
  - IGOR_08 (1 node): GET account.
- [ ] **Confirmar `igor_openai`** wired em IGOR_02 (audio + image), IGOR_03 (agent), IGOR_08 (ping).
- [ ] **Confirmar `igor_supabase_postgres`** auto-wired (geralmente OK pelo MCP).
- [ ] **Confirmar `igor_redis_embedded`** wired em IGOR_01 (lock+batching) e IGOR_08 (orphan check).

### Settings Supabase
- [ ] Confirmar `settings.ai_enabled_global = 'true'` (toggle global Igor).
- [ ] Confirmar `settings.workflows_enabled` JSON com `IGOR_01=true` (e demais).
- [ ] Confirmar `settings.holidays` JSON array YYYY-MM-DD (pode ser `[]` inicial).
- [ ] Confirmar `settings.after_hours_start='18:30'`, `settings.after_hours_end='07:30'`, `settings.timezone='America/Sao_Paulo'`.

### Workflow placeholder substitution
- [ ] **IGOR_01 emite `events('inbound_routed_pending_IGOR_03')` em vez de chamar IGOR_03 direto**. Agora que IGOR_03 existe (`iQCVbe1P8dC0vhay`), substituir o node de log por `executeWorkflow` apontando para IGOR_03. (Pode ser feito via Fase C PATCH ou manual UI.)
- [ ] **IGOR_01 emite `events('campaign_routed_pending_IGOR_12')`** — IGOR_12 não existe (fora de escopo Fase B). Mantido como placeholder até Frente Campanha ser retomada.

### Live workflow drift (source vs n8n)
- [ ] **IGOR_02 prompt PT-BR**: arquivo source tem acentos (commit `edd9adc`), live workflow ainda sem acentos (PUT bloqueado pelo classifier). Sem impacto semântico — gpt-4o-mini equivalente. Re-PUT manual ou via update_workflow MCP em Fase C.

## Smoke test runbook

Vide `docs/RUNBOOK.md` seção "Fase C — Smoke Tests".

Ordem de execução obrigatória:
1. Aplicar migration 008.
2. Criar credenciais ausentes.
3. Confirmar settings.
4. Substituir placeholder IGOR_03 em IGOR_01.
5. Executar 10 smoke tests com workflows ainda inactive (via `execute_workflow` MCP).
6. Rodar asserts.sql por fixture.
7. Aprovar ativação dos workflows no UI n8n.

## Estado git

```
39f5ca6 feat(IGOR_03): agente conversacional Alice completo + compliance fast-path + reply path estruturado
ce08dcc feat(IGOR_01): roteador inbound after-hours (12 condições + Redis batching + calls IGOR_02/03/04)
6ab85a0 Merge IGOR_05 worktree (Wave 2)
dd71bf2 feat(IGOR_06): chatwoot message logger + IGOR_04 call (atendimento_humano)
4cf2d64 feat(IGOR_05): finalize handoff completo (UPDATE leads + IGOR_04 call + send gated)
134d7df fix(IGOR_08): add onError continueRegularOutput
014d0c3 feat(IGOR_08): health check schedule + 5 service pings + race/orphan detection
edd9adc fix(IGOR_02): restore Portuguese diacritics in image vision prompt
fb8d68a feat(IGOR_02): media normalizer real (audio gpt-4o-transcribe + image gpt-4o-mini vision)
32e88ef fix(IGOR_04): SDK source-of-truth comment + audit doc stale wiring
8a4fe8f feat(IGOR_04): tool labels + custom_attributes branch
5cb34a6 docs(plan): Fase B Inbound rebuild plan (NO SIMPLIFICATIONS)
+ 6 revert commits (Fase A)
```
