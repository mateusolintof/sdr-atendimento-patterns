-- @assert: mensagem foi espelhada em public.messages
SELECT *
FROM public.messages
WHERE safety_flags->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: para o caso human, human_assumed event existe
SELECT *
FROM public.events
WHERE event_type = 'human_assumed'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: conversations.human_locked atualizado
SELECT *
FROM public.conversations c
WHERE c.chatwoot_conversation_id = 3
  AND c.human_locked = true
-- @end
