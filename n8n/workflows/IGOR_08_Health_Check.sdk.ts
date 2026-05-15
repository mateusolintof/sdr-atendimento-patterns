// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_08_Health_Check.json`
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "settings.availableInMCP": true
//   - "tags": ["igor", "infra", "health-check", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the five properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// Additionally the following node-level credential bindings are applied
// post-create via REST PATCH (the SDK serializes them but the n8n MCP
// "validate / create_workflow_from_code" path may strip predefinedCredential
// references that do not exist as Credentials interface members on the node
// version):
//   - Chatwoot Ping     -> credentials.httpHeaderAuth  = igor_chatwoot_api
//   - Evolution Ping    -> credentials.httpHeaderAuth  = igor_evolution_api
//   - OpenAI Ping       -> credentials.openAiApi       = igor_openai
//   - Supabase Ping     -> credentials.postgres        = igor_supabase_postgres
//   - Counts 24h        -> credentials.postgres        = igor_supabase_postgres
//   - Race Detection    -> credentials.postgres        = igor_supabase_postgres
//   - Orphan Batches    -> credentials.redis           = igor_redis_embedded
//   - INSERT events     -> credentials.postgres        = igor_supabase_postgres
//   - INSERT health_alert -> credentials.postgres      = igor_supabase_postgres
//
// Do NOT treat this SDK file as the single source of truth without
// re-applying the JSON-only properties above.
// =============================================================================

import {
  workflow,
  node,
  trigger,
  ifElse,
  merge,
  newCredential,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// IGOR_08_Health_Check
// =============================================================================
// Schedule every 10 min. Runs 5 service pings in parallel (n8n, Chatwoot,
// Evolution, OpenAI, Supabase), each preceded by a fan-out from the Init
// Snapshot node and followed by a Capture code node that normalizes the
// outcome to {service, status, http_code, latency_ms, error, ...}.
//
// Then collects:
//   - 24h business counts (events, infra_errors, opt_outs, messages, leads,
//     campaign_contacts) via a single Postgres query.
//   - Race detection: conversations.ai_enabled=true with a human-agent message
//     in the last 10 min.
//   - Orphan batches: Redis KEYS igor:batch:* — surviving past their 60s TTL.
//
// Aggregate code node applies thresholds:
//   - infra_errors_24h > 50          -> degraded
//   - opt_outs_24h     > 20          -> degraded
//   - any service fail               -> degraded
//   - 2+ service fails               -> critical
//   - race_count > 0                 -> critical
//   - orphan_batches_count > 5       -> critical
//
// Mutations: INSERT events('health_check', payload). If critical -> extra
// INSERT events('health_alert', payload). No LLM. No WhatsApp. No Chatwoot
// mutation. Read-only on all third-party deps. Errors -> IGOR_07 via
// settings.errorWorkflow.
// =============================================================================

// -----------------------------------------------------------------------------
// TRIGGER
// -----------------------------------------------------------------------------

const cronTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 10 Minutes',
    parameters: {
      rule: {
        interval: [
          {
            field: 'cronExpression',
            expression: '*/10 * * * *',
          },
        ],
      },
    },
    position: [-200, 0],
  },
  output: [{}],
});

// -----------------------------------------------------------------------------
// INIT SNAPSHOT — generates health_id, started_at, started_at_ms
// -----------------------------------------------------------------------------

const initSnapshot = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Init Snapshot',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const now = new Date();\n" +
        "const healthId = (typeof crypto !== 'undefined' && crypto.randomUUID)\n" +
        "  ? crypto.randomUUID()\n" +
        "  : 'health-' + now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 10);\n" +
        "return [{\n" +
        "  json: {\n" +
        "    health_id: healthId,\n" +
        "    started_at: now.toISOString(),\n" +
        "    started_at_ms: now.getTime()\n" +
        "  }\n" +
        "}];",
    },
    position: [0, 0],
  },
  output: [
    {
      health_id: '00000000-0000-0000-0000-000000000000',
      started_at: '2026-05-15T12:30:00.000Z',
      started_at_ms: 1779881400000,
    },
  ],
});

