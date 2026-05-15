-- @assert: evento conversation_state_updated gravado
SELECT *
FROM public.events
WHERE event_type = 'conversation_state_updated'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem state e current_flow corretos
SELECT *
FROM public.events
WHERE event_type = 'conversation_state_updated'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'state' = 'ai_after_hours'
  AND payload->>'current_flow' = 'after_hours'
-- @end

-- @assert: conversation row existe com state aplicado
SELECT *
FROM public.conversations
WHERE chatwoot_conversation_id = 9001
  AND state = 'ai_after_hours'
  AND current_flow = 'after_hours'
-- @end
