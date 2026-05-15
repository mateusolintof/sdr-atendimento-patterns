-- =============================================================================
-- asserts — IGOR_06_Chatwoot_Message_Logger
-- =============================================================================
-- Cada fixture é POSTada para o webhook do workflow. Eventos e mensagens são
-- gravados com `payload->>'test_run_id'` = '<fixture-run-id>'. Asserts retornam
-- EXATAMENTE 1 linha com `actual = expected` (não 0, não mais).
--
-- Pré-requisito: as conversas referenciadas em `chatwoot_conversation_id`
-- (9601, 9602, 9603) precisam existir em `public.conversations` antes de
-- rodar os asserts; caso contrário UPSERT messages e UPDATE conversations
-- viram no-op (FROM ... WHERE c.chatwoot_conversation_id = X retorna 0 rows).
-- Fase C deve semear essas conversations no fixture setup.
-- =============================================================================

-- =============================================================================
-- FIXTURE: incoming (lead -> bot inbox; deve apenas espelhar; sem human_takeover)
-- =============================================================================

-- @assert: FIXTURE incoming — 1 evento message_mirrored
SELECT
  'IGOR_06_FIXTURE_incoming' AS fixture,
  'message_mirrored' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'message_mirrored'
  AND workflow_name = 'IGOR_06_Chatwoot_Message_Logger'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_incoming'
  AND payload->>'branch' = 'inbound_noop'
-- @end

-- @assert: FIXTURE incoming — 0 eventos human_assumed
SELECT
  'IGOR_06_FIXTURE_incoming' AS fixture,
  'human_assumed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'human_assumed'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_incoming'
-- @end

-- @assert: FIXTURE incoming — 0 eventos event_filtered (passou no IF)
SELECT
  'IGOR_06_FIXTURE_incoming' AS fixture,
  'event_filtered' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'event_filtered'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_incoming'
-- @end

-- @assert: FIXTURE incoming — 1 row em messages (espelho da inbound)
SELECT
  'IGOR_06_FIXTURE_incoming' AS fixture,
  'messages_mirror' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = 9601
  AND m.msg_id = '700001'
  AND m.direction = 'inbound'
  AND m.role = 'user'
  AND m.from_me = false
-- @end

-- =============================================================================

-- =============================================================================
-- FIXTURE: outgoing_human (agente humano respondeu; human_takeover)
-- =============================================================================

-- @assert: FIXTURE outgoing_human — 1 evento message_mirrored
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'message_mirrored' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'message_mirrored'
  AND workflow_name = 'IGOR_06_Chatwoot_Message_Logger'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND payload->>'branch' = 'human_takeover'
-- @end

-- @assert: FIXTURE outgoing_human — 1 evento human_assumed
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'human_assumed' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'human_assumed'
  AND workflow_name = 'IGOR_06_Chatwoot_Message_Logger'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND payload->>'chatwoot_conversation_id' = '9602'
  AND payload->>'agent_user_id' = '17'
-- @end

-- @assert: FIXTURE outgoing_human — human_assumed payload tem labels_applied corretas
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'human_assumed_labels' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'human_assumed'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND (payload->'labels_applied')::jsonb @> '["atendimento_humano","ai_disabled"]'::jsonb
-- @end

-- @assert: FIXTURE outgoing_human — conversations.human_locked=true após
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'conversation_human_locked' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9602
  AND human_locked = true
  AND ai_enabled = false
  AND state = 'human_assigned'
-- @end

-- @assert: FIXTURE outgoing_human — IGOR_04 label_added 'atendimento_humano'
-- (chamada via executeWorkflow; events disparados pelo IGOR_04 com mesmo test_run_id)
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'igor_04_label_atendimento_humano' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND workflow_name = 'IGOR_04_Tool_Labels_Attributes'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND payload->>'label' = 'atendimento_humano'
-- @end

