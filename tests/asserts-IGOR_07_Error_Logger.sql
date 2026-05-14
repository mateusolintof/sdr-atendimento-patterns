-- @assert: linha events infra_error existe contendo o test_run_id no error_message
SELECT *
FROM public.events
WHERE event_type = 'infra_error'
  AND workflow_name = 'IGOR_TEST_Failing_Workflow'
  AND payload->>'error_message' LIKE '%{{TEST_RUN_ID}}%'
-- @end

-- @assert: payload tem campos obrigatorios preenchidos
SELECT *
FROM public.events
WHERE event_type = 'infra_error'
  AND workflow_name = 'IGOR_TEST_Failing_Workflow'
  AND payload->>'error_message' LIKE '%{{TEST_RUN_ID}}%'
  AND payload->>'workflow_name' = 'IGOR_TEST_Failing_Workflow'
  AND payload->>'error_message' IS NOT NULL
  AND payload->>'error_message' <> ''
  AND payload->>'workflow_id' IS NOT NULL
  AND payload->>'execution_id' IS NOT NULL
-- @end
