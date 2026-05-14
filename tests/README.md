# Tests — convenções

Cada workflow tem 3 artefatos versionados:

- `fixtures/<workflow>-<scenario>.json` — payload de entrada
- `tests/asserts-<workflow>.sql` — SELECTs que validam estado pós-execução
- `tests/expected-<workflow>.md` — texto humano: "depois de X, devo ter Y"

## Convenção de `{{TEST_RUN_ID}}`

Tabelas Igor já têm dados reais (137 leads). Para isolar asserts:

1. Cada fixture inclui `{{TEST_RUN_ID}}` em um campo customizado (`test_run_id` em metadata Evolution, ou `payload.test_run_id` em eventos).
2. O workflow propaga esse `test_run_id` ao gravar em `events.payload`, `messages.safety_flags`, etc.
3. `scripts/test-workflow.sh` substitui `{{TEST_RUN_ID}}` por um UUID antes de disparar e antes de rodar asserts.
4. Asserts filtram por esse id — ex: `WHERE payload->>'test_run_id' = '{{TEST_RUN_ID}}'`.

## Formato de `tests/asserts-<workflow>.sql`

Múltiplos asserts num arquivo, separados por marcadores:

```sql
-- @assert: log de erro foi criado
SELECT * FROM events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem campo workflow_name
SELECT * FROM events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'workflow_name' IS NOT NULL
-- @end
```

Cada assert deve retornar **≥1 linha** para passar.

## Formato de `tests/expected-<workflow>.md`

Texto humano descrevendo o que acontece end-to-end. Útil para entender sem ler SQL. Atualizar se o comportamento mudar.

## Dispatch strategy (per-trigger-type)

Como a public API do n8n não expõe `POST /workflows/{id}/execute`, o
`scripts/test-workflow.sh` detecta o tipo de trigger primário do workflow alvo
(via `GET /api/v1/workflows/{id}`) e despacha conforme:

| Trigger | Estratégia | Helper workflow |
|---|---|---|
| `webhook` | POST direto no webhook URL do workflow (`${N8N_WEBHOOK_URL}/webhook/{path}`) | — |
| `errorTrigger` | POST no canary `IGOR_TEST_Failing_Workflow` (path `igor-test-canary`); canary tem `settings.errorWorkflow` setado para o target | `IGOR_TEST_Failing_Workflow` |
| `executeWorkflowTrigger`, `scheduleTrigger`, `manualTrigger` | POST no trampoline `IGOR_TEST_Trampoline` (path `igor-test-trampoline`); trampoline invoca o target via `executeWorkflow` node com workflowId dinâmico | `IGOR_TEST_Trampoline` |

Quando o workflow alvo tem múltiplos triggers, prioridade:
`errorTrigger > executeWorkflowTrigger > scheduleTrigger > webhook > manualTrigger`.

Os 2 helpers (canary + trampoline) ficam permanentemente ativos. Reimportar
qualquer um via `scripts/import-workflow.sh` mantém o estado mas reseta `active`
para `false` — reativar com `POST /api/v1/workflows/{id}/activate`.

### Como o canary propaga `test_run_id`

n8n só preserva `{level,tags,description,lineNumber,message,stack}` do Error no
payload do errorTrigger (props customizadas no objeto Error são descartadas).
Por isso o canary embute o `test_run_id` na própria mensagem do Error:

```
throw new Error('IGOR canary simulated failure (test_run_id=' + trid + ')');
```

IGOR_07 grava esse texto em `events.payload.error_message`. Os asserts
filtram por `payload->>'error_message' LIKE '%{{TEST_RUN_ID}}%'`.

### Rotação do canary errorWorkflow

O canary tem `settings.errorWorkflow` hardcoded para o id do IGOR_07
(`ZrsbaSTlW5bqMEaS` no momento desta documentação). Se IGOR_07 for reimportado
e o id mudar, atualizar `n8n/workflows/IGOR_TEST_Failing_Workflow.json` e
reimportar.

### HTTP 500 no dispatch errorTrigger

O canary é desenhado para falhar, então o webhook retorna `HTTP 500` com
corpo `{"message":"Error in workflow"}`. O `test-workflow.sh` aceita esse
caso específico como dispatch bem-sucedido para `errorTrigger`.

