# IGOR_08_Health_Check

**Status**: built — INACTIVE (manual activation pending after Fase C smoke).
**Build date**: 2026-05-15.
**n8n ID**: `cDpDA1QdIH9wHAlN`.
**URL**: `https://n8n.almaconvert.com.br/workflow/cDpDA1QdIH9wHAlN`.
**Branch**: `main` (worktree `agent-aa93953c4699cf825`).

## Purpose

Operational dashboard source. Schedule cron `*/10 * * * *` executes 5 parallel
service pings + 24h business counts + race detection + orphan batches detector
and writes a structured `events('health_check')` row. When `overall_status`
flips to `critical`, an additional `events('health_alert')` row is appended.

This is **not** a synthetic monitoring tool, **not** an alert dispatcher. It
produces the rows the on-call dashboards / future alarms read. No external
notification side effects.

## Architecture

```
Every 10 Minutes (scheduleTrigger)
    -> Init Snapshot (code)
        -> fan-out (5 parallel branches, all read-only):
              n8n Ping        -> Capture n8n        -> Merge Services.input(0)
              Chatwoot Ping   -> Capture Chatwoot   -> Merge Services.input(1)
              Evolution Ping  -> Capture Evolution  -> Merge Services.input(2)
              OpenAI Ping     -> Capture OpenAI     -> Merge Services.input(3)
              Supabase Ping   -> Capture Supabase   -> Merge Services.input(4)
        -> Merge Services (append, numberInputs=5)
            -> fan-out (3 metrics, executeOnce on each):
                  Counts 24h        -> Merge Metrics.input(0)
                  Race Detection    -> Merge Metrics.input(1)
                  Orphan Batches    -> Merge Metrics.input(2)
            -> Merge Metrics (append, numberInputs=3)
                -> Aggregate (code, executeOnce)
                    -> INSERT events health_check
                        -> Is Critical? (if)
                              -> [true]  -> INSERT events health_alert
```

21 nodes total. No subworkflow calls, no LLM nodes, no Wait, no recursion.

## Service pings (5)

| #  | Node             | Method  | Target                                                             | Auth credential       | Outcome semantics                              |
|----|------------------|---------|--------------------------------------------------------------------|-----------------------|------------------------------------------------|
| 1  | n8n Ping         | GET     | `{{ $env.N8N_BASE_URL }}/healthz`                                  | none (public)         | http 2xx -> ok                                 |
| 2  | Chatwoot Ping    | GET     | `{{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ ACCOUNT_ID }}`    | `igor_chatwoot_api`   | http 2xx -> ok                                 |
| 3  | Evolution Ping   | GET     | `{{ $env.EVOLUTION_BASE_URL }}/instance/connectionState/{{ INST }}`| `igor_evolution_api`  | http 2xx + body.instance.state == 'open' -> ok |
| 4  | OpenAI Ping      | GET     | `https://api.openai.com/v1/models`                                 | `igor_openai` (Bearer)| http 2xx -> ok                                 |
| 5  | Supabase Ping    | POSTGRES| `SELECT 1 AS supabase_ok`                                          | `igor_supabase_postgres` | row returned with supabase_ok=1 -> ok       |

Each ping has `continueOnFail: true` so a single dependency outage **does not**
abort the snapshot. Each follow-up `Capture <service>` code node normalizes
to `{service, status, http_code, latency_ms, error?, evolution_state?}` so
the Aggregate node receives a uniform shape.

## Metrics

### Counts 24h

Single Postgres query returning 6 counters: `events_24h`, `infra_errors_24h`,
`opt_outs_24h`, `messages_24h`, `leads_24h`, `campaign_24h`. See literal SQL
in `n8n/workflows/IGOR_08_Health_Check.json` -> node "Counts 24h".

### Race Detection

Postgres query counting conversations with `ai_enabled = true` that
received a `role IN ('agent_human','agent')` message in the **last 10 minutes**.
A non-zero result means IGOR_05's handoff did not flip `ai_enabled=false`
before the human spoke. Any positive value flips `overall_status` to
`critical`.

### Orphan Batches

Redis `KEYS igor:batch:*` (with `getValues=false`) returns the surviving batch
keys. The Aggregate code node walks the returned shape (the n8n Redis node
has historically returned the list as either an object whose keys are the
matched key names, or an array under `json.keys`). The total count above
**5** flips `overall_status` to `critical` — the assumption is `IGOR_01`
pushes with `TTL=60s`, so any batch surviving across a 10-min health
window indicates a Wait node that died without flushing.

## Thresholds

| Trigger                                                  | Effect       |
|----------------------------------------------------------|--------------|
| `counts.infra_errors_24h > 50`                           | degraded     |
| `counts.opt_outs_24h > 20`                               | degraded     |
| Any 1 service `status='fail'`                            | degraded     |
| 2+ services `status='fail'`                              | critical     |
| `race_count > 0`                                         | critical     |
| `orphan_batches_count > 5`                               | critical     |

`critical` strictly wins over `degraded`. Each fired condition is appended
to `payload.threshold_breaches` (string array). All thresholds live in the
Aggregate code node and can be re-tuned by editing the SDK + re-syncing
(no settings-driven externalization for v1).

