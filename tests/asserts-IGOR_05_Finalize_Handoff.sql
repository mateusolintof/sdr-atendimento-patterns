-- @assert: event handoff_complete gravado
SELECT *
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem handoff_reason e owner_flow
SELECT *
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'handoff_reason' = 'after_hours_callback'
  AND payload->>'owner_flow' = 'after_hours'
-- @end

-- @assert: conversation atualizada
SELECT *
FROM public.conversations
WHERE chatwoot_conversation_id = 8001
  AND state = 'human_assigned'
  AND ai_enabled = false
  AND human_locked = true
-- @end

-- @assert: event dry_run_send gravado (mensagem final ao lead)
SELECT *
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end
