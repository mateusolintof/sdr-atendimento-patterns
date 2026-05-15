-- =============================================================================
-- asserts — IGOR_03_Agent_AfterHours
-- =============================================================================
-- Cada fixture popula `events.payload->>'test_run_id'` com `IGOR_03_FIXTURE_*`.
-- Fase C executa o workflow via execute_workflow MCP com cada fixture e roda
-- estes asserts. Espera-se que cada assert retorne EXATAMENTE 1 linha com
-- `actual = expected`.
--
-- Preconditions (rodar antes de smoke):
--   - conversations rows com chatwoot_conversation_id IN
--     (9301, 9302, 9303, 9304, 9305, 9306, 9307) existem
--     (state=ai_after_hours, ai_enabled=true, human_locked=false).
--   - chatwoot_conversation_id é integer no schema.
--   - Credenciais n8n existem: igor_openai, igor_supabase_postgres,
--     igor_chatwoot_api, igor_evolution_api.
--   - Tabelas n8n_chat_histories existem (criada automaticamente pelo
--     memoryPostgresChat se ausente).
--
-- Send-gate semantics:
--   - Default seguro: ALLOW_REAL_WHATSAPP_SEND=false ou IGOR_DRY_RUN=true →
--     reply path loga events('dry_run_send') em vez de Evolution sendText.
--   - Real: ALLOW_REAL_WHATSAPP_SEND=true E IGOR_DRY_RUN=false →
--     events('whatsapp_sent') existe; events('dry_run_send') NÃO. Os asserts
--     abaixo assumem o default seguro (dry).
--
-- Branch contract:
--   - should_handoff=true ou safety_flags.clinical/sensitive_image/payment_proof
--     true  →  COMPLIANCE fast-path: agent SKIPPED, IGOR_05 chamado direto,
--     ZERO events('agent_response').
--   - caso contrário  →  AGENT branch: events('after_hours_started') +
--     events('agent_response') (1+ por mensagem fragmentada), reply path
--     executado (presence + send-gate + log).
-- =============================================================================


-- =============================================================================
-- FIXTURE first_message_text
-- =============================================================================

-- @assert: FIXTURE first_message_text — exatamente 1 events('after_hours_started')
SELECT
  'IGOR_03_FIXTURE_first_message_text' AS fixture,
  'after_hours_started' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_first_message_text'
-- @end

-- @assert: FIXTURE first_message_text — pelo menos 1 events('agent_response')
SELECT
  'IGOR_03_FIXTURE_first_message_text' AS fixture,
  'agent_response_present' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'agent_response'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_first_message_text'
-- @end

-- @assert: FIXTURE first_message_text — pelo menos 1 events('dry_run_send') no reply path (default seguro)
SELECT
  'IGOR_03_FIXTURE_first_message_text' AS fixture,
  'dry_run_send_present' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_first_message_text'
  AND payload->>'origin_workflow' = 'IGOR_03_Agent_AfterHours'
-- @end

-- @assert: FIXTURE first_message_text — ZERO events('agent_routed_to_handoff') (não é compliance)
SELECT
  'IGOR_03_FIXTURE_first_message_text' AS fixture,
  'agent_routed_to_handoff_absent' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'agent_routed_to_handoff'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_first_message_text'
-- @end


-- =============================================================================
-- FIXTURE compliance_fast_path
-- =============================================================================

-- @assert: FIXTURE compliance_fast_path — exatamente 1 events('agent_routed_to_handoff')
SELECT
  'IGOR_03_FIXTURE_compliance_fast_path' AS fixture,
  'agent_routed_to_handoff' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'agent_routed_to_handoff'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_compliance_fast_path'
-- @end

-- @assert: FIXTURE compliance_fast_path — agent_routed_to_handoff payload preserva handoff_reason
SELECT
  'IGOR_03_FIXTURE_compliance_fast_path' AS fixture,
  'agent_routed_to_handoff_payload' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'agent_routed_to_handoff'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_compliance_fast_path'
  AND payload->>'handoff_reason' = 'documento_clinico_sensivel'
  AND (payload->'safety_flags'->>'clinical')::boolean = true
-- @end

-- @assert: FIXTURE compliance_fast_path — exatamente 1 events('handoff_complete') via IGOR_05 down-call
SELECT
  'IGOR_03_FIXTURE_compliance_fast_path' AS fixture,
  'handoff_complete_via_IGOR_05' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_compliance_fast_path'
  AND payload->>'owner_flow' = 'after_hours'
-- @end

-- @assert: FIXTURE compliance_fast_path — ZERO events('agent_response') (agent foi pulado)
SELECT
  'IGOR_03_FIXTURE_compliance_fast_path' AS fixture,
  'agent_response_absent' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'agent_response'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_compliance_fast_path'
-- @end

-- @assert: FIXTURE compliance_fast_path — ZERO events('after_hours_started') (compliance pula start de conversa)
SELECT
  'IGOR_03_FIXTURE_compliance_fast_path' AS fixture,
  'after_hours_started_absent' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_compliance_fast_path'
-- @end


