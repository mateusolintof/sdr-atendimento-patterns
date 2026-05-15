# expected-IGOR_04 — Tool Labels & Attributes (callable)

## Entrada
JSON com chatwoot_conversation_id, labels_to_add, labels_to_remove,
custom_attributes (conversation + contact), test_run_id. Opcional:
`_skip_chatwoot_calls: true` para pular chamadas reais ao Chatwoot
em teste isolado.

## Resultado esperado em Supabase
1 linha em public.events com:
- event_type = 'label_added'
- workflow_name = 'IGOR_04_Tool_Labels_Attributes'
- payload jsonb com chatwoot_conversation_id, added (array), removed (array), test_run_id

## Resultado esperado em Chatwoot (quando NÃO em modo skip)
- Labels da conversa = união (atuais ∪ to_add) \ to_remove
- custom_attributes da conversa atualizados (merge não destrutivo)
- custom_attributes do contato atualizados (se chatwoot_contact_id presente)

## Saída ao caller
{ success: true, labels_final: [...], test_run_id }

## Sem efeito colateral
Não envia mensagens. Não chama outros workflows.

## Skip mode (testes)
`_skip_chatwoot_calls: true` na entrada pula GET/POST Chatwoot e
vai direto ao INSERT events. Em produção esse campo NÃO vem.
