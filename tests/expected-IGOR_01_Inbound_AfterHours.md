# Expected — IGOR_01_Inbound_AfterHours

**Workflow id n8n**: `nC6ZhCVNn1fQiKfB`
**Webhook**: `POST {N8N_BASE_URL}/webhook/igor/inbound` (path `igor/inbound`, response lastNode 200).
**Source-of-truth**: `n8n/workflows/IGOR_01_Inbound_AfterHours.json` + `n8n/workflows/IGOR_01_Inbound_AfterHours.sdk.ts`.

## Contrato — payload Evolution MESSAGES_UPSERT

```json
{
  "event": "messages.upsert",
  "instance": "dr_igor",
  "data": {
    "key": { "id": "<msgId>", "remoteJid": "<55DDDxxxxxxxx>@s.whatsapp.net", "fromMe": false },
    "messageType": "conversation|audioMessage|imageMessage|documentMessage|videoMessage|pttMessage|extendedTextMessage|documentWithCaptionMessage",
    "message": { ... },
    "messageTimestamp": <unix>,
    "pushName": "<nome>"
  },
  "chatwoot_conversation_id": <int>,
  "chatwoot_contact_id": <int|null>,
  "additional_attributes": { "test_run_id": "<id>" }
}
```

## Matriz determinística — 12 condições em ORDEM

| # | Condição | Bloqueia em | events('inbound_blocked', reason=) | Downstream se passar |
|---|---|---|---|---|
| 1 | `data.key.fromMe === true` | NoOp + log | `fromMe` | — |
| 2 | `settings.ai_enabled_global === false` | NoOp + log | `ai_disabled_global` | — |
| 3 | `settings.workflows_enabled.IGOR_01 === false` | NoOp + log | `workflow_disabled` | — |
| 4 | phone inválido (regex `^55\d{2}9\d{8}$` após strip) | NoOp + events('invalid_phone') | — | — |
| 5 | `contacts.do_not_contact === true` | call IGOR_04 labels=['optout'] + log | `opt_out` | — |
| 6 | `conversations.human_locked OR ai_enabled=false` | NoOp + log | `human_locked_or_ai_disabled` | — |
| 7 | `campaign_contacts.status IN ('sent','delivered','replied','interested')` | rota → events('campaign_routed_pending_IGOR_12') | `campaign_routed_pending_IGOR_12` (placeholder) | IGOR_12 (futuro) |
| 8 | hora atual ∈ business hours (entre `after_hours_end` e `after_hours_start` em `timezone`) | NoOp + log | `inside_hours` | — |
| 9 | data ∈ `settings.holidays` | events('holiday_policy_applied'); `holiday_policy='after_hours_force'` força fluxo after_hours | — | continua |
| 10 | Redis lock `igor:lock:inbound:{phone}` via INCR + EXPIRE 30. counter≠1 → fragment batch (RPUSH + EXPIRE 60 via marker + events('inbound_batched')) | NoOp branch batched | `lock_held` | — |
| 11 | `messageType ≠ text` → executeWorkflow IGOR_02 (`GBmG9WZzW2p8Nn6f`) | — | — | IGOR_02 + merge text |
| 12 | UPSERT conversations(state='ai_after_hours') + UPSERT messages + executeWorkflow IGOR_04 (`AJF7dhGrqJEXMLqz`) labels=['fora_expediente'] + events('inbound_routed_pending_IGOR_03') + Redis DEL lock | — | — | IGOR_03 (Wave 4 placeholder) |

## Matriz fixture × condição × downstream

