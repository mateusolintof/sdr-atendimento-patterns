-- Asserts para IGOR_03_Agent_AfterHours (compliance fast-path).
--
-- Fixture: fixtures/agent-after-hours-compliance.json
-- Caminho exercido: safety_flags.clinical=true → IF determinístico
--   → events('agent_routed_to_handoff') por IGOR_03
--   → executa IGOR_05_Finalize_Handoff (callable) com _skip_chatwoot_calls=true
--   → events('handoff_complete') por IGOR_05 com owner_flow='after_hours'.
-- Nenhuma chamada ao LLM ou ao Chatwoot acontece nesse caminho.

-- @assert: IGOR_03 registrou a rota para handoff por compliance
SELECT *
FROM public.events
WHERE event_type = 'agent_routed_to_handoff'
  AND workflow_name = 'IGOR_03_Agent_AfterHours'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'reason' = 'documento_clinico_sensivel'
-- @end

-- @assert: IGOR_05 finalizou o handoff com o handoff_reason recebido do IGOR_03
SELECT *
FROM public.events
WHERE event_type = 'handoff_complete'
  AND workflow_name = 'IGOR_05_Finalize_Handoff'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'handoff_reason' = 'documento_clinico_sensivel'
-- @end

-- @assert: handoff_complete carrega owner_flow='after_hours' (origem IGOR_03)
SELECT *
FROM public.events
WHERE event_type = 'handoff_complete'
  AND workflow_name = 'IGOR_05_Finalize_Handoff'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'owner_flow' = 'after_hours'
-- @end
