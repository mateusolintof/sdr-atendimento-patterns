# expected — IGOR_AUX_update_conversation_state

## Trigger
`executeWorkflowTrigger` invocado pelo trampoline (id `enmJo4zpLEvvfuOH`)
ou por outros workflows IGOR via `executeWorkflow`.

## Entrada (fixture aux-update-conv.json)
```json
{
  "phone": "5562900000002",
  "chatwoot_conversation_id": 9001,
  "chatwoot_inbox_id": 1,
  "state": "ai_after_hours",
  "ai_enabled": true,
  "human_locked": false,
  "current_flow": "after_hours",
  "test_run_id": "<test_run_id>"
}
```

## Comportamento esperado
1. Coerce defaults (string/boolean/null) — campos opcionais aceitam null.
2. UPSERT em `public.contacts` por `phone` → retorna `contact_id`.
3. INSERT em `public.conversations` com `ON CONFLICT (chatwoot_conversation_id) DO UPDATE`
   numa única declaração (CTE), garantindo create-if-missing e update-if-exists
   na mesma transação:
   - Branch INSERT usa `COALESCE($N, default)` para campos opcionais.
   - Branch DO UPDATE usa `COALESCE($N, public.conversations.col)` setando
     apenas os campos não-nulos:
     - `state`
     - `ai_enabled`
     - `human_locked`
     - `current_flow`
     - `updated_at = now()`
4. INSERT em `public.events` com `event_type = 'conversation_state_updated'`
   e payload contendo `test_run_id`, `chatwoot_conversation_id`, `state`,
   `ai_enabled`, `human_locked`, `current_flow`.
5. Retorna `{success: true, chatwoot_conversation_id, test_run_id}` ao caller.

Nota técnica: dois data-modifying CTEs não enxergam o snapshot um do outro
em Postgres, por isso a operação é feita numa única UPSERT em vez de
`INSERT ON CONFLICT DO NOTHING` seguida de `UPDATE`.

## Asserts (3)
1. `events.conversation_state_updated` com `payload.test_run_id = <test_run_id>`.
2. Mesmo evento com `payload.state = 'ai_after_hours'` e
   `payload.current_flow = 'after_hours'`.
3. `conversations` com `chatwoot_conversation_id = 9001`,
   `state = 'ai_after_hours'`, `current_flow = 'after_hours'`.

Observação: `chatwoot_conversation_id` é constante (9001) entre runs porque o
INSERT é `ON CONFLICT DO NOTHING`. A diferenciação por run vive no evento
(`test_run_id` no payload).

## Comando
```bash
bash scripts/test-workflow.sh IGOR_AUX_update_conversation_state fixtures/aux-update-conv.json
```

## Credentials
- `igor_supabase_postgres`