// -----------------------------------------------------------------------------
// PING #1 — n8n self healthz (no auth)
// -----------------------------------------------------------------------------

const n8nPing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'n8n Ping',
    parameters: {
      method: 'GET',
      url: expr('=https://n8n.almaconvert.com.br/healthz'),
      authentication: 'none',
      options: {
        timeout: 5000,
        response: {
          response: {
            responseFormat: 'json',
            fullResponse: true,
            neverError: true,
          },
        },
      },
    },
    continueOnFail: true,
    position: [220, -480],
  },
  output: [{ statusCode: 200, body: { status: 'ok' } }],
});

const n8nCapture = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Capture n8n',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "const items = $input.all();\n" +
        "const r = (items[0] && items[0].json) || {};\n" +
        "const httpCode = Number(r.statusCode ?? r.status ?? 0);\n" +
        "const errorRaw = r.error || r.message || null;\n" +
        "const ok = httpCode >= 200 && httpCode < 300;\n" +
        "return [{\n" +
        "  json: {\n" +
        "    service: 'n8n',\n" +
        "    status: ok ? 'ok' : 'fail',\n" +
        "    http_code: httpCode || null,\n" +
        "    latency_ms: Date.now() - init.started_at_ms,\n" +
        "    error: ok ? null : (errorRaw ? String(errorRaw).slice(0, 280) : 'non_2xx_or_no_response')\n" +
        "  }\n" +
        "}];",
    },
    position: [440, -480],
  },
  output: [{ service: 'n8n', status: 'ok', http_code: 200, latency_ms: 38, error: null }],
});

// -----------------------------------------------------------------------------
// PING #2 — Chatwoot account read
// -----------------------------------------------------------------------------

const chatwootPing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Chatwoot Ping',
    parameters: {
      method: 'GET',
      url: expr('=https://chat.almaconvert.com.br/api/v1/accounts/2'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        timeout: 5000,
        response: {
          response: {
            responseFormat: 'json',
            fullResponse: true,
            neverError: true,
          },
        },
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_chatwoot_api'),
    },
    continueOnFail: true,
    position: [220, -240],
  },
  output: [{ statusCode: 200, body: { id: 1, name: 'Instituto Dr. Igor' } }],
});

const chatwootCapture = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Capture Chatwoot',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "const items = $input.all();\n" +
        "const r = (items[0] && items[0].json) || {};\n" +
        "const httpCode = Number(r.statusCode ?? r.status ?? 0);\n" +
        "const errorRaw = r.error || (r.body && r.body.error) || null;\n" +
        "const ok = httpCode >= 200 && httpCode < 300;\n" +
        "return [{\n" +
        "  json: {\n" +
        "    service: 'chatwoot',\n" +
        "    status: ok ? 'ok' : 'fail',\n" +
        "    http_code: httpCode || null,\n" +
        "    latency_ms: Date.now() - init.started_at_ms,\n" +
        "    error: ok ? null : (errorRaw ? String(errorRaw).slice(0, 280) : 'non_2xx_or_no_response')\n" +
        "  }\n" +
        "}];",
    },
    position: [440, -240],
  },
  output: [{ service: 'chatwoot', status: 'ok', http_code: 200, latency_ms: 112, error: null }],
});

// -----------------------------------------------------------------------------
// PING #3 — Evolution instance connection state
// -----------------------------------------------------------------------------

const evolutionPing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Evolution Ping',
    parameters: {
      method: 'GET',
      url: expr('=https://evo.almaconvert.com.br/instance/connectionState/convert-teste'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        timeout: 5000,
        response: {
          response: {
            responseFormat: 'json',
            fullResponse: true,
            neverError: true,
          },
        },
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_evolution_api'),
    },
    continueOnFail: true,
    position: [220, 0],
  },
  output: [{ statusCode: 200, body: { instance: { state: 'open' } } }],
});

