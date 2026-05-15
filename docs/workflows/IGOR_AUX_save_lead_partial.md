# IGOR_AUX_save_lead_partial

## Trigger
`executeWorkflowTrigger` — callable invocado por outros workflows IGOR via
`executeWorkflow`. Para testes vai via trampoline (`igor-test-trampoline`).

## Workflow id
`hRogDlGsgQxGwnD8` (n8n self-hosted).

## Nodes em ordem
1. Execute Workflow Trigger — `workflowInputs.values`: `contact_id`, `phone`,
   `source`, `external_id`, `objective`, `city`, `callback_period`,
   `kommo_data`, `test_run_id`.
2. Validate Payload (Code) — coerce strings, garante `kommo_data` como objeto,
   pré-serializa `kommo_data_json` para o Postgres node.
3. Upsert Contact + Lead (Postgres `executeQuery`) — CTE única:
   - `INSERT INTO public.contacts (phone) ON CONFLICT (phone) DO UPDATE`
   - `INSERT INTO public.leads (contact_id, source, external_id, objective,
     city, callback_period, kommo_data) ON CONFLICT (source, external_id) DO
     UPDATE SET objective, city, callback_period, kommo_data, updated_at`
   - Retorna `lead_id, contact_id`.
4. Shape Event Payload (Code) — monta `event_payload_json` com `lead_id`,
   `contact_id`, `source`, `external_id`, `test_run_id`.
5. Log Event (Postgres `executeQuery`) — `INSERT INTO public.events
   (event_type, workflow_name, payload) VALUES ('lead_saved_partial',
   'IGOR_AUX_save_lead_partial', $1::jsonb)`.
6. Success Response (Set) — `{ success: true, lead_id, test_run_id }`.

## Comportamento
UPSERT idempotente:
- contato é criado ou encontrado por `phone` (unique).
- lead é criado ou atualizado por `(source, external_id)` (unique).
- `contact_id` no payload tem precedência sobre o lookup por phone; quando
  vazio, usa o id retornado pelo upsert de contacts.

## Saída
```json
{ "success": true, "lead_id": "<uuid>", "test_run_id": "<uuid>" }
```

## Credentials
- `igor_supabase_postgres` (Postgres direct via session pooler).

## Como testar
```bash
bash scripts/test-workflow.sh <workflow_id>
```

Esperado: 3 asserts ✓ (events.lead_saved_partial, leads UPSERT, JOIN
contacts↔leads por phone).

## Settings
- `executionOrder: v1`
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).

## Notas de implementação
- O Postgres node v2.6 do n8n exige `queryReplacement` como **array JS**
  (não JSON-stringified). Cada elemento mapeia para `$N` em ordem.
- `kommo_data_json` é pré-serializado no Code node anterior para evitar
  ambiguidade no cast `::jsonb`.
- `COALESCE(NULLIF($2,'')::uuid, ct.id)` permite `contact_id` opcional sem
  quebrar quando vazio.
