-- @assert: evento lead_saved_partial gravado
SELECT *
FROM public.events
WHERE event_type = 'lead_saved_partial'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: leads tem linha com kommo_data test_run_id
SELECT *
FROM public.leads
WHERE kommo_data->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND source LIKE 'kommo_test_%'
  AND external_id = 'test-ext-001'
-- @end

-- @assert: contact foi criado/encontrado
SELECT *
FROM public.contacts c
JOIN public.leads l ON l.contact_id = c.id
WHERE l.kommo_data->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND c.phone = '5562900000001'
-- @end