const evolutionCapture = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Capture Evolution',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "const items = $input.all();\n" +
        "const r = (items[0] && items[0].json) || {};\n" +
        "const httpCode = Number(r.statusCode ?? r.status ?? 0);\n" +
        "const body = r.body || r;\n" +
        "const state = (body && body.instance && body.instance.state)\n" +
        "  || (body && body.state)\n" +
        "  || null;\n" +
        "const httpOk = httpCode >= 200 && httpCode < 300;\n" +
        "const stateOk = state === 'open';\n" +
        "const ok = httpOk && stateOk;\n" +
        "const errorRaw = r.error || (body && body.error) || null;\n" +
        "return [{\n" +
        "  json: {\n" +
        "    service: 'evolution',\n" +
        "    status: ok ? 'ok' : 'fail',\n" +
        "    http_code: httpCode || null,\n" +
        "    latency_ms: Date.now() - init.started_at_ms,\n" +
        "    evolution_state: state,\n" +
        "    error: ok\n" +
        "      ? null\n" +
        "      : (errorRaw\n" +
        "          ? String(errorRaw).slice(0, 280)\n" +
        "          : (!httpOk ? 'non_2xx_or_no_response' : ('state=' + String(state))))\n" +
        "  }\n" +
        "}];",
    },
    position: [440, 0],
  },
  output: [{ service: 'evolution', status: 'ok', http_code: 200, latency_ms: 230, evolution_state: 'open', error: null }],
});

// -----------------------------------------------------------------------------
// PING #4 — OpenAI /v1/models
// -----------------------------------------------------------------------------

const openaiPing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'OpenAI Ping',
    parameters: {
      method: 'GET',
      url: 'https://api.openai.com/v1/models',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      options: {
        timeout: 8000,
        response: {
          response: {
            responseFormat: 'json',
            fullResponse: true,
            neverError: true,
          },
        },
      },
    },
    credentials: {
      // @ts-ignore — openAiApi is a predefinedCredentialType not in HttpRequestV44Credentials
      openAiApi: newCredential('igor_openai'),
    },
    continueOnFail: true,
    position: [220, 240],
  },
  output: [{ statusCode: 200, body: { data: [{ id: 'gpt-4o-mini' }] } }],
});

const openaiCapture = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Capture OpenAI',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "const items = $input.all();\n" +
        "const r = (items[0] && items[0].json) || {};\n" +
        "const httpCode = Number(r.statusCode ?? r.status ?? 0);\n" +
        "const body = r.body || r;\n" +
        "const errorRaw = r.error || (body && body.error && (body.error.message || body.error)) || null;\n" +
        "const ok = httpCode >= 200 && httpCode < 300;\n" +
        "return [{\n" +
        "  json: {\n" +
        "    service: 'openai',\n" +
        "    status: ok ? 'ok' : 'fail',\n" +
        "    http_code: httpCode || null,\n" +
        "    latency_ms: Date.now() - init.started_at_ms,\n" +
        "    error: ok ? null : (errorRaw ? String(errorRaw).slice(0, 280) : 'non_2xx_or_no_response')\n" +
        "  }\n" +
        "}];",
    },
    position: [440, 240],
  },
  output: [{ service: 'openai', status: 'ok', http_code: 200, latency_ms: 412, error: null }],
});

// -----------------------------------------------------------------------------
// PING #5 — Supabase Postgres SELECT 1
// -----------------------------------------------------------------------------

const supabasePing = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Supabase Ping',
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT 1 AS supabase_ok',
      options: {
        connectionTimeout: 5,
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    continueOnFail: true,
    position: [220, 480],
  },
  output: [{ supabase_ok: 1 }],
});

const supabaseCapture = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Capture Supabase',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "const items = $input.all();\n" +
        "const r = (items[0] && items[0].json) || {};\n" +
        "const ok = Number(r.supabase_ok) === 1;\n" +
        "const errorRaw = r.error || r.message || null;\n" +
        "return [{\n" +
        "  json: {\n" +
        "    service: 'supabase',\n" +
        "    status: ok ? 'ok' : 'fail',\n" +
        "    http_code: null,\n" +
        "    latency_ms: Date.now() - init.started_at_ms,\n" +
        "    error: ok ? null : (errorRaw ? String(errorRaw).slice(0, 280) : 'select_1_did_not_return_1')\n" +
        "  }\n" +
        "}];",
    },
    position: [440, 480],
  },
  output: [{ service: 'supabase', status: 'ok', http_code: null, latency_ms: 87, error: null }],
});

