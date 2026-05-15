-- =============================================================================
-- asserts — IGOR_01_Inbound_AfterHours
-- =============================================================================
-- Cada fixture é POSTada para o webhook /webhook/igor/inbound do workflow
-- (id n8n: nC6ZhCVNn1fQiKfB). Eventos e mensagens são gravados com
-- payload->>'test_run_id' = '<fixture-run-id>'. Asserts retornam exatamente 1
-- linha com `actual = expected`.
--
-- Pré-requisitos por fixture:
--   * IGOR_01_FIXTURE_optout         — pré-seed contacts(phone='5511999990805', do_not_contact=true).
--   * IGOR_01_FIXTURE_human_locked   — pré-seed contacts(phone='5511999990806') + conversations(chatwoot_conversation_id=9806, ai_enabled=false, human_locked=true).
--   * IGOR_01_FIXTURE_campaign_active— pré-seed contacts(phone='5511999990807') + campaign_runs(status='ativo') + campaign_contacts(contact_id->this, status='sent').
--   * IGOR_01_FIXTURE_holiday        — pré-seed settings.holidays incluindo hoje (YYYY-MM-DD em America/Sao_Paulo), settings.holiday_policy='"after_hours_force"'.
--   * IGOR_01_FIXTURE_batch_lock_held— pré-popule Redis igor:lock:inbound:5511999990810=1 EX 30 OU POSTe um fragmento anterior phone=5511999990810 antes.
-- =============================================================================

-- =============================================================================
-- FIXTURE: text_afterhours (happy path — passa 11 condições e chega no placeholder IGOR_03)
-- =============================================================================

-- @assert: 1 evento inbound_received
SELECT 'IGOR_01_FIXTURE_text_afterhours' AS fixture, 'inbound_received' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_received'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_text_afterhours'
-- @end

-- @assert: 0 inbound_blocked (não bloqueia em nenhuma condição)
SELECT 'IGOR_01_FIXTURE_text_afterhours' AS fixture, 'inbound_blocked_none' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_text_afterhours'
-- @end

-- @assert: 1 inbound_routed_pending_IGOR_03 (chega no placeholder IGOR_03)
SELECT 'IGOR_01_FIXTURE_text_afterhours' AS fixture, 'inbound_routed_pending_IGOR_03' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_text_afterhours'
-- @end

-- @assert: conversation upserted com state='ai_after_hours' e ai_enabled=true
SELECT 'IGOR_01_FIXTURE_text_afterhours' AS fixture, 'conversation_state_ai_after_hours' AS check_name, count(*) AS actual, 1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9801
  AND state = 'ai_after_hours'
  AND ai_enabled = true
  AND current_flow = 'after_hours'
-- @end

-- @assert: message inbound persistida (1 row, text=normalized_text=conteúdo do fixture)
SELECT 'IGOR_01_FIXTURE_text_afterhours' AS fixture, 'message_inserted' AS check_name, count(*) AS actual, 1 AS expected
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = 9801
  AND m.msg_id = 'EVOLUTION_FIX_text_afterhours_001'
  AND m.direction = 'inbound'
  AND m.role = 'user'
  AND m.from_me = false
-- @end

-- =============================================================================
-- FIXTURE: text_inside_hours (bloqueia em COND8)
-- =============================================================================

-- @assert: 1 inbound_blocked reason=inside_hours
SELECT 'IGOR_01_FIXTURE_text_inside_hours' AS fixture, 'inbound_blocked_inside_hours' AS check_name, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'reason' = 'inside_hours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_text_inside_hours'
-- @end

-- @assert: 0 inbound_routed_pending_IGOR_03 (não chega em IGOR_03)
SELECT 'IGOR_01_FIXTURE_text_inside_hours' AS fixture, 'no_route_to_IGOR_03' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_text_inside_hours'
-- @end

-- =============================================================================
-- FIXTURE: fromme (bloqueia em COND1)
-- =============================================================================

-- @assert: 1 inbound_blocked reason=fromMe
SELECT 'IGOR_01_FIXTURE_fromme' AS fixture, 'inbound_blocked_fromMe' AS check_name, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'reason' = 'fromMe'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_fromme'
-- @end

-- @assert: 0 Read Settings ran (early-cut at COND1 -> settings nem lida)
-- (Não há um event direto que prove isto; mas validamos indirect: 0 events com reasons posteriores
--  para este test_run_id)
SELECT 'IGOR_01_FIXTURE_fromme' AS fixture, 'no_downstream_blocks' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type IN ('invalid_phone','inbound_routed_pending_IGOR_03','inbound_batched','holiday_policy_applied','campaign_routed_pending_IGOR_12')
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_fromme'
-- @end

-- =============================================================================
-- FIXTURE: invalid_phone (bloqueia em COND4)
-- =============================================================================

-- @assert: 1 invalid_phone event
SELECT 'IGOR_01_FIXTURE_invalid_phone' AS fixture, 'invalid_phone' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'invalid_phone'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_invalid_phone'
-- @end

-- @assert: 0 inbound_routed (não chega em IGOR_03)
SELECT 'IGOR_01_FIXTURE_invalid_phone' AS fixture, 'no_route' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_invalid_phone'
-- @end

