# expected-IGOR_05 — Finalize Handoff (callable)

## Entrada
JSON com `chatwoot_conversation_id`, `chatwoot_contact_id?`, `lead_id?`,
`handoff_reason`, `summary`, `callback_period?`, `owner_flow`, `nome?`,
`phone?`, `chatwoot_inbox_id?`, `test_run_id`. Opcional:
`_skip_chatwoot_calls: true` para pular POSTs reais ao Chatwoot
em teste isolado.

## Resultado esperado em Supabase
1. `public.contacts` — UPSERT por phone (nome merge).
2. `public.conversations` — UPSERT por chatwoot_conversation_id:
   - `state = 'human_assigned'`
   - `ai_enabled = false`
   - `human_locked = true`
   - `assigned_team_id = 1`
   - `current_flow = owner_flow` (after_hours | campaign)
3. `public.events` (linha A): `event_type='handoff_complete'`,
   `workflow_name='IGOR_05_Finalize_Handoff'`, payload jsonb com
   `handoff_reason`, `owner_flow`, `summary`, `callback_period`,
   `lead_id`, `chatwoot_conversation_id`, `nome`, `test_run_id`.
4. `public.events` (linha B): `event_type='dry_run_send'`,
   payload jsonb com `phone`, `final_text`, `target='evolution_sendText'`,
   `test_run_id`.

## Resultado esperado em Chatwoot (quando NÃO em modo skip)
- POST private note `/conversations/{id}/messages` com `message_type: outgoing`,
  `private: true`, content prefixado por "Handoff Igor:\n\n" + summary.
- POST assignment `/conversations/{id}/assignments` com `team_id: 1`.

## Mensagem final ao lead (template after-hours — Opção A §13.9)
```
{nome}, perfeito. Já anotei tudo aqui e a equipe do Dr. Igor vai
te chamar no período que você indicou ({callback_period}) para
seguir o atendimento e ver os próximos passos. Até logo!
```
Fallback: `{nome}` ausente → `Obrigada`. `{callback_period}` ausente
→ `o quanto antes`.

## Saída ao caller
`{ success: true, test_run_id }`

## v2 / TODO
- Substituir `dry_run_send` por IF `ALLOW_REAL_WHATSAPP_SEND=true` +
  chamada real Evolution `sendText`. Atualmente sempre dry-run.
- Atualizar `leads.status='aguardando_atendente'` + `leads.handoff_at=now()`
  quando `lead_id` presente (deferido — a v1 cobre só conversation+events).
- Chamar IGOR_04 com labels `['handoff_done','ai_disabled','aguardando_atendente']`
  quando NÃO em skip mode (deferido — IGOR_04 já é chamado por IGOR_01).
