-- @assert: evento label_added foi gravado
SELECT *
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem labels added corretas
SELECT *
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->'added' @> '["ai_after_hours"]'::jsonb
  AND payload->'added' @> '["fora_expediente"]'::jsonb
-- @end

-- @assert: workflow_name correto
SELECT *
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND workflow_name = 'IGOR_04_Tool_Labels_Attributes'
-- @end
