-- =============================================================================
-- asserts — IGOR_05_Finalize_Handoff
-- =============================================================================
-- Cada fixture popula `events.payload->>'test_run_id'` com `IGOR_05_FIXTURE_*`.
-- Fase C executa o workflow via execute_workflow MCP com cada fixture e roda
-- estes asserts. Espera-se que cada assert retorne EXATAMENTE 1 linha com
-- `actual = expected` (não 0, não mais).
--
-- Preconditions (rodar antes de smoke):
--   - conversations rows com chatwoot_conversation_id IN (9001, 9002, 9003, 9004)
--     existem (state=any, ai_enabled=true, human_locked=false).
--   - leads rows com id IN (
--       '00000000-0000-0000-0000-000000000005',
--       '00000000-0000-0000-0000-000000000007',
--       '00000000-0000-0000-0000-000000000009'
--     ) existem (status='novo' ou similar, handoff_at IS NULL).
--   - chatwoot_conversation_id é integer no schema.
--
-- Send-gate semantics:
--   - Fixture with_lead_callback: env ALLOW_REAL_WHATSAPP_SEND=false (default) →
--     events('dry_run_send') deve existir; events('whatsapp_sent') NÃO.
--   - Fixture dry_run: idem (testa explicitamente IGOR_DRY_RUN=true).
--   - Em ambiente que ALLOW_REAL_WHATSAPP_SEND=true E IGOR_DRY_RUN=false:
--     events('whatsapp_sent') existe; events('dry_run_send') NÃO. Os asserts
--     abaixo assumem o default seguro (dry).
-- =============================================================================

-- =============================================================================
-- FIXTURE with_lead_callback
-- =============================================================================

-- @assert: FIXTURE with_lead_callback — conversation state=human_assigned
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'conversation_human_assigned' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9001
  AND state = 'human_assigned'
  AND ai_enabled = false
  AND human_locked = true
-- @end

-- @assert: FIXTURE with_lead_callback — lead status=aguardando_atendente + handoff_at preenchido
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'lead_aguardando_atendente' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.leads
WHERE id = '00000000-0000-0000-0000-000000000005'::uuid
  AND status = 'aguardando_atendente'
  AND handoff_at IS NOT NULL
-- @end

-- @assert: FIXTURE with_lead_callback — exatamente 1 events('handoff_complete')
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'handoff_complete' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_with_lead_callback'
-- @end

-- @assert: FIXTURE with_lead_callback — handoff_complete payload contém handoff_reason e owner_flow
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'handoff_complete_payload' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_with_lead_callback'
  AND payload->>'handoff_reason' = 'after_hours_callback'
  AND payload->>'owner_flow' = 'after_hours'
  AND payload->>'callback_period' = 'amanhã de manhã'
-- @end

-- @assert: FIXTURE with_lead_callback — 1 events('dry_run_send') (default seguro)
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'dry_run_send' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_with_lead_callback'
-- @end

-- @assert: FIXTURE with_lead_callback — 0 events('whatsapp_sent') (default seguro)
SELECT
  'IGOR_05_FIXTURE_with_lead_callback' AS fixture,
  'whatsapp_sent' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'whatsapp_sent'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_with_lead_callback'
-- @end

-- =============================================================================
-- FIXTURE no_lead
-- =============================================================================

-- @assert: FIXTURE no_lead — conversation state=human_assigned
SELECT
  'IGOR_05_FIXTURE_no_lead' AS fixture,
  'conversation_human_assigned' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9002
  AND state = 'human_assigned'
  AND ai_enabled = false
  AND human_locked = true
-- @end

-- @assert: FIXTURE no_lead — exatamente 1 events('handoff_complete')
SELECT
  'IGOR_05_FIXTURE_no_lead' AS fixture,
  'handoff_complete' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_no_lead'
-- @end

-- @assert: FIXTURE no_lead — handoff_complete payload com handoff_reason=compliance_hold e lead_id null
SELECT
  'IGOR_05_FIXTURE_no_lead' AS fixture,
  'handoff_complete_payload_no_lead' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_no_lead'
  AND payload->>'handoff_reason' = 'compliance_hold'
  AND (payload->>'lead_id' IS NULL OR payload->>'lead_id' = '')
