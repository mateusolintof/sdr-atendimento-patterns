-- =============================================================================
-- asserts — IGOR_02_Media_Normalizer
-- =============================================================================
-- Cada fixture popula events com `payload->>'test_run_id' = '<fixture-name>'`
-- e UPSERT-a messages com `msg_id = '<fixture-name>'`.
-- Fase C executa o workflow via execute_workflow MCP com cada fixture e roda
-- estes asserts. Espera-se que cada assert retorne EXATAMENTE 1 linha com
-- `actual = expected` (não 0, não mais).
-- =============================================================================

-- @assert: FIXTURE audio_url — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_audio_url' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_audio_url'
-- @end

-- @assert: FIXTURE audio_url — payload messageType = audio
SELECT
  'IGOR_02_FIXTURE_audio_url' AS fixture,
  'events_payload_messageType_audio' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_audio_url'
  AND payload->>'messageType' = 'audio'
-- @end

-- @assert: FIXTURE audio_url — should_handoff false
SELECT
  'IGOR_02_FIXTURE_audio_url' AS fixture,
  'events_should_handoff_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_audio_url'
  AND (payload->>'should_handoff')::boolean = false
-- @end

-- @assert: FIXTURE audio_url — 1 row em messages com msg_id
SELECT
  'IGOR_02_FIXTURE_audio_url' AS fixture,
  'messages_row' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_audio_url'
-- @end

-- @assert: FIXTURE audio_url — messages.safety_flags.clinical = false
SELECT
  'IGOR_02_FIXTURE_audio_url' AS fixture,
  'messages_safety_clinical_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_audio_url'
  AND (safety_flags->>'clinical')::boolean = false
-- @end

-- =============================================================================

-- @assert: FIXTURE audio_base64 — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_audio_base64' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_audio_base64'
-- @end

-- @assert: FIXTURE audio_base64 — payload messageType = audio
SELECT
  'IGOR_02_FIXTURE_audio_base64' AS fixture,
  'events_payload_messageType_audio' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_audio_base64'
  AND payload->>'messageType' = 'audio'
-- @end

-- @assert: FIXTURE audio_base64 — 1 row em messages
SELECT
  'IGOR_02_FIXTURE_audio_base64' AS fixture,
  'messages_row' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_audio_base64'
-- @end

-- =============================================================================

-- @assert: FIXTURE image_no_caption — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_image_no_caption' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_no_caption'
-- @end

-- @assert: FIXTURE image_no_caption — payload messageType = image
SELECT
  'IGOR_02_FIXTURE_image_no_caption' AS fixture,
  'events_payload_messageType_image' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_no_caption'
  AND payload->>'messageType' = 'image'
-- @end

-- @assert: FIXTURE image_no_caption — 1 row em messages com media_summary nao vazio
SELECT
  'IGOR_02_FIXTURE_image_no_caption' AS fixture,
  'messages_row_summary' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_image_no_caption'
  AND media_summary IS NOT NULL
  AND length(media_summary) > 0
-- @end

-- =============================================================================

-- @assert: FIXTURE image_with_caption — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_image_with_caption' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_with_caption'
-- @end

-- @assert: FIXTURE image_with_caption — should_handoff = false (caption passthrough)
SELECT
  'IGOR_02_FIXTURE_image_with_caption' AS fixture,
  'events_should_handoff_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_with_caption'
  AND (payload->>'should_handoff')::boolean = false
-- @end

-- @assert: FIXTURE image_with_caption — 1 row em messages
SELECT
  'IGOR_02_FIXTURE_image_with_caption' AS fixture,
  'messages_row' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_image_with_caption'
-- @end

-- =============================================================================

-- @assert: FIXTURE image_clinical_flagged — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_image_clinical_flagged' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_clinical_flagged'
-- @end

-- @assert: FIXTURE image_clinical_flagged — should_handoff false (caption passthrough nao dispara)
SELECT
  'IGOR_02_FIXTURE_image_clinical_flagged' AS fixture,
  'events_should_handoff_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_image_clinical_flagged'
  AND (payload->>'should_handoff')::boolean = false
-- @end

-- =============================================================================

-- @assert: FIXTURE document_clinical — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_document_clinical' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_document_clinical'
-- @end

-- @assert: FIXTURE document_clinical — payload safety_flags.clinical = true
SELECT
  'IGOR_02_FIXTURE_document_clinical' AS fixture,
  'events_safety_clinical_true' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_document_clinical'
  AND (payload->'safety_flags'->>'clinical')::boolean = true
-- @end

-- @assert: FIXTURE document_clinical — should_handoff = true
SELECT
  'IGOR_02_FIXTURE_document_clinical' AS fixture,
  'events_should_handoff_true' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_document_clinical'
  AND (payload->>'should_handoff')::boolean = true
  AND payload->>'handoff_reason' = 'documento_clinico_sensivel'
-- @end

-- @assert: FIXTURE document_clinical — 1 row em messages com safety_flags.clinical=true
SELECT
  'IGOR_02_FIXTURE_document_clinical' AS fixture,
  'messages_safety_clinical_true' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_document_clinical'
  AND (safety_flags->>'clinical')::boolean = true
-- @end

-- =============================================================================

-- @assert: FIXTURE document_generic — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_document_generic' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_document_generic'
-- @end

-- @assert: FIXTURE document_generic — should_handoff false
SELECT
  'IGOR_02_FIXTURE_document_generic' AS fixture,
  'events_should_handoff_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_document_generic'
  AND (payload->>'should_handoff')::boolean = false
-- @end

-- @assert: FIXTURE document_generic — 1 row em messages com safety_flags.clinical=false
SELECT
  'IGOR_02_FIXTURE_document_generic' AS fixture,
  'messages_safety_clinical_false' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_document_generic'
  AND (safety_flags->>'clinical')::boolean = false
-- @end

-- =============================================================================

-- @assert: FIXTURE text_passthrough — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_text_passthrough' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_text_passthrough'
-- @end

-- @assert: FIXTURE text_passthrough — payload messageType = text
SELECT
  'IGOR_02_FIXTURE_text_passthrough' AS fixture,
  'events_payload_messageType_text' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_text_passthrough'
  AND payload->>'messageType' = 'text'
-- @end

-- @assert: FIXTURE text_passthrough — 1 row em messages com normalized_text
SELECT
  'IGOR_02_FIXTURE_text_passthrough' AS fixture,
  'messages_normalized_text_nonempty' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_text_passthrough'
  AND normalized_text IS NOT NULL
  AND length(normalized_text) > 0
-- @end

-- =============================================================================

-- @assert: FIXTURE unknown_type — 1 evento media_normalized
SELECT
  'IGOR_02_FIXTURE_unknown_type' AS fixture,
  'events_media_normalized' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_unknown_type'
-- @end

-- @assert: FIXTURE unknown_type — should_handoff = true com handoff_reason = midia_desconhecida
SELECT
  'IGOR_02_FIXTURE_unknown_type' AS fixture,
  'events_handoff_midia_desconhecida' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'media_normalized'
  AND payload->>'test_run_id' = 'IGOR_02_FIXTURE_unknown_type'
  AND (payload->>'should_handoff')::boolean = true
  AND payload->>'handoff_reason' = 'midia_desconhecida'
-- @end

-- @assert: FIXTURE unknown_type — 1 row em messages
SELECT
  'IGOR_02_FIXTURE_unknown_type' AS fixture,
  'messages_row' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.messages
WHERE msg_id = 'IGOR_02_FIXTURE_unknown_type'
-- @end
