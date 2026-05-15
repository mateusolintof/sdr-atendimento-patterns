# IGOR_AUX_update_conversation_state

## Trigger
`executeWorkflowTrigger` — callable invocado por outros workflows IGOR via
`executeWorkflow`. Para testes vai via trampoline (`igor-test-trampoline`).

## Workflow id
`mFuRPrGGt7yWVqEw` (n8n self-hosted).

## Nodes em ordem
1. Execute Workflow Trigger — `workflowInputs.values`: `phone`,
   `chatwoot_conversation_id`, `chatwoot_inbox_id`, `state`, `ai_enabled`,
   `human_locked`, `current_flow`, `test_run_id`.
2. Validate Payload (Code) — coerce tipos; produz `ai_enabled_param` e
   `human_locked_param` como string `'true'|'false'|null` para passar pelo
   queryReplacement do Postgres v2.6 sem perder o sinal de NULL.
3. Upsert Contact + Conversation + Update State (Postgres `executeQuery`) —
   CTE única:
   - `INSERT INTO public.contacts (phone) ON CONFLICT (phone) DO UPDATE`
   - `INSERT INTO public.conversations (...) ON CONFLICT
     (chatwoot_conversation_id) DO UPDATE SET ... COALESCE($N, col)` setando
     apenas campos não-nulos (`state`, `ai_enabled`, `human_locked`,
     `current_flow`, `updated_at = now()`).
   - Retorna `id, chatwoot_conversation_id`.
4. Shape Event Payload (Code) — monta `event_payload_json` com `test_run_id`,
   `chatwoot_conversation_id`, `state`, `ai_enabled`, `human_locked`,
   `current_flow`.
5. Log Event (Postgres `executeQuery`) — `INSERT INTO public.events
   (event_type, workflow_name, payload, chatwoot_conversation_id) VALUES
   ('conversation_state_updated', 'IGOR_AUX_update_conversation_state',
   $1::jsonb, $2::integer)`.
6. Success Response (Set) — `{ success: true, chatwoot_conversation_id,
   test_run_id }`.

## Comportamento
UPSERT idempotente em conversations por `chatwoot_conversation_id` (unique):
- se a row não existe, cria com defaults (`state='new'`, `ai_enabled=true`,
  `human_locked=false`) aceitando overrides quando o caller enviar valor.
- se a row existe, faz UPDATE apenas dos campos não-nulos via
  `COALESCE($N, public.conversations.col)`.
- contact é criado ou encontrado por `phone` antes do INSERT em
  conversations (FK obrigatória).

## Saída
```json
{
  "success": true,
  "chatwoot_conversation_id": 9001,
  "test_run_id": "<uuid>"
}
```

## Credentials
- `igor_supabase_postgres` (Postgres direct via session pooler).

## Como testar
```bash
bash scripts/test-workflow.sh IGOR_AUX_update_conversation_state fixtures/aux-update-conv.json
```

Esperado: 3 asserts ✓ (events.conversation_state_updated, payload com
`state`/`current_flow`, conversations com state aplicado).

## Settings
- `executionOrder: v1`
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).

## Notas de implementação
- A operação é uma única CTE com `INSERT ON CONFLICT DO UPDATE` em vez de
  `INSERT ON CONFLICT DO NOTHING` seguido de `UPDATE`: dois data-modifying
  CTEs no mesmo statement não enxergam o snapshot um do outro em Postgres,
  então o UPDATE não encontraria a row recém-criada.
- `ai_enabled` e `human_locked` são passados como string `'true'|'false'|null`
  para preservar o sinal de NULL através do `queryReplacement` (array JS) do
  Postgres node v2.6; o cast `$N::boolean` reconstrói o valor no SQL.
- `chatwoot_conversation_id` é constante (9001) na fixture de teste; a
  diferenciação entre runs vive em `events.payload.test_run_id`.