-- @end

-- @assert: FIXTURE no_lead — 1 events('dry_run_send') (default seguro)
SELECT
  'IGOR_05_FIXTURE_no_lead' AS fixture,
  'dry_run_send' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_no_lead'
-- @end

-- =============================================================================
-- FIXTURE compliance_clinical
-- =============================================================================

-- @assert: FIXTURE compliance_clinical — conversation state=human_assigned
SELECT
  'IGOR_05_FIXTURE_compliance_clinical' AS fixture,
  'conversation_human_assigned' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9003
  AND state = 'human_assigned'
  AND ai_enabled = false
  AND human_locked = true
-- @end

-- @assert: FIXTURE compliance_clinical — lead status=aguardando_atendente + handoff_at preenchido
SELECT
  'IGOR_05_FIXTURE_compliance_clinical' AS fixture,
  'lead_aguardando_atendente' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.leads
WHERE id = '00000000-0000-0000-0000-000000000007'::uuid
  AND status = 'aguardando_atendente'
  AND handoff_at IS NOT NULL
-- @end

-- @assert: FIXTURE compliance_clinical — exatamente 1 events('handoff_complete') com handoff_reason=documento_clinico_sensivel
SELECT
  'IGOR_05_FIXTURE_compliance_clinical' AS fixture,
  'handoff_complete_clinical' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_compliance_clinical'
  AND payload->>'handoff_reason' = 'documento_clinico_sensivel'
-- @end

-- @assert: FIXTURE compliance_clinical — 1 events('dry_run_send')
SELECT
  'IGOR_05_FIXTURE_compliance_clinical' AS fixture,
  'dry_run_send' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_compliance_clinical'
-- @end

-- =============================================================================
-- FIXTURE dry_run
-- =============================================================================

-- @assert: FIXTURE dry_run — conversation state=human_assigned
SELECT
  'IGOR_05_FIXTURE_dry_run' AS fixture,
  'conversation_human_assigned' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.conversations
WHERE chatwoot_conversation_id = 9004
  AND state = 'human_assigned'
  AND ai_enabled = false
  AND human_locked = true
-- @end

-- @assert: FIXTURE dry_run — lead status=aguardando_atendente
SELECT
  'IGOR_05_FIXTURE_dry_run' AS fixture,
  'lead_aguardando_atendente' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.leads
WHERE id = '00000000-0000-0000-0000-000000000009'::uuid
  AND status = 'aguardando_atendente'
  AND handoff_at IS NOT NULL
-- @end

-- @assert: FIXTURE dry_run — 1 events('handoff_complete')
SELECT
  'IGOR_05_FIXTURE_dry_run' AS fixture,
  'handoff_complete' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_dry_run'
-- @end

-- @assert: FIXTURE dry_run — exatamente 1 events('dry_run_send') com motivo no payload
SELECT
  'IGOR_05_FIXTURE_dry_run' AS fixture,
  'dry_run_send_reason' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_dry_run'
  AND payload->>'reason' IS NOT NULL
-- @end

-- @assert: FIXTURE dry_run — 0 events('whatsapp_sent')
SELECT
  'IGOR_05_FIXTURE_dry_run' AS fixture,
  'whatsapp_sent' AS event_type,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'whatsapp_sent'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_dry_run'
-- @end

-- =============================================================================
-- Cross-fixture: nenhum fixture escreveu UPDATE em lead que não foi fornecido
-- =============================================================================

-- @assert: FIXTURE no_lead — NÃO existe lead com id placeholder atualizado
-- (essa fixture nunca passa lead_id; se algum lead virou aguardando_atendente
-- com handoff_at no test_run dela, há bug na branch "Has lead_id?")
SELECT
  'IGOR_05_FIXTURE_no_lead' AS fixture,
  'no_lead_update' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_05_FIXTURE_no_lead'
  AND payload->>'lead_id' IS NOT NULL
  AND payload->>'lead_id' <> ''
-- @end
