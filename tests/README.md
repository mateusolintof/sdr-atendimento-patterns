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
