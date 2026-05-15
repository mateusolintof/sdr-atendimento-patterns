# IGOR_01_Inbound_AfterHours — audit & runbook

**Workflow id n8n**: `nC6ZhCVNn1fQiKfB`
**Active**: `false` (segurança Fase B — só ativar após Fase C smoke completa).
**ErrorWorkflow**: `ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
**Tags**: `igor`, `inbound`, `webhook`, `router`, `fase-b-rebuild`.
**Webhook path**: `POST /webhook/igor/inbound`.
**Source-of-truth**: `n8n/workflows/IGOR_01_Inbound_AfterHours.json` (canonical export). SDK em `n8n/workflows/IGOR_01_Inbound_AfterHours.sdk.ts` (generator).
**Spec**: `docs/IMPLEMENTATION_PLAN.md` §2 IGOR_01 + `docs/logica-fluxo-igor-receptivo-fora-expediente.md` §8 & §9.

## Reconstrução NO SIMPLIFICATIONS

Este workflow foi reconstruído (Fase B Inbound Rebuild — Task 6 do plano `docs/superpowers/plans/2026-05-15-fase-b-inbound-rebuild.md`) substituindo o IGOR_01 simplificado anterior (debt commit `3a17bbc`). A reconstrução implementa:

- 12 condições determinísticas EM ORDEM EXATA.
- Redis lock+batching ASX-style (INCR atômico com TTL como substituto NX-EX, RPUSH+marker EXPIRE para batch fragmentado).
- Calls reais para `IGOR_02_Media_Normalizer` (`GBmG9WZzW2p8Nn6f`) e `IGOR_04_Tool_Labels_Attributes` (`AJF7dhGrqJEXMLqz`).
- Placeholders documentados para `IGOR_03_Agent_AfterHours` (Wave 4) e `IGOR_12_Campaign_Inbound_Handler` (fase Campanha).

## 58 nodes — fluxo

```
Evolution Webhook
   └── Normalize Payload (Code: extrai phone raw, msgId, fromMe, messageType WhatsApp-normalizado, text, caption, media URL/base64, mimeType, timestamp, chatwoot ids, test_run_id)
       └── INSERT inbound_received
           └── COND1 fromMe?
              ├── TRUE  → INSERT block fromMe → Resp fromMe → Final Response Merge[0]
              └── FALSE → Read Settings (7 keys)
                  └── COND2 ai_disabled_global?
                     ├── TRUE  → INSERT block ai_disabled_global → Resp → Merge[1]
                     └── FALSE → COND3 workflow_disabled? (parses workflows_enabled.IGOR_01)
                        ├── TRUE  → INSERT block workflow_disabled → Resp → Merge[2]
                        └── FALSE → Normalize Phone (regex 55+DDD+9 digits; auto-normaliza 8 digitos legacy adicionando '9' móvel)
                            └── COND4 phone invalid?
                               ├── TRUE  → INSERT invalid_phone → Resp → Merge[3]
                               └── FALSE → Lookup Contact (alwaysOutputData)
                                   └── COND5 do_not_contact?
                                      ├── TRUE  → CALL IGOR_04 labels=['optout'] + custom_attributes → INSERT block opt_out → Resp → Merge[4]
                                      └── FALSE → Lookup Conversation (alwaysOutputData)
                                          └── COND6 human_locked OR ai_enabled=false?
                                             ├── TRUE  → INSERT block human_locked_or_ai_disabled → Resp → Merge[5]
                                             └── FALSE → Lookup Campaign Contacts (alwaysOutputData; status IN sent/delivered/replied/interested)
                                                 └── COND7 campaign_active?
                                                    ├── TRUE  → INSERT campaign_routed_pending_IGOR_12 (com campaign_id, campaign_contact_id) → Resp → Merge[6]
                                                    └── FALSE → Check Business Hours + Holiday (Intl.DateTimeFormat tz-aware; holiday_policy P1='after_hours_force' → força after_hours em feriado)
                                                        └── COND8 inside business hours?
                                                           ├── TRUE  → INSERT block inside_hours → Resp → Merge[7]
                                                           └── FALSE → INSERT holiday_policy_applied (apenas se is_holiday=true; senão skip-payload)
                                                               └── Redis Lock INCR (igor:lock:inbound:{phone}, expire=true, ttl=30)
                                                                   └── Eval Lock Result (got_lock = counter === 1)
                                                                       └── COND10 got lock?
                                                                          ├── FALSE (batched)
                                                                          │     → Batch Prepare Payload
                                                                          │     → Redis RPUSH igor:batch:{phone}
                                                                          │     → Redis EXPIRE batch via marker (incr+ttl 60 — workaround Redis v1 sem EXPIRE direto)
                                                                          │     → INSERT inbound_batched (reason='lock_held')
                                                                          │     → Resp → Merge[8]
                                                                          └── TRUE (got lock)
                                                                                → Wait 3s for Fragments
                                                                                → Redis Get batch (LRANGE 0 -1 via keyType='list')
                                                                                → Redis DEL batch
                                                                                → Merge Fragments (consolida frags anteriores + mensagem atual)
                                                                                → COND11 messageType != text?
                                                                                   ├── TRUE  → CALL IGOR_02 Media Normalizer → Merge media+text[0]
                                                                                   └── FALSE →                                  Merge media+text[1]
                                                                                       └── Build Normalized Output (combina IGOR_02 output se mídia + merged_text)
                                                                                           → UPSERT conversation ai_after_hours (upsert contacts + conversations state='ai_after_hours', ai_enabled, current_flow='after_hours')
                                                                                           → UPSERT message inbound (direction='inbound', role='user', from_me=false)
                                                                                           → CALL IGOR_04 fora_expediente (labels=['fora_expediente'] + custom_attributes.conversation.automation_state='ai_after_hours')
                                                                                           → INSERT inbound_routed_to_IGOR_03 (observability event — payload inclui normalized_text, safety_flags, should_handoff, target_workflow_id)
                                                                                           → Call IGOR_03 Agent (executeWorkflow iQCVbe1P8dC0vhay, waitForSubWorkflow=true, payload 10 campos)
                                                                                           → Redis DEL lock
                                                                                           → Resp routed_ai_after_hours → Merge[9]