// -----------------------------------------------------------------------------
// MERGE all 5 service captures (append concatenates all into one stream)
// -----------------------------------------------------------------------------

const mergeServices = merge({
  version: 3.2,
  config: {
    name: 'Merge Services',
    parameters: { mode: 'append', numberInputs: 5 },
    position: [680, 0],
  },
});

// -----------------------------------------------------------------------------
// MERGE all 3 metrics (counts + race + orphans) before Aggregate
// -----------------------------------------------------------------------------

const mergeMetrics = merge({
  version: 3.2,
  config: {
    name: 'Merge Metrics',
    parameters: { mode: 'append', numberInputs: 3 },
    position: [1140, 100],
  },
});

// -----------------------------------------------------------------------------
// COUNTS 24h — single Postgres query (executeOnce because mergeServices emits 5)
// -----------------------------------------------------------------------------

const counts24h = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Counts 24h',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT\n" +
        "  (SELECT count(*) FROM public.events     WHERE created_at > now() - interval '24 hours')                                                  AS events_24h,\n" +
        "  (SELECT count(*) FROM public.events     WHERE event_type='infra_error' AND created_at > now() - interval '24 hours')                     AS infra_errors_24h,\n" +
        "  (SELECT count(*) FROM public.events     WHERE event_type='opt_out'     AND created_at > now() - interval '24 hours')                     AS opt_outs_24h,\n" +
        "  (SELECT count(*) FROM public.messages   WHERE created_at > now() - interval '24 hours')                                                  AS messages_24h,\n" +
        "  (SELECT count(*) FROM public.leads      WHERE created_at > now() - interval '24 hours')                                                  AS leads_24h,\n" +
        "  (SELECT count(*) FROM public.campaign_contacts WHERE updated_at > now() - interval '24 hours')                                           AS campaign_24h",
      options: {
        connectionTimeout: 10,
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    continueOnFail: true,
    position: [900, -200],
  },
  output: [{
    events_24h: 1842, infra_errors_24h: 3, opt_outs_24h: 1,
    messages_24h: 612, leads_24h: 28, campaign_24h: 0,
  }],
});

// -----------------------------------------------------------------------------
// RACE DETECTION — ai_enabled=true with human-agent msg in last 10 min
// -----------------------------------------------------------------------------

const raceDetection = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Race Detection',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT count(*)::int AS race_count\n" +
        "FROM public.conversations c\n" +
        "JOIN public.messages m ON m.conversation_id = c.id\n" +
        "WHERE c.ai_enabled = true\n" +
        "  AND m.role IN ('agent_human', 'agent')\n" +
        "  AND m.created_at > now() - interval '10 minutes'",
      options: {
        connectionTimeout: 10,
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    continueOnFail: true,
    position: [900, 0],
  },
  output: [{ race_count: 0 }],
});

// -----------------------------------------------------------------------------
// ORPHAN BATCHES — Redis KEYS igor:batch:*
// -----------------------------------------------------------------------------

const orphanBatches = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Orphan Batches',
    parameters: {
      operation: 'keys',
      keyPattern: 'igor:batch:*',
      getValues: false,
    },
    credentials: {
      redis: newCredential('igor_redis_embedded'),
    },
    executeOnce: true,
    continueOnFail: true,
    position: [900, 200],
  },
  output: [{ keys: [] }],
});

// -----------------------------------------------------------------------------
// AGGREGATE — consolidate services array + counts + race + orphans, apply
// thresholds, decide overall_status
// -----------------------------------------------------------------------------

