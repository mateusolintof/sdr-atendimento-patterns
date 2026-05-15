-- @assert: evento media_normalized gravado
SELECT *
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload registra messageType document
SELECT *
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'message_type' = 'document'
-- @end

-- @assert: clinical flag true + should_handoff true (filename 'exame')
SELECT *
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->'safety_flags'->>'clinical' = 'true'
  AND payload->>'should_handoff' = 'true'
-- @end
