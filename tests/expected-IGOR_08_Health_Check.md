# expected-IGOR_08_Health_Check.md

**Workflow**: `IGOR_08_Health_Check`
**Trigger**: Schedule cron `*/10 * * * *` (every 10 minutes).
**LLM**: none.
**Mutations**: INSERT `events('health_check', payload::jsonb)`; conditional INSERT `events('health_alert', payload)` when `overall_status='critical'`.

---

## Purpose

Operational dashboard source. The `events('health_check')` row produced every
10 minutes carries a structured payload describing the live state of the 5
external dependencies + 24h business counts + race-condition / orphan-batch
detectors. Dashboards and on-call rotations read these rows.

This workflow **never sends WhatsApp**, **never touches Chatwoot conversations
mutating state**, **never alters labels**, **never calls any other IGOR_*
workflow**. It is read-only on third-party services and append-only on
`events`.

---

## Services checked (5 parallel pings)

Each ping is wrapped with `continueOnFail: true` so a single dependency
outage never aborts the snapshot. Latency is computed as
`Date.now() - started_at_ms` inside each Capture code node.

| # | Service   | Method  | URL                                                              | Credential               | Expected      |
|---|-----------|---------|------------------------------------------------------------------|--------------------------|---------------|
| 1 | n8n       | GET     | `{{ $env.N8N_BASE_URL }}/healthz`                                | none (public)            | HTTP 200      |
| 2 | Chatwoot  | GET     | `{{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ ACCOUNT_ID }}`  | `igor_chatwoot_api`      | HTTP 200      |
| 3 | Evolution | GET     | `{{ $env.EVOLUTION_BASE_URL }}/instance/connectionState/{{INST}}`| `igor_evolution_api`     | HTTP 200, body.instance.state == "open" |
| 4 | OpenAI    | GET     | `https://api.openai.com/v1/models`                               | `igor_openai` (Bearer)   | HTTP 200      |
| 5 | Supabase  | POSTGRES| `SELECT 1 AS supabase_ok`                                        | `igor_supabase_postgres` | row returned  |

Each Capture code node emits:

```json
{
  "service": "n8n" | "chatwoot" | "evolution" | "openai" | "supabase",
  "status": "ok" | "fail",
  "http_code": 200,
  "latency_ms": 142,
  "error": null | "string-with-truncated-message"
}
```

Evolution adds extra field `evolution_state: "open" | "close" | "connecting"`
parsed from `body.instance.state` (or `body.state` depending on Evolution
version). Any state other than `"open"` flips `status` to `"fail"`.

---

## 24h counts (single Postgres query)

Single round-trip executing six count subqueries:

```sql
SELECT
  (SELECT count(*) FROM public.events
     WHERE created_at > now() - interval '24 hours')                                AS events_24h,
  (SELECT count(*) FROM public.events
     WHERE event_type='infra_error' AND created_at > now() - interval '24 hours')   AS infra_errors_24h,
  (SELECT count(*) FROM public.events
     WHERE event_type='opt_out'     AND created_at > now() - interval '24 hours')   AS opt_outs_24h,
  (SELECT count(*) FROM public.messages
     WHERE created_at > now() - interval '24 hours')                                AS messages_24h,
  (SELECT count(*) FROM public.leads
     WHERE created_at > now() - interval '24 hours')                                AS leads_24h,
  (SELECT count(*) FROM public.campaign_contacts
     WHERE updated_at > now() - interval '24 hours')                                AS campaign_24h
```

---

## Race detection (Postgres)

Detects the bug class **"IA respondeu enquanto humano já tinha assumido"**:

```sql
SELECT count(*)::int AS race_count
FROM public.conversations c
JOIN public.messages m
  ON m.conversation_id = c.id
WHERE c.ai_enabled = true
  AND m.role IN ('agent_human', 'agent')
  AND m.created_at > now() - interval '10 minutes'
```

