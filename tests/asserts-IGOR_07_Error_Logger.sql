-- @assert: linha events infra_error existe para o test_run_id
SELECT *
FROM public.events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem campos obrigatorios preenchidos
SELECT *
FROM public.events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'workflow_name' = 'IGOR_TEST_Failing_Workflow'
  AND payload->>'error_message' IS NOT NULL
  AND payload->>'error_message' <> ''
-- @end