-- =============================================================================
-- FIXTURE collecting_name_response
-- =============================================================================

-- @assert: FIXTURE collecting_name_response — 1 events('after_hours_started')
SELECT
  'IGOR_03_FIXTURE_collecting_name_response' AS fixture,
  'after_hours_started' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_name_response'
-- @end

-- @assert: FIXTURE collecting_name_response — pelo menos 1 agent_response
SELECT
  'IGOR_03_FIXTURE_collecting_name_response' AS fixture,
  'agent_response_present' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'agent_response'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_name_response'
-- @end

-- @assert: FIXTURE collecting_name_response — leads row criada via save_lead_partial tool (objective NULL ainda, mas contact phone existe)
-- Observação: a tool save_lead_partial é dirigida pelo modelo. Se o modelo chamar a tool extraindo
-- "Ana Carolina" como name, o lead row vai existir. O assert checa o efeito colateral mais robusto:
-- events('lead_saved_partial') emitido pelo AUX downstream.
SELECT
  'IGOR_03_FIXTURE_collecting_name_response' AS fixture,
  'lead_saved_partial_present' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'lead_saved_partial'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_name_response'
-- @end


-- =============================================================================
-- FIXTURE collecting_objective
-- =============================================================================

-- @assert: FIXTURE collecting_objective — 1 events('after_hours_started')
SELECT
  'IGOR_03_FIXTURE_collecting_objective' AS fixture,
  'after_hours_started' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_objective'
-- @end

-- @assert: FIXTURE collecting_objective — leads.objective populado via save_lead_partial
SELECT
  'IGOR_03_FIXTURE_collecting_objective' AS fixture,
  'lead_objective_persisted' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.leads l
WHERE EXISTS (
  SELECT 1 FROM public.events e
  WHERE e.event_type = 'lead_saved_partial'
    AND e.payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_objective'
    AND (e.payload->>'lead_id')::text = l.id::text
)
  AND l.objective IS NOT NULL
  AND l.objective <> ''
-- @end


-- =============================================================================
-- FIXTURE collecting_callback
-- =============================================================================

-- @assert: FIXTURE collecting_callback — 1 events('after_hours_started')
SELECT
  'IGOR_03_FIXTURE_collecting_callback' AS fixture,
  'after_hours_started' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_callback'
-- @end

-- @assert: FIXTURE collecting_callback — leads.callback_period populado via save_lead_partial
SELECT
  'IGOR_03_FIXTURE_collecting_callback' AS fixture,
  'lead_callback_persisted' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.leads l
WHERE EXISTS (
  SELECT 1 FROM public.events e
  WHERE e.event_type = 'lead_saved_partial'
    AND e.payload->>'test_run_id' = 'IGOR_03_FIXTURE_collecting_callback'
    AND (e.payload->>'lead_id')::text = l.id::text
)
  AND l.callback_period IS NOT NULL
  AND l.callback_period <> ''
-- @end


-- =============================================================================
-- FIXTURE handoff_ready
-- =============================================================================

-- @assert: FIXTURE handoff_ready — 1 events('after_hours_started')
SELECT
  'IGOR_03_FIXTURE_handoff_ready' AS fixture,
  'after_hours_started' AS event_type,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'after_hours_started'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_handoff_ready'
-- @end

-- @assert: FIXTURE handoff_ready — 1 events('handoff_complete') via IGOR_05 down-call (tool request_handoff)
SELECT
  'IGOR_03_FIXTURE_handoff_ready' AS fixture,
  'handoff_complete_via_tool' AS check_name,
  count(*) AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'handoff_complete'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_handoff_ready'
-- @end


-- =============================================================================
-- FIXTURE dry_run_mode
-- =============================================================================

-- @assert: FIXTURE dry_run_mode — events('dry_run_send') emitidos no reply path
SELECT
  'IGOR_03_FIXTURE_dry_run_mode' AS fixture,
  'dry_run_send_present' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_dry_run_mode'
  AND payload->>'origin_workflow' = 'IGOR_03_Agent_AfterHours'
-- @end

-- @assert: FIXTURE dry_run_mode — ZERO events('whatsapp_sent') no default seguro
SELECT
  'IGOR_03_FIXTURE_dry_run_mode' AS fixture,
  'whatsapp_sent_absent' AS check_name,
  count(*) AS actual,
  0 AS expected
FROM public.events
WHERE event_type = 'whatsapp_sent'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_dry_run_mode'
  AND payload->>'origin_workflow' = 'IGOR_03_Agent_AfterHours'
-- @end

-- @assert: FIXTURE dry_run_mode — dry_run_send payload preserva motivo do gate
SELECT
  'IGOR_03_FIXTURE_dry_run_mode' AS fixture,
  'dry_run_send_payload_reason' AS check_name,
  (count(*) >= 1)::int AS actual,
  1 AS expected
FROM public.events
WHERE event_type = 'dry_run_send'
  AND payload->>'test_run_id' = 'IGOR_03_FIXTURE_dry_run_mode'
  AND payload ? 'reason'
  AND payload->>'mode' = 'dry'
-- @end