-- @assert: FIXTURE outgoing_human — IGOR_04 label_added 'ai_disabled'
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'igor_04_label_ai_disabled' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND workflow_name = 'IGOR_04_Tool_Labels_Attributes'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND payload->>'label' = 'ai_disabled'
-- @end

-- @assert: FIXTURE outgoing_human — IGOR_04 attribute_set conversation
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'igor_04_attribute_set_conversation' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND workflow_name = 'IGOR_04_Tool_Labels_Attributes'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_human'
  AND payload->>'scope' = 'conversation'
-- @end

-- @assert: FIXTURE outgoing_human — 1 row em messages (espelho outgoing)
SELECT
  'IGOR_06_FIXTURE_outgoing_human' AS fixture,
  'messages_mirror' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = 9602
  AND m.msg_id = '700002'
  AND m.direction = 'outbound'
  AND m.role = 'agent'
  AND m.from_me = true
-- @end

-- =============================================================================

-- =============================================================================
-- FIXTURE: outgoing_bot (Igor IA enviou; espelha mas NÃO trava)
-- =============================================================================

-- @assert: FIXTURE outgoing_bot — 1 evento message_mirrored
SELECT
  'IGOR_06_FIXTURE_outgoing_bot' AS fixture,
  'message_mirrored' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'message_mirrored'
  AND workflow_name = 'IGOR_06_Chatwoot_Message_Logger'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_bot'
  AND payload->>'branch' = 'bot_noop'
-- @end

-- @assert: FIXTURE outgoing_bot — 0 eventos human_assumed
SELECT
  'IGOR_06_FIXTURE_outgoing_bot' AS fixture,
  'human_assumed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'human_assumed'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_bot'
-- @end

-- @assert: FIXTURE outgoing_bot — IGOR_04 NÃO foi chamado (0 label_added com este test_run_id)
SELECT
  'IGOR_06_FIXTURE_outgoing_bot' AS fixture,
  'igor_04_not_called' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND workflow_name = 'IGOR_04_Tool_Labels_Attributes'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_outgoing_bot'
-- @end

-- @assert: FIXTURE outgoing_bot — conversations NÃO travada (human_locked permanece false)
SELECT
  'IGOR_06_FIXTURE_outgoing_bot' AS fixture,
  'conversation_not_locked' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9603
  AND human_locked = false
  AND ai_enabled = true
-- @end

-- @assert: FIXTURE outgoing_bot — 1 row em messages (espelho outgoing agent_bot)
SELECT
  'IGOR_06_FIXTURE_outgoing_bot' AS fixture,
  'messages_mirror' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = 9603
  AND m.msg_id = '700003'
  AND m.direction = 'outbound'
  AND m.role = 'assistant'
  AND m.from_me = true
-- @end

-- =============================================================================

-- =============================================================================
-- FIXTURE: event_conversation_updated (event != message_created; deve NoOp filter)
-- =============================================================================

-- @assert: FIXTURE event_other — 1 evento event_filtered
SELECT
  'IGOR_06_FIXTURE_event_other' AS fixture,
  'event_filtered' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'event_filtered'
  AND workflow_name = 'IGOR_06_Chatwoot_Message_Logger'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_event_other'
  AND payload->>'event' = 'conversation_updated'
-- @end

-- @assert: FIXTURE event_other — 0 eventos message_mirrored
SELECT
  'IGOR_06_FIXTURE_event_other' AS fixture,
  'message_mirrored' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'message_mirrored'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_event_other'
-- @end

-- @assert: FIXTURE event_other — 0 eventos human_assumed
SELECT
  'IGOR_06_FIXTURE_event_other' AS fixture,
  'human_assumed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'human_assumed'
  AND payload->>'test_run_id' = 'IGOR_06_FIXTURE_event_other'
-- @end

-- @assert: FIXTURE event_other — 0 rows em messages
SELECT
  'IGOR_06_FIXTURE_event_other' AS fixture,
  'messages_mirror_zero' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = 9604
-- @end
