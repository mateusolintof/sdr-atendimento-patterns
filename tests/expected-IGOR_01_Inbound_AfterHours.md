# Expected behavior — IGOR_01_Inbound_AfterHours (v1)

Webhook POST `/webhook/igor/inbound` que recebe payload Evolution `MESSAGES_UPSERT`,
aplica matriz de bloqueio determinístico e (no caminho feliz) registra evento
`inbound_routed` apontando para IGOR_03.

## Matriz de bloqueio (ordem)

1. `data.key.fromMe === true` → `events('inbound_blocked', reason='from_me')` + 200 NoOp.
2. `settings.ai_enabled_global === false` → `events('inbound_blocked', reason='ai_disabled_global')` + 200 NoOp.
3. `settings.workflows_enabled.IGOR_01 === false` → `events('inbound_blocked', reason='workflow_disabled')` + 200 NoOp.
4. Phone (regex `^55\d{11}$`) inválido → `events('inbound_blocked', reason='invalid_phone')` + 200 NoOp.
5. Janela DE EXPEDIENTE (hora ∈ [end, start)) → `events('inbound_blocked', reason='within_hours')` + 200 NoOp.
6. Lookup `conversations.human_locked` ou `ai_enabled=false` → `events('inbound_blocked', reason='conversation_locked')` + 200 NoOp.
7. Caminho feliz → `events('inbound_routed', target_workflow='IGOR_03', current_flow='after_hours')` + 200.

TODOs v2 documentados em `docs/workflows/IGOR_01_Inbound_AfterHours.md`.

## Test seam: `_test_hour_override`

Inteiro 0-23 no payload força a hora avaliada. Permite testar after-hours sem
esperar 18:30. Em produção nunca vem (e seria ignorado se viesse — adicione
guard em wave de hardening).

## Cenários

### 1. After-hours happy (`evolution-text-after-hours.json`)

- `_test_hour_override=22` (após 18:30 → after-hours).
- `fromMe=false`, phone `5562000900001` válido.
- conversation `7001` não existe em DB → não está locked.
- **Esperado**: 1 evento `inbound_routed` em `public.events` com:
  - `payload->>'test_run_id' = TEST_RUN_ID`
  - `payload->>'target_workflow' = 'IGOR_03'`
  - `payload->>'current_flow' = 'after_hours'`
  - `payload->>'phone' = '5562000900001'`

### 2. fromMe (`evolution-fromme.json`)

- `fromMe=true` → bloqueio na primeira condição.
- **Esperado**: 1 evento `inbound_blocked` com `payload->>'reason'='from_me'`.
  Smoke test deste cenário é manual.

### 3. Within-hours (`evolution-within-hours.json`)

- `_test_hour_override=10` (entre 07:30 e 18:30 → expediente humano).
- **Esperado**: 1 evento `inbound_blocked` com `payload->>'reason'='within_hours'`.
  Smoke test deste cenário é manual.

## Smoke test canônico

```bash
bash scripts/test-workflow.sh IGOR_01_Inbound_AfterHours fixtures/evolution-text-after-hours.json
```

3 asserts ✓ (todos contra `public.events` filtrando por `test_run_id`).

## Pré-requisitos

- `public.settings.workflows_enabled.IGOR_01 = true` no Supabase.
- `public.settings.ai_enabled_global = true`.
- Workflow ativo no n8n.