Any `race_count > 0` is severe — it indicates the `ai_enabled` flag did not
get flipped off before a human agent sent a message, so IGOR would still
respond, contradicting `IGOR_05_Finalize_Handoff` semantics.

---

## Orphan batches (Redis)

```text
KEYS igor:batch:*           (Redis op=keys, getValues=false)
For each key:  TTL key      (computed in Aggregate via received key list — TTL
                            check happens by inspecting current count vs
                            a tolerance threshold)
```

In the SDK implementation the Redis node returns the list of matching keys in
`$json.keys`. The Aggregate code node treats the **count of returned keys**
as the orphan count; production tuning should add a follow-up `TTL` per key
to subtract still-active batches, but for v1 the heuristic is:

- `0 keys`        → healthy.
- `1..5 keys`     → noise (any in-flight batches at this exact moment).
- `> 5 keys`      → critical (Wait nodes are stuck; IGOR_01 batching pipeline
                   is leaking keys without consuming them).

`igor:batch:*` keys are produced by `IGOR_01_Inbound_AfterHours` with TTL
`60s`. A surviving key beyond TTL means the workflow that pushed it died
before consuming.

---

## Payload shape (the INSERT into `events`)

```jsonc
{
  "health_id":            "uuid-v4",
  "started_at":           "2026-05-15T12:30:00.000Z",
  "ended_at":             "2026-05-15T12:30:04.412Z",
  "duration_ms":          4412,
  "services": [
    { "service": "n8n",       "status": "ok",   "http_code": 200, "latency_ms": 38,  "error": null },
    { "service": "chatwoot",  "status": "ok",   "http_code": 200, "latency_ms": 112, "error": null },
    { "service": "evolution", "status": "ok",   "http_code": 200, "latency_ms": 230, "error": null, "evolution_state": "open" },
    { "service": "openai",    "status": "ok",   "http_code": 200, "latency_ms": 412, "error": null },
    { "service": "supabase",  "status": "ok",   "http_code": null,"latency_ms": 87,  "error": null }
  ],
  "counts": {
    "events_24h":        1842,
    "infra_errors_24h":  3,
    "opt_outs_24h":      1,
    "messages_24h":      612,
    "leads_24h":         28,
    "campaign_24h":      0
  },
  "race_count":          0,
  "orphan_batches_count":0,
  "threshold_breaches":  [],
  "overall_status":      "healthy"
}
```

---

## Thresholds → overall_status

Applied inside the **Aggregate** code node. Order: `critical` wins over
`degraded` wins over `healthy`.

| Condition                                                              | Bumps to    |
|------------------------------------------------------------------------|-------------|
| `counts.infra_errors_24h > 50`                                         | `degraded`  |
| `counts.opt_outs_24h > 20`                                             | `degraded`  |
| Any single service `status='fail'`                                     | `degraded`  |
| 2+ services with `status='fail'`                                       | `critical`  |
| `race_count > 0`                                                       | `critical`  |
| `orphan_batches_count > 5`                                             | `critical`  |

`threshold_breaches` is a string array enumerating every condition that
fired, e.g. `["infra_errors_24h>50", "service_fail:evolution", "race"]`.

---

## When `overall_status='critical'`

Additional INSERT into `events`:

```sql
INSERT INTO public.events (event_type, workflow_name, payload)
VALUES ('health_alert', 'IGOR_08_Health_Check', $1::jsonb)
```

No external alarm (PagerDuty, Slack, etc) is wired in this build — the
`health_alert` row is the dashboard's hard-signal hook for the
on-call rotation to consume. External alarms are explicitly out of scope
(Fase C decision).

---

## Out of scope for this workflow

- Auto-remediation (restart Evolution instance, flush orphan batches): manual.
- Sending alerts via Slack / WhatsApp / email: manual, dashboard-driven.
- Historical retention policy: `events` table is shared, no TTL set here.
- Authorization / RBAC: workflow assumes only n8n owners can read `events`.