## Mutations

- INSERT `events ('health_check', payload::jsonb)` — always, exactly once
  per cron tick.
- INSERT `events ('health_alert', payload::jsonb)` — only when
  `overall_status='critical'`. Same payload, different `event_type`.

No mutations on Chatwoot, Evolution, Redis, OpenAI. Read-only on all
third-party deps. The Aggregate node never modifies upstream state, only
read-and-derive.

## Credentials wired (verified post-PATCH)

| Node                         | Credential type    | Credential name           | Wired |
|------------------------------|--------------------|---------------------------|-------|
| n8n Ping                     | none               | —                         | n/a   |
| Chatwoot Ping                | httpHeaderAuth     | `igor_chatwoot_api`       | yes   |
| Evolution Ping               | httpHeaderAuth     | `igor_evolution_api`      | **NO — credential missing on n8n instance; BLOCKED for activation** |
| OpenAI Ping                  | openAiApi          | `igor_openai`             | yes   |
| Supabase Ping                | postgres           | `igor_supabase_postgres`  | yes   |
| Counts 24h                   | postgres           | `igor_supabase_postgres`  | yes   |
| Race Detection               | postgres           | `igor_supabase_postgres`  | yes   |
| Orphan Batches               | redis              | `igor_redis_embedded`     | yes   |
| INSERT events health_check   | postgres           | `igor_supabase_postgres`  | yes   |
| INSERT events health_alert   | postgres           | `igor_supabase_postgres`  | yes   |

## Settings (verified post-PATCH)

```json
{
  "executionOrder": "v1",
  "availableInMCP": true,
  "errorWorkflow": "ZrsbaSTlW5bqMEaS"
}
```

`errorWorkflow` -> `IGOR_07_Error_Logger`. Any uncaught exception in this
workflow will trigger IGOR_07, which logs to `events('infra_error', payload)`.
That means: if `IGOR_08` itself fails, the failure is captured by the same
`events` row stream the health check inspects.

## Tags

`igor`, `infra`, `health-check`, `fase-b-rebuild`.

## Out of scope (deferred to Fase C and beyond)

- External alarm dispatch (Slack / WhatsApp / email / PagerDuty). The
  `health_alert` row is the dashboard hook.
- Auto-remediation (restart Evolution instance, flush orphan batches,
  pause IGOR_01 if Redis is full). Manual triage.
- Per-key TTL inspection for orphan batches. v1 uses raw key count.
  Future enhancement: follow up with `TTL igor:batch:<k>` and only flag
  keys whose TTL exceeds expected lifetime.
- Dynamic threshold tuning via `settings` table. v1 has constants in the
  Aggregate JS code; redeploy required to change.

## Known concerns

- **igor_evolution_api credential missing on n8n instance**. The Evolution
  Ping node is wired to the **name** `igor_evolution_api` but the credential
  was not present on the n8n instance at build time, and attempting to
  create it programmatically was blocked by the harness permission
  classifier (the boundary the user enforced). Activation must wait until
  this credential is provisioned in n8n UI (type `httpHeaderAuth`, header
  name `apikey`, value `EVOLUTION_API_KEY`). Until then, the Evolution
  branch will run with no credential header, hitting Evolution unauth and
  returning 401 -> Capture Evolution flips to `status='fail'` -> the
  workflow still completes and writes the health_check row with one
  service marked as fail (`overall_status='degraded'`).
- **Race detection SQL assumes `messages.role` enum**. The 10-min window is
  short by design — false positives possible if a human reply lands during
  the same minute the handoff completes but before `ai_enabled` is
  flipped. Tighten via a join on `conversations.updated_at >
  messages.created_at` if false positives appear in production.
- **Orphan batches threshold of 5** is a guess. Production should observe
  the baseline during normal traffic and re-tune.
- **No retry on Postgres pings**. A transient connection blip will surface
  as `degraded` for one window. Acceptable for v1; consider a single retry
  with 1s delay if noise.
- **Schedule + Wait combination intentionally absent**. The contract is "fire
  cron, read state, write row". No SplitInBatches, no recursion, no Wait.

## Files

- `n8n/workflows/IGOR_08_Health_Check.json` — canonical post-PATCH JSON.
- `n8n/workflows/IGOR_08_Health_Check.sdk.ts` — SDK source (SOURCE OF TRUTH
  NOTICE in header).
- `tests/expected-IGOR_08_Health_Check.md` — contract description.
- `tests/asserts-IGOR_08_Health_Check.sql` — post-execution assertions.
- `docs/workflows/IGOR_08_Health_Check.md` — this file.

## Activation checklist (Fase C onward)

1. Provision `igor_evolution_api` credential on n8n
   (type `httpHeaderAuth`, name `apikey`, value `EVOLUTION_API_KEY`).
2. Re-run the credential wiring PATCH (or set via n8n UI).
3. Activate workflow.
4. Wait 10-20 minutes.
5. Run `tests/asserts-IGOR_08_Health_Check.sql` against Supabase to confirm
   A1..A7 pass.
6. Inspect `events.payload` to validate `services[*].status` shows 5 oks.
7. Add to the operations dashboard query
   (`events.event_type='health_check' ORDER BY created_at DESC`).
