# IGOR_TEST_Failing_Workflow (canary)

Workflow helper do harness de testes. Sempre falha quando recebe POST,
disparando o `errorWorkflow` configurado em `settings`.

## Trigger
`n8n-nodes-base.webhook` — path `igor-test-canary`, método `POST`.

URL pública: `${N8N_WEBHOOK_URL}/webhook/igor-test-canary`.

## Nodes em ordem
1. **Canary Webhook** (`webhook`, typeVersion 2) — recebe `{ test_run_id, simulated_payload }`.
2. **Force Failure** (`code`, typeVersion 2, JS) — `throw new Error('IGOR canary simulated failure (test_run_id=' + trid + ')')`.

## Conexões
`Canary Webhook` → `Force Failure`.

## Settings
- `errorWorkflow`: `ZrsbaSTlW5bqMEaS` (id do IGOR_07_Error_Logger).
- `executionOrder`: `v1`.

## Por que existe
A public API do n8n não expõe `POST /workflows/{id}/execute`. Para acionar
workflows com `errorTrigger` em testes, este canary recebe um webhook,
falha de propósito, e o n8n dispara automaticamente o errorWorkflow
configurado — que no nosso caso é o IGOR_07_Error_Logger.

## Como o test_run_id atravessa
n8n preserva apenas `{level,tags,description,lineNumber,message,stack}` do
objeto `Error` no payload do errorTrigger (props customizadas são descartadas).
Por isso o canary embute o `test_run_id` na própria mensagem da `Error`.
IGOR_07 captura via `error.message` e os asserts filtram por
`payload->>'error_message' LIKE '%test_run_id%'`.

## Rotação
Se IGOR_07 for reimportado e seu id mudar, atualizar
`settings.errorWorkflow` no JSON desta workflow e reimportar.

## Resposta HTTP
O webhook retorna `HTTP 500` com `{"message":"Error in workflow"}` porque
o Code node falha. `scripts/test-workflow.sh` aceita esse caso específico
como dispatch bem-sucedido para `errorTrigger`.

## Como importar / ativar
```bash
bash scripts/import-workflow.sh n8n/workflows/IGOR_TEST_Failing_Workflow.json
# reativar (import-workflow.sh reseta active=false em updates)
curl -X POST "${N8N_BASE_URL}/api/v1/workflows/<id>/activate" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}"
```