| fixture | bloqueia em | events('inbound_blocked', reason=) | events extra | downstream | response.branch |
|---|---|---|---|---|---|
| `IGOR_01_text_afterhours` | — | — | inbound_received, inbound_routed_pending_IGOR_03 | IGOR_04 (fora_expediente) + IGOR_03 placeholder | `routed_ai_after_hours` |
| `IGOR_01_text_inside_hours` | 8 | inside_hours | inbound_received | — | `blocked_inside_hours` |
| `IGOR_01_fromme` | 1 | fromMe | inbound_received | — | `blocked_fromMe` |
| `IGOR_01_invalid_phone` | 4 | (via events.invalid_phone) | inbound_received, invalid_phone | — | `blocked_invalid_phone` |
| `IGOR_01_optout` (pré: contacts.do_not_contact=true) | 5 | opt_out | inbound_received | IGOR_04 (label optout) | `blocked_opt_out` |
| `IGOR_01_human_locked` (pré: conversations.human_locked=true) | 6 | human_locked_or_ai_disabled | inbound_received | — | `blocked_human_locked_or_ai_disabled` |
| `IGOR_01_campaign_active` (pré: campaign_contacts.status='sent') | 7 | (rota) | inbound_received, campaign_routed_pending_IGOR_12 | (IGOR_12 placeholder) | `campaign_routed_pending_IGOR_12` |
| `IGOR_01_audio_afterhours` | — | — | inbound_received, inbound_routed_pending_IGOR_03 (message_type=audio) | IGOR_02 (audio) + IGOR_04 + IGOR_03 placeholder | `routed_ai_after_hours` |
| `IGOR_01_holiday` (pré: settings.holidays inclui hoje) | — | — | inbound_received, holiday_policy_applied, inbound_routed_pending_IGOR_03 | IGOR_04 + IGOR_03 placeholder | `routed_ai_after_hours` |
| `IGOR_01_batch_lock_held` (pré: lock Redis ou POST prévio do mesmo phone) | 10 (no-lock branch) | lock_held | inbound_received, inbound_batched | — | `batched_lock_held` |

## Settings esperados em produção

```sql
INSERT INTO public.settings (key, value) VALUES
  ('ai_enabled_global',   'true'::jsonb),
  ('workflows_enabled',   '{"IGOR_01": true, "IGOR_03": true, "IGOR_10": true}'::jsonb),
  ('after_hours_start',   '"19:00"'::jsonb),
  ('after_hours_end',     '"08:00"'::jsonb),
  ('timezone',            '"America/Sao_Paulo"'::jsonb),
  ('holidays',            '[]'::jsonb),
  ('holiday_policy',      '"after_hours_force"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

## Pattern Redis lock+batching (substituto NX-EX atômico)

n8n Redis node v1 SET não expõe NX nem EX. Substituto atômico:
1. `INCR igor:lock:inbound:{phone}` com `expire=true, ttl=30`. Retorna o counter atual.
2. Code "Eval Lock Result" lê o retorno. Se `counter === 1` → got lock; else → batch.
3. **Batch branch (no-lock)**: `RPUSH igor:batch:{phone} <fragment_payload_json>`; `INCR igor:batch:marker:{phone}` com `expire=true, ttl=60` para garantir TTL na lista (workaround n8n Redis v1 sem EXPIRE direto). events('inbound_batched', reason='lock_held'). NoOp end.
4. **Got-lock branch**: `wait 3s` → `Redis Get igor:batch:{phone} keyType=list` (LRANGE 0 -1) → `Redis DEL igor:batch:{phone}` → Code "Merge Fragments" consolida frags anteriores + mensagem atual.
5. Final do happy path: `Redis DEL igor:lock:inbound:{phone}` (release).

Janela de race: 3s para fragmentos chegarem após primeiro fragment + 30s TTL no lock.

## Forward dependencies (placeholders)

- **IGOR_03_Agent_AfterHours** (Wave 4 do plano): atualmente referenciado apenas por events('inbound_routed_pending_IGOR_03') no final do happy path. Quando criado, substituir o `INSERT inbound_routed_pending_IGOR_03` por um `executeWorkflow` node apontando para o workflowId de IGOR_03 (campos: phone, msg_id, chatwoot_conversation_id, chatwoot_contact_id, normalized_text, safety_flags, should_handoff, handoff_reason, fragments_count).
- **IGOR_12_Campaign_Inbound_Handler** (fase Campanha): atualmente referenciado por events('campaign_routed_pending_IGOR_12'). Quando criado, substituir por `executeWorkflow` apontando para IGOR_12.

## Response body do webhook

`{ ok: boolean, blocked?: boolean, branch: string, reason?: string, blocked_at_condition?: int, downstream_calls?: string[] }`

Branches finais:
- `blocked_fromMe`, `blocked_ai_disabled_global`, `blocked_workflow_disabled`, `blocked_invalid_phone`, `blocked_opt_out`, `blocked_human_locked_or_ai_disabled`, `campaign_routed_pending_IGOR_12`, `blocked_inside_hours`, `batched_lock_held`, `routed_ai_after_hours`.
