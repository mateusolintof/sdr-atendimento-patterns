# IGOR_TEST_Trampoline

Workflow helper do harness de testes. Recebe um webhook com
`{ target_workflow_id, target_payload }` e invoca o workflow alvo via
`executeWorkflow` node com `workflowId` dinâmico.

## Trigger
`n8n-nodes-base.webhook` — path `igor-test-trampoline`, método `POST`.

URL pública: `${N8N_WEBHOOK_URL}/webhook/igor-test-trampoline`.

## Body esperado
```json
{
  "target_workflow_id": "<id do workflow no n8n>",
  "target_payload": { ... payload arbitrário ... }
}
```

## Nodes em ordem
1. **Trampoline Webhook** (`webhook`, typeVersion 2).
2. **Reshape To Target Payload** (`set`, typeVersion 3.4, mode `raw`,
   `jsonOutput = {{ $json.body.target_payload }}`) — substitui o item inteiro
   pelo payload do target.
3. **Execute Target Workflow** (`executeWorkflow`, typeVersion 1.2) — invoca
   `workflowId = {{ $('Trampoline Webhook').item.json.body.target_workflow_id }}`
   passando o item reshapeado.

## Conexões
`Trampoline Webhook` → `Reshape To Target Payload` → `Execute Target Workflow`.

## Settings
- `executionOrder`: `v1`.

## Por que existe
A public API do n8n não expõe `POST /workflows/{id}/execute`. Para acionar
workflows com triggers que não são webhook (`executeWorkflowTrigger`,
`scheduleTrigger`, `manualTrigger`), o harness POSTa neste trampoline, que
chama o target via `executeWorkflow` node — mecanismo suportado nativamente.

## Quem usa
`scripts/test-workflow.sh` quando detecta que o trigger primário do workflow
alvo é `executeWorkflowTrigger`, `scheduleTrigger` ou `manualTrigger`.

## Como importar / ativar
```bash
bash scripts/import-workflow.sh n8n/workflows/IGOR_TEST_Trampoline.json
curl -X POST "${N8N_BASE_URL}/api/v1/workflows/<id>/activate" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}"
```