```

## Tabela de event_types e reasons

| event_type | quando | reason / payload |
|---|---|---|
| `inbound_received` | sempre na entrada (após Normalize Payload) | msg_id, message_type, from_me, instance, content_length, test_run_id |
| `inbound_blocked` | bloqueio em qualquer condição 1/2/3/5/6/8 | reason ∈ {`fromMe`, `ai_disabled_global`, `workflow_disabled`, `opt_out`, `human_locked_or_ai_disabled`, `inside_hours`} |
| `invalid_phone` | telefone falha regex (COND4) | raw_phone, reason='invalid_format_*' |
| `campaign_routed_pending_IGOR_12` | COND7 hit | campaign_id, campaign_contact_id, status, **placeholder enquanto IGOR_12 não existe** |
| `holiday_policy_applied` | dentro do `is_holiday=true` (COND9 informational) | ymd, holiday_policy |
| `inbound_batched` | COND10 no-lock | reason='lock_held', counter (>1) |
| `inbound_routed_to_IGOR_03` | happy path final (observability ANTES do executeWorkflow IGOR_03) | msg_id, message_type, fragments_count, normalized_text_preview, should_handoff, handoff_reason, safety_flags, target_workflow_id=`iQCVbe1P8dC0vhay` |

## Credentials wireadas (auto pela create_workflow_from_code)

- `igor_supabase_postgres` (Postgres): 14 nodes (todos os INSERT/UPSERT/SELECT).
- `igor_redis_embedded` (Redis): 6 nodes (Lock INCR, RPUSH, marker INCR, batch LRANGE-via-get, DEL batch, DEL lock).
- `IGOR_02` (`GBmG9WZzW2p8Nn6f`) executeWorkflow: chamado em `CALL IGOR_02 Media Normalizer`.
- `IGOR_03` (`iQCVbe1P8dC0vhay`) executeWorkflow: chamado em `Call IGOR_03 Agent` (final happy path, waitForSubWorkflow=true, 10 campos no payload).
- `IGOR_04` (`AJF7dhGrqJEXMLqz`) executeWorkflow: chamado em `CALL IGOR_04 optout label` (COND5) e `CALL IGOR_04 fora_expediente` (final happy path).

## Forward dependencies

- **IGOR_03_Agent_AfterHours**: WIRED direto via `executeWorkflow` após Fase C review (P0 fix). Node `Call IGOR_03 Agent` aponta para `iQCVbe1P8dC0vhay`. Observability mantida via `events('inbound_routed_to_IGOR_03')` ANTES da chamada. Substituiu placeholder `inbound_routed_pending_IGOR_03` (Wave 3) que existia quando IGOR_03 ainda não estava construído.
- **IGOR_12_Campaign_Inbound_Handler** (placeholder): ainda não existe. COND7 grava events('campaign_routed_pending_IGOR_12') com campaign_id, campaign_contact_id, status. Quando IGOR_12 for criado (fase Campanha), substituir por `executeWorkflow` apontando para IGOR_12.

## Decisões de design — Redis lock+batching

n8n Redis node v1 não expõe SET NX EX atomicamente, nem EXPIRE em listas diretamente. Substitutos atômicos:
1. **Lock atômico**: `INCR` operation com flags `expire=true, ttl=30`. Atomicamente cria/incrementa o key e seta TTL. counter === 1 → got_lock. counter > 1 → outro fragment está no comando.
2. **TTL na lista batch**: `RPUSH` em si não tem TTL no n8n node. Para garantir TTL 60s na lista, usamos um marker key paralelo `igor:batch:marker:{phone}` com `INCR + expire=true ttl=60`. A lista batch própria fica órfã apenas se o holder não rodar `DEL` — o IGOR_08_Health_Check tem assert orphan_batches via `KEYS igor:batch:*` para alerta.
3. **Release**: `DEL igor:lock:inbound:{phone}` no final do happy path (após events log).

Janela de race: 3s `Wait` permite fragmentos chegarem após o primeiro mensage. TTL 30s no lock garante recuperação automática se holder cair antes do DEL.

Limitação conhecida (vs SET NX EX exato): se INCR é registrado mas EXPIRE falha (atomicidade do n8n redis node é por operação), o lock pode ficar sem TTL. Mitigação: IGOR_08 monitora orphan locks via `KEYS igor:lock:*` (se >5 → critical).

## Decisões de design — business hours/holiday

- Hora atual computada em `settings.timezone` via `Intl.DateTimeFormat`.
- Janela business hours = `[after_hours_end, after_hours_start)` (e.g. 08:00..19:00). Inverso = after_hours.
- Suporta wrap (e.g. end=22:00, start=07:00 — janela de night-shift overnight).
- `is_holiday`: comparação de `YYYY-MM-DD` (em timezone) contra `settings.holidays` array.
- `holiday_policy='after_hours_force'` (P1): se feriado, força `inside_business_hours=false` mesmo dentro da janela — fluxo IA responde como fora de expediente. **Documentar mudança de policy futura** (P2 poderia ser "block_completely" — atualmente não implementado; v2 quando demandado).

## Fixtures

`fixtures/IGOR_01_*.json` — 10 cenários cobrindo cada bloqueio + happy paths text e audio + batch fragment.

## Asserts SQL

`tests/asserts-IGOR_01_Inbound_AfterHours.sql` — valida events, conversations, messages por fixture.

## Expected matrix

`tests/expected-IGOR_01_Inbound_AfterHours.md`.

## Concerns / open items

- **IGOR_03 wired (Fase C P0 fix)**: o happy path final agora chama `executeWorkflow` IGOR_03 (`iQCVbe1P8dC0vhay`) síncrono (`waitForSubWorkflow=true`). Observability via events('inbound_routed_to_IGOR_03') logo antes da chamada. Lead inbound after-hours já é atendido conversacionalmente pela Alice (IGOR_03). Test smoke deve validar event presence + IGOR_03 execution chain (after_hours_started → response → save_lead_partial etc.).
- **IGOR_12 placeholder**: leads de campanha (status=sent/delivered/replied/interested) são identificados e roteados via events, mas não recebem follow-up automatizado. Documentar em runbook que essas conversas hoje seguem para humano (Chatwoot) sem IA até IGOR_12 existir.
- **Redis race window 3s**: para usuários muito rápidos enviando 3+ mensagens em <3s, alguns fragmentos podem chegar na lista batch após o LRANGE do holder. Esses ficam órfãos (limpos no DEL batch do holder, mas se chegarem após o DEL, ficam na lista até TTL 60s expirar). Mitigação: WhatsApp já tem rate-limit natural >1s entre mensagens; IGOR_08 monitora orphans.
- **Holiday policy P1**: implementação atual sempre força `after_hours_force` para feriados. Mudança de policy (e.g. P2='block_completely') requer atualização de Check Business Hours + Holiday node.
- **Webhook ativação**: workflow está `active=false` por segurança. Após ativar `active=true`, a Evolution API ainda precisa ser apontada para `/webhook/igor/inbound` — vide RUNBOOK.

## Como ativar (Fase D / produção)

1. Validar smoke completo Fase C (todos os 10 fixtures asserts PASS).
2. Confirmar que IGOR_03 (`iQCVbe1P8dC0vhay`) está ativo (`active=true`) — `Call IGOR_03 Agent` já está wireado direto via executeWorkflow.
3. Confirmar `settings` tem todas as 7 keys populadas (`ai_enabled_global`, `workflows_enabled`, `after_hours_start`, `after_hours_end`, `timezone`, `holidays`, `holiday_policy`).
4. Confirmar Redis credential `igor_redis_embedded` conectado.
5. Ativar workflow: `PATCH /api/v1/workflows/nC6ZhCVNn1fQiKfB { active: true }`.
6. Configurar Evolution webhook: `POST {EVOLUTION_BASE_URL}/webhook/set/{instance}` body `{ webhook: { url: '{N8N_BASE_URL}/webhook/igor/inbound', events: ['MESSAGES_UPSERT'] } }`.
7. Smoke test final com número de teste autorizado.