const aggregate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aggregate',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const init = $('Init Snapshot').first().json;\n" +
        "function safeFirst(nodeName) {\n" +
        "  try {\n" +
        "    const all = $(nodeName).all();\n" +
        "    if (!all || all.length === 0) return null;\n" +
        "    return all[0].json || null;\n" +
        "  } catch (e) {\n" +
        "    return null;\n" +
        "  }\n" +
        "}\n" +
        "const services = [\n" +
        "  safeFirst('Capture n8n')       || { service: 'n8n',       status: 'fail', http_code: null, latency_ms: null, error: 'capture_unavailable' },\n" +
        "  safeFirst('Capture Chatwoot')  || { service: 'chatwoot',  status: 'fail', http_code: null, latency_ms: null, error: 'capture_unavailable' },\n" +
        "  safeFirst('Capture Evolution') || { service: 'evolution', status: 'fail', http_code: null, latency_ms: null, error: 'capture_unavailable' },\n" +
        "  safeFirst('Capture OpenAI')    || { service: 'openai',    status: 'fail', http_code: null, latency_ms: null, error: 'capture_unavailable' },\n" +
        "  safeFirst('Capture Supabase')  || { service: 'supabase',  status: 'fail', http_code: null, latency_ms: null, error: 'capture_unavailable' },\n" +
        "];\n" +
        "const countsRaw = safeFirst('Counts 24h') || {};\n" +
        "const counts = {\n" +
        "  events_24h:       Number(countsRaw.events_24h ?? 0),\n" +
        "  infra_errors_24h: Number(countsRaw.infra_errors_24h ?? 0),\n" +
        "  opt_outs_24h:     Number(countsRaw.opt_outs_24h ?? 0),\n" +
        "  messages_24h:     Number(countsRaw.messages_24h ?? 0),\n" +
        "  leads_24h:        Number(countsRaw.leads_24h ?? 0),\n" +
        "  campaign_24h:     Number(countsRaw.campaign_24h ?? 0)\n" +
        "};\n" +
        "const raceRaw = safeFirst('Race Detection') || {};\n" +
        "const race_count = Number(raceRaw.race_count ?? 0);\n" +
        "const orphanRaw = $('Orphan Batches').all();\n" +
        "let orphan_keys = [];\n" +
        "try {\n" +
        "  if (Array.isArray(orphanRaw)) {\n" +
        "    for (const it of orphanRaw) {\n" +
        "      const j = it.json || {};\n" +
        "      if (Array.isArray(j.keys)) { orphan_keys = orphan_keys.concat(j.keys); }\n" +
        "      else if (typeof j === 'string') { orphan_keys.push(j); }\n" +
        "      else if (j && typeof j === 'object') {\n" +
        "        for (const k of Object.keys(j)) {\n" +
        "          if (k.startsWith('igor:batch:')) orphan_keys.push(k);\n" +
        "        }\n" +
        "      }\n" +
        "    }\n" +
        "  }\n" +
        "} catch (e) { orphan_keys = []; }\n" +
        "const orphan_batches_count = orphan_keys.length;\n" +
        "const threshold_breaches = [];\n" +
        "if (counts.infra_errors_24h > 50) threshold_breaches.push('infra_errors_24h>50');\n" +
        "if (counts.opt_outs_24h > 20)     threshold_breaches.push('opt_outs_24h>20');\n" +
        "for (const s of services) {\n" +
        "  if (s.status === 'fail') threshold_breaches.push('service_fail:' + s.service);\n" +
        "}\n" +
        "if (race_count > 0)                threshold_breaches.push('race');\n" +
        "if (orphan_batches_count > 5)      threshold_breaches.push('orphan_batches>5');\n" +
        "const failedServices = services.filter(s => s.status === 'fail').length;\n" +
        "let overall_status = 'healthy';\n" +
        "const hasDegraded = (counts.infra_errors_24h > 50)\n" +
        "  || (counts.opt_outs_24h > 20)\n" +
        "  || (failedServices >= 1);\n" +
        "if (hasDegraded) overall_status = 'degraded';\n" +
        "const hasCritical = (failedServices >= 2)\n" +
        "  || (race_count > 0)\n" +
        "  || (orphan_batches_count > 5);\n" +
        "if (hasCritical) overall_status = 'critical';\n" +
        "const endedAtMs = Date.now();\n" +
        "const payload = {\n" +
        "  health_id: init.health_id,\n" +
        "  started_at: init.started_at,\n" +
        "  ended_at: new Date(endedAtMs).toISOString(),\n" +
        "  duration_ms: endedAtMs - init.started_at_ms,\n" +
        "  services: services,\n" +
        "  counts: counts,\n" +
        "  race_count: race_count,\n" +
        "  orphan_batches_count: orphan_batches_count,\n" +
        "  orphan_keys_sample: orphan_keys.slice(0, 20),\n" +
        "  threshold_breaches: threshold_breaches,\n" +
        "  overall_status: overall_status\n" +
        "};\n" +
        "return [{\n" +
        "  json: {\n" +
        "    payload: payload,\n" +
        "    payload_json: JSON.stringify(payload),\n" +
        "    overall_status: overall_status\n" +
        "  }\n" +
        "}];",
    },
    executeOnce: true,
    position: [1380, 100],
  },
  output: [
    {
      payload: {
        health_id: '00000000-0000-0000-0000-000000000000',
        started_at: '2026-05-15T12:30:00.000Z',
        ended_at: '2026-05-15T12:30:04.412Z',
        duration_ms: 4412,
        services: [],
        counts: {
          events_24h: 1842, infra_errors_24h: 3, opt_outs_24h: 1,
          messages_24h: 612, leads_24h: 28, campaign_24h: 0,
        },
        race_count: 0,
        orphan_batches_count: 0,
        orphan_keys_sample: [],
        threshold_breaches: [],
        overall_status: 'healthy',
      },
      payload_json: '{}',
      overall_status: 'healthy',
    },
  ],
});

