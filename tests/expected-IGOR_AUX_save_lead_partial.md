# expected — IGOR_AUX_save_lead_partial

## Trigger
`executeWorkflowTrigger` invocado pelo trampoline (id `enmJo4zpLEvvfuOH`)
ou por outros workflows IGOR via `executeWorkflow`.

## Entrada (fixture aux-save-lead.json)
```json
{
  "contact_id": null,
  "phone": "5562900000001",
  "source": "kommo_test_<test_run_id>",
  "external_id": "test-ext-001",
  "objective": "Emagrecimento — TEST <test_run_id>",
  "city": "Salvador-BA",
  "callback_period": "tarde",
  "kommo_data": {"urgencia": "media", "test_run_id": "<test_run_id>"},
  "test_run_id": "<test_run_id>"
}
```

## Comportamento esperado
1. Coerce defaults (`kommo_data` como objeto, `contact_id` opcional).
2. Numa única query Postgres:
   - UPSERT em `public.contacts` por `phone` → retorna `contact_id`.
   - UPSERT em `public.leads` por `(source, external_id)` setando
     `objective`, `city`, `callback_period`, `kommo_data`, `updated_at = now()`.
3. INSERT em `public.events` com `event_type = 'lead_saved_partial'` e
   payload contendo `lead_id`, `contact_id`, `source`, `external_id`, `test_run_id`.
4. Retorna `{lead_id, success: true, test_run_id}` ao caller.

## Asserts (3)
1. `events.lead_saved_partial` com `payload.test_run_id = <test_run_id>`.
2. `leads` com `kommo_data.test_run_id = <test_run_id>`, `source LIKE 'kommo_test_%'`,
   `external_id = 'test-ext-001'`.
3. JOIN `contacts ↔ leads` com `phone = '5562900000001'` e o mesmo `test_run_id`.

## Comando
```bash
bash scripts/test-workflow.sh IGOR_AUX_save_lead_partial fixtures/aux-save-lead.json
```

## Credentials
- `igor_supabase_postgres`
