# IGOR_05_Finalize_Handoff

Callable que finaliza handoff humano em uma conversa Chatwoot.

## Trigger
`executeWorkflowTrigger` — invocado por outros workflows IGOR
(IGOR_01 / IGOR_03 / IGOR_12 / IGOR_13) via executeWorkflow node.

## Entrada (workflowInputs)
- `phone` (string)
- `chatwoot_conversation_id` (number, obrigatório)
- `chatwoot_inbox_id` (number, default 1)
- `chatwoot_contact_id` (number, opcional)
- `lead_id` (string uuid, opcional)
- `handoff_reason` (string — ex: `after_hours_callback`, `documento_clinico_sensivel`, `imagem_sensivel`, `promo_interested`)
- `summary` (string — texto curto da private note)
- `callback_period` (string, opcional — `manhã`, `tarde`, `noite`, etc.)
- `owner_flow` (string — `after_hours` | `campaign`)
- `nome` (string, opcional)
- `test_run_id` (string)
- `_skip_chatwoot_calls` (boolean, default false)

## Nodes em ordem
1. Execute Workflow Trigger
2. Validate Payload (Code) — coerce types, defaults
3. Upsert Contact + Conversation (human_assigned) (Postgres CTE):
   - UPSERT `contacts` por phone
   - UPSERT `conversations`: `state='human_assigned'`, `ai_enabled=false`,
     `human_locked=true`, `assigned_team_id=1`, `current_flow=owner_flow`
4. IF Skip Chatwoot — bypass para testes
5. (false branch) Chatwoot POST Private Note (HTTP POST `/messages` com `private:true`)
6. (false branch) Chatwoot POST Assignment (HTTP POST `/assignments` com `team_id:1`)
7. Shape Handoff Event (Code) — monta jsonb payload
8. Log Handoff Complete (Postgres INSERT events `handoff_complete`)
9. Build Final Message (Code) — aplica template after-hours Opção A
   com fallback `{nome}→Obrigada`, `{callback_period}→o quanto antes`
10. Log Dry Run Send (Postgres INSERT events `dry_run_send`)
11. Success Response (Set) — `{success: true, test_run_id}` ao caller

## Comportamento
Executa em sequência:
1. Marca conversa como `human_assigned`, desliga IA, trava human_locked.
2. Posta private note + assignment no Chatwoot (skip mode pula).
3. Registra `events('handoff_complete')` com `handoff_reason`,
   `owner_flow`, `summary`, `callback_period`, `lead_id`, `nome`,
   `test_run_id`.
4. Gera texto final ao lead (template Opção A §13.9) e registra
   `events('dry_run_send')` — envio real Evolution adiado para v2
   (gated por `ALLOW_REAL_WHATSAPP_SEND`).

## Skip mode
`_skip_chatwoot_calls: true` pula POST private note + POST assignment.
Uso: testes isolados sem conversa real no Chatwoot. Em produção esse
campo não vem.

## Saída
`{ success: true, test_run_id }`

## TODO v2
- Substituir `dry_run_send` por IF gating em `ALLOW_REAL_WHATSAPP_SEND`
  + chamada real Evolution `sendText`.
- UPDATE `leads.status='aguardando_atendente'` + `leads.handoff_at=now()`
  quando `lead_id` presente.
- Chamada explícita para IGOR_04 com labels
  `['handoff_done','ai_disabled','aguardando_atendente']` quando
  NÃO em skip mode (atualmente IGOR_04 é chamado pelo caller IGOR_01
  antes do IGOR_05).

## Credentials
- `igor_chatwoot_api` (Header Auth)
- `igor_supabase_postgres`

## Como testar
```
bash scripts/test-workflow.sh IGOR_05_Finalize_Handoff fixtures/finalize-handoff-trigger.json
```

## Workflow ID
`xHorZFRZYAaklR1F` (ativo).
