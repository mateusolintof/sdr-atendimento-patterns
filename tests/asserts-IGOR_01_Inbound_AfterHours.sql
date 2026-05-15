-- @assert: evento inbound_routed gravado para after-hours flow
SELECT *
FROM public.events
WHERE event_type = 'inbound_routed'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload indica target IGOR_03 e current_flow after_hours
SELECT *
FROM public.events
WHERE event_type = 'inbound_routed'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'target_workflow' = 'IGOR_03'
  AND payload->>'current_flow' = 'after_hours'
-- @end

-- @assert: phone normalizado registrado
SELECT *
FROM public.events
WHERE event_type = 'inbound_routed'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'phone' = '5562000900001'
-- @end
