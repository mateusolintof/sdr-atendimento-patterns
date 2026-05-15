# IGOR_04_Tool_Labels_Attributes

## Trigger
`executeWorkflowTrigger` — invocado por outros workflows IGOR via executeWorkflow node.

## Nodes em ordem
1. Execute Workflow Trigger
2. Validate Payload (Code) — coerce types, defaults
3. IF Skip Chatwoot — bypass para testes
4. Chatwoot Get Labels (HTTP GET)
5. Compute Merged Labels (Code)
6. Chatwoot Set Labels (HTTP POST)
7. Log Event (Postgres INSERT events)
8. Success Response (Set) — payload final para o caller

## Comportamento
Recebe labels_to_add / labels_to_remove + chatwoot_conversation_id. GET labels
atuais → merge não destrutivo → POST nova lista completa → INSERT event 'label_added'.

## Skip mode
`_skip_chatwoot_calls: true` pula GET/POST Chatwoot, registra apenas o evento.
Uso: testes isolados sem conversa real no Chatwoot.

## Saída
{ success: true, labels_final: [...], test_run_id }

## TODO v2
- Branch de custom_attributes (conversation + contact) ainda não implementado.
  Adicionar quando IGOR_03/IGOR_05 começarem a usar:
  - POST /api/v1/accounts/2/conversations/{id}/custom_attributes (n8n usa POST,
    não PATCH no Chatwoot)
  - PUT /api/v1/accounts/2/contacts/{cid} para custom_attributes do contato
    (quando chatwoot_contact_id presente)

## Credentials
- igor_chatwoot_api (Header Auth)
- igor_supabase_postgres

## Como testar
bash scripts/test-workflow.sh IGOR_04_Tool_Labels_Attributes fixtures/tool-label-merge.json
