# IGOR_07_Error_Logger

## Trigger
`n8n-nodes-base.errorTrigger` — disparado automaticamente quando workflows Igor
com `errorWorkflow` setado para este falham.

## Nodes em ordem
1. **Error Trigger** — recebe payload com workflow/execution/error.
2. **Insert Event** (Postgres `executeQuery`) — INSERT into events.

## Conexões
Error Trigger → Insert Event.

## Mutações produzidas
- `public.events` ganha 1 row com `event_type='infra_error'`.

## Credentials usadas
- `igor_supabase_postgres` (Postgres, Session Pooler)

## Como outros workflows acionam
Outros workflows IGOR_* declaram `settings.errorWorkflow = <id de IGOR_07>`
após importação. Esse setting é feito pelo orquestrador na fase de wiring
(não nesta task).

## Como testar localmente
`bash scripts/test-workflow.sh <workflow_id>