-- =============================================================================
-- FIXTURE: optout (bloqueia em COND5 + chama IGOR_04 com label optout)
-- Pré-requisito: contacts(phone='5511999990805', do_not_contact=true) pré-seeded.
-- =============================================================================

-- @assert: 1 inbound_blocked reason=opt_out
SELECT 'IGOR_01_FIXTURE_optout' AS fixture, 'inbound_blocked_opt_out' AS check_name, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'reason' = 'opt_out'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_optout'
-- @end

-- @assert: IGOR_04 foi chamado com label optout — IGOR_04 grava events('label_added') ou
-- similar; se IGOR_04 ainda não logar isso, ao menos confirmar que NÃO há
-- inbound_routed_pending_IGOR_03 (não passou pela COND12).
SELECT 'IGOR_01_FIXTURE_optout' AS fixture, 'no_IGOR_03_route' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_optout'
-- @end

-- =============================================================================
-- FIXTURE: human_locked (bloqueia em COND6)
-- Pré-requisito: conversations(chatwoot_conversation_id=9806, human_locked=true ou ai_enabled=false) pré-seeded.
-- =============================================================================

-- @assert: 1 inbound_blocked reason=human_locked_or_ai_disabled
SELECT 'IGOR_01_FIXTURE_human_locked' AS fixture, 'inbound_blocked_human_locked_or_ai_disabled' AS check_name, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'reason' = 'human_locked_or_ai_disabled'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_human_locked'
-- @end

-- =============================================================================
-- FIXTURE: campaign_active (rota em COND7 -> events campaign_routed_pending_IGOR_12)
-- Pré-requisito: campaign_contacts(contact phone=5511999990807, status='sent') pré-seeded.
-- =============================================================================

-- @assert: 1 campaign_routed_pending_IGOR_12 event
SELECT 'IGOR_01_FIXTURE_campaign_active' AS fixture, 'campaign_routed_pending_IGOR_12' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'campaign_routed_pending_IGOR_12'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_campaign_active'
-- @end

-- @assert: 0 inbound_routed_pending_IGOR_03 (campanha não cai no IGOR_03)
SELECT 'IGOR_01_FIXTURE_campaign_active' AS fixture, 'no_IGOR_03_route' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_campaign_active'
-- @end

-- =============================================================================
-- FIXTURE: audio_afterhours (passa COND10 + chama IGOR_02 + IGOR_04 + IGOR_03 placeholder)
-- =============================================================================

-- @assert: 1 inbound_routed_pending_IGOR_03 com message_type=audio
SELECT 'IGOR_01_FIXTURE_audio_afterhours' AS fixture, 'audio_routed_to_IGOR_03_placeholder' AS check_name, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_audio_afterhours'
  AND payload->>'message_type' = 'audio'
-- @end

-- @assert: 0 inbound_blocked
SELECT 'IGOR_01_FIXTURE_audio_afterhours' AS fixture, 'no_blocks' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_blocked'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_audio_afterhours'
-- @end

-- =============================================================================
-- FIXTURE: holiday (events holiday_policy_applied + segue como after_hours)
-- Pré-requisito: settings.holidays inclui hoje (em America/Sao_Paulo); holiday_policy="after_hours_force".
-- =============================================================================

-- @assert: 1 holiday_policy_applied event com is_holiday=true
SELECT 'IGOR_01_FIXTURE_holiday' AS fixture, 'holiday_policy_applied' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'holiday_policy_applied'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_holiday'
  AND (payload->>'is_holiday')::boolean = true
-- @end

-- =============================================================================
-- FIXTURE: batch_lock_held (segundo fragment não obtém lock → batched)
-- Pré-requisito: lock prévio ou POST anterior do mesmo phone.
-- =============================================================================

-- @assert: 1 inbound_batched event com reason=lock_held
SELECT 'IGOR_01_FIXTURE_batch_lock_held' AS fixture, 'inbound_batched' AS event_type, count(*) AS actual, 1 AS expected
FROM public.events
WHERE event_type = 'inbound_batched'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'reason' = 'lock_held'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_batch_lock_held'
-- @end

-- @assert: 0 inbound_routed (segundo fragment não chega no IGOR_03)
SELECT 'IGOR_01_FIXTURE_batch_lock_held' AS fixture, 'no_route' AS check_name, count(*) AS actual, 0 AS expected
FROM public.events
WHERE event_type = 'inbound_routed_pending_IGOR_03'
  AND payload->>'test_run_id' = 'IGOR_01_FIXTURE_batch_lock_held'
-- @end

-- =============================================================================
-- GLOBAL: contagem de inbound_received por fixture (sanity check)
-- =============================================================================

SELECT
  'IGOR_01_global' AS fixture,
  'total_inbound_received' AS check_name,
  count(*) AS actual,
  10 AS expected
FROM public.events
WHERE event_type = 'inbound_received'
  AND workflow_name = 'IGOR_01_Inbound_AfterHours'
  AND payload->>'test_run_id' LIKE 'IGOR_01_FIXTURE_%'
-- @end