// -----------------------------------------------------------------------------
// INSERT events('health_check', payload)
// -----------------------------------------------------------------------------

const insertHealthCheck = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT events health_check',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, workflow_name, payload)\n" +
        "VALUES ('health_check', 'IGOR_08_Health_Check', $1::jsonb)",
      options: {
        queryReplacement: expr("={{ $json.payload_json }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [1620, 100],
  },
  output: [{ executionStatus: 'success' }],
});

// -----------------------------------------------------------------------------
// IF critical -> INSERT events('health_alert')
// -----------------------------------------------------------------------------

const ifCritical = ifElse({
  version: 2.3,
  config: {
    name: 'Is Critical?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'is-critical-cond',
            leftValue: expr("={{ $('Aggregate').first().json.overall_status }}"),
            rightValue: 'critical',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
    },
    position: [1840, 100],
  },
});

const insertHealthAlert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT events health_alert',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, workflow_name, payload)\n" +
        "VALUES ('health_alert', 'IGOR_08_Health_Check', $1::jsonb)",
      options: {
        queryReplacement: expr("={{ $('Aggregate').first().json.payload_json }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [2060, 0],
  },
  output: [{ executionStatus: 'success' }],
});

// =============================================================================
// WIRE WORKFLOW
// =============================================================================

export default workflow('IGOR_08_Health_Check', 'IGOR_08_Health_Check')
  .add(cronTrigger)
  .to(initSnapshot)
  .to(n8nPing.to(n8nCapture.to(mergeServices.input(0))))
  .add(initSnapshot)
  .to(chatwootPing.to(chatwootCapture.to(mergeServices.input(1))))
  .add(initSnapshot)
  .to(evolutionPing.to(evolutionCapture.to(mergeServices.input(2))))
  .add(initSnapshot)
  .to(openaiPing.to(openaiCapture.to(mergeServices.input(3))))
  .add(initSnapshot)
  .to(supabasePing.to(supabaseCapture.to(mergeServices.input(4))))
  .add(mergeServices)
  .to(counts24h.to(mergeMetrics.input(0)))
  .add(mergeServices)
  .to(raceDetection.to(mergeMetrics.input(1)))
  .add(mergeServices)
  .to(orphanBatches.to(mergeMetrics.input(2)))
  .add(mergeMetrics)
  .to(aggregate)
  .to(insertHealthCheck)
  .to(ifCritical.onTrue(insertHealthAlert));
