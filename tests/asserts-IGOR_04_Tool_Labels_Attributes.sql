-- =============================================================================
-- asserts — IGOR_04_Tool_Labels_Attributes
-- =============================================================================
-- Cada fixture popula events com `payload->>'test_run_id' = '<fixture-name>'`.
-- Fase C executa o workflow via execute_workflow MCP com cada fixture e roda
-- estes asserts. Espera-se que cada assert retorne EXATAMENTE 1 linha com
-- `actual = expected` (não 0, não mais).
-- =============================================================================

-- @assert: FIXTURE labels_only — 2 eventos label_added
SELECT
  'IGOR_04_FIXTURE_labels_only' AS fixture,
  'label_added' AS event_type,
  count(*) AS actual,
  2 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_labels_only'
-- @end

-- @assert: FIXTURE labels_only — 1 evento label_removed
SELECT
  'IGOR_04_FIXTURE_labels_only' AS fixture,
  'label_removed' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'label_removed'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_labels_only'
-- @end

-- @assert: FIXTURE labels_only — labels esperadas em payload
SELECT
  'IGOR_04_FIXTURE_labels_only' AS fixture,
  'label_added_labels' AS check_name,
  count(*) AS actual,
  2 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_labels_only'
  AND payload->>'label' IN ('handoff_done', 'ai_disabled')
-- @end

-- @assert: FIXTURE labels_only — 0 eventos attribute_set
SELECT
  'IGOR_04_FIXTURE_labels_only' AS fixture,
  'attribute_set' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_labels_only'
-- @end

-- =============================================================================

-- @assert: FIXTURE attrs_conversation_only — 0 eventos label_added
SELECT
  'IGOR_04_FIXTURE_attrs_conversation_only' AS fixture,
  'label_added' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_conversation_only'
-- @end

-- @assert: FIXTURE attrs_conversation_only — 0 eventos label_removed
SELECT
  'IGOR_04_FIXTURE_attrs_conversation_only' AS fixture,
  'label_removed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_removed'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_conversation_only'
-- @end

-- @assert: FIXTURE attrs_conversation_only — 1 evento attribute_set scope=conversation
SELECT
  'IGOR_04_FIXTURE_attrs_conversation_only' AS fixture,
  'attribute_set_conversation' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_conversation_only'
  AND payload->>'scope' = 'conversation'
-- @end

-- @assert: FIXTURE attrs_conversation_only — 0 eventos attribute_set scope=contact
SELECT
  'IGOR_04_FIXTURE_attrs_conversation_only' AS fixture,
  'attribute_set_contact' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_conversation_only'
  AND payload->>'scope' = 'contact'
-- @end

-- =============================================================================

-- @assert: FIXTURE attrs_contact_and_labels — 1 evento label_added (atendimento_humano)
SELECT
  'IGOR_04_FIXTURE_attrs_contact_and_labels' AS fixture,
  'label_added' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_contact_and_labels'
  AND payload->>'label' = 'atendimento_humano'
-- @end

-- @assert: FIXTURE attrs_contact_and_labels — 0 eventos label_removed
SELECT
  'IGOR_04_FIXTURE_attrs_contact_and_labels' AS fixture,
  'label_removed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_removed'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_contact_and_labels'
-- @end

-- @assert: FIXTURE attrs_contact_and_labels — 1 evento attribute_set scope=conversation
SELECT
  'IGOR_04_FIXTURE_attrs_contact_and_labels' AS fixture,
  'attribute_set_conversation' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_contact_and_labels'
  AND payload->>'scope' = 'conversation'
-- @end

-- @assert: FIXTURE attrs_contact_and_labels — 1 evento attribute_set scope=contact
SELECT
  'IGOR_04_FIXTURE_attrs_contact_and_labels' AS fixture,
  'attribute_set_contact' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_attrs_contact_and_labels'
  AND payload->>'scope' = 'contact'
-- @end

-- =============================================================================

-- @assert: FIXTURE empty — 0 eventos label_added (NoOp gracefully)
SELECT
  'IGOR_04_FIXTURE_empty' AS fixture,
  'label_added' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_added'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_empty'
-- @end

-- @assert: FIXTURE empty — 0 eventos label_removed
SELECT
  'IGOR_04_FIXTURE_empty' AS fixture,
  'label_removed' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'label_removed'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_empty'
-- @end

-- @assert: FIXTURE empty — 0 eventos attribute_set (qualquer scope)
SELECT
  'IGOR_04_FIXTURE_empty' AS fixture,
  'attribute_set' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'attribute_set'
  AND payload->>'test_run_id' = 'IGOR_04_FIXTURE_empty'
-- @end
