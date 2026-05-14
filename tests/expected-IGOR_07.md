# expected-IGOR_07 — Error Logger

## Entrada
Payload de erro (estrutura n8n errorTrigger) com `workflow.id`, `workflow.name`,
`execution.id`, `execution.error.message`, `execution.error.stack`, `test_run_id`.

## Resultado esperado em Supabase
Uma nova linha em `public.events`:
- `event_type = 'infra_error'`
- `workflow_name = <do payload>`
- `payload` jsonb com `workflow_id`, `workflow_name`, `execution_id`, `retry_of`,
  `last_node`, `error_message`, `error_stack`, `test_run_id`.

## Sem efeito colateral
Não toca outras tabelas. Não envia mensagens. Não chama outros workflows.

## Quando dispara
Quando outro workflow Igor falha E tem este workflow setado em `errorWorkflow`
nas settings. Não tem trigger manual — para testar, usa fixture via
`scripts/test-workflow.sh` (que simula execução).
