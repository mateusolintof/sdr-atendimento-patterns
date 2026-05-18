import {
  workflow,
  node,
  trigger,
  ifElse,
  splitInBatches,
  nextBatch,
  newCredential,
} from '@n8n/workflow-sdk';

// IGOR_Campaign_Sender — disparo one-shot da campanha promocional via WhatsApp
// Cron */7 * * * * com gate interno (janela, holiday, quota, status). Batch=2 por tick,
// jitter 45-90s entre sends. Sem AI conversacional. Resposta vai pra atendente humana via gate
// existente em IGOR_Inbound (block_reason='campaign_active'). Tracking via campaign_contacts.
// Spec: ~/.claude/plans/primeiro-de-tudo-eu-melodic-toast.md
// Errors: errorWorkflow=ZrsbaSTlW5bqMEaS (IGOR_07).

const IGOR_LABELS_ID = 'AJF7dhGrqJEXMLqz';

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Cron 7 min',
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression: '*/7 * * * *' }],
      },
    },
    position: [0, 400],
  },
  output: [{}],
});

const loadStateQuery =
  "WITH s AS (SELECT json_object_agg(key,value) AS j FROM public.settings),\n" +
  "cr AS (\n" +
  "  SELECT id::text AS id, name, status, message_template, message_variants,\n" +
  "         max_daily_sends, send_window_start::text AS send_window_start, send_window_end::text AS send_window_end,\n" +
  "         ends_at::date AS ends_at\n" +
  "  FROM public.campaign_runs\n" +
  "  WHERE status = 'ativo' AND ends_at >= now()::date\n" +
  "  ORDER BY starts_at DESC LIMIT 1\n" +
  "),\n" +
  "today AS (\n" +
  "  SELECT COUNT(*)::int AS sent_today FROM public.campaign_contacts cc\n" +
  "  WHERE cc.campaign_id = (SELECT id::uuid FROM cr)\n" +
  "    AND (cc.sent_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date\n" +
  ")\n" +
  "SELECT (SELECT j FROM s) AS settings_json,\n" +
  "       (SELECT row_to_json(cr.*) FROM cr) AS campaign,\n" +
  "       COALESCE((SELECT sent_today FROM today), 0) AS sent_today;";

const loadState = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Campaign State',
    parameters: {
      operation: 'executeQuery',
      query: loadStateQuery,
      options: {},
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [200, 400],
    alwaysOutputData: true,
  },
  output: [{ settings_json: {}, campaign: null, sent_today: 0 }],
});

const computeGatesJs =
  "const r = $('Load Campaign State').first().json;\n" +
  'const settings = (r && r.settings_json) || {};\n' +
  'const campaign = r && r.campaign;\n' +
  'const sentToday = Number(r && r.sent_today || 0);\n' +
  'function asBool(v, fb) { if (v === true || v === "true") return true; if (v === false || v === "false") return false; return fb; }\n' +
  'function asObj(v, fb) { if (v && typeof v === "object" && !Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return (p && typeof p === "object" && !Array.isArray(p)) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asArr(v, fb) { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asStr(v, fb) { if (typeof v === "string") { try { const p = JSON.parse(v); return typeof p === "string" ? p : fb; } catch(e) { return v; } } return fb; }\n' +
  'const aiEnabledGlobal = asBool(settings.ai_enabled_global, true);\n' +
  'const wfEnabled = asObj(settings.workflows_enabled, {});\n' +
  'const wfEnabledThis = wfEnabled.IGOR_Campaign_Sender !== false;\n' +
  'const tz = asStr(settings.timezone, "America/Sao_Paulo");\n' +
  'const holidays = asArr(settings.holidays, []);\n' +
  'const holidayPolicy = asStr(settings.holiday_policy, "after_hours_force");\n' +
  'let skipReason = null;\n' +
  'if (!aiEnabledGlobal) skipReason = "ai_disabled_global";\n' +
  'else if (!wfEnabledThis) skipReason = "workflow_disabled";\n' +
  'else if (!campaign) skipReason = "no_active_campaign";\n' +
  'else if (sentToday >= Number(campaign.max_daily_sends || 0)) skipReason = "daily_quota_reached";\n' +
  'const now = new Date();\n' +
  'let hh = "00", mm = "00", ymd = now.toISOString().slice(0,10), dow = 1;\n' +
  'try {\n' +
  '  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", weekday:"short", hour12:false });\n' +
  '  const parts = fmt.formatToParts(now).reduce(function(acc,p){acc[p.type]=p.value;return acc;},{});\n' +
  '  ymd = (parts.year||"0000")+"-"+(parts.month||"01")+"-"+(parts.day||"01");\n' +
  '  hh = parts.hour||"00"; mm = parts.minute||"00";\n' +
  '  if (hh === "24") hh = "00";\n' +
  '  const map = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:0 };\n' +
  '  dow = map[parts.weekday] !== undefined ? map[parts.weekday] : 1;\n' +
  '} catch(e) {}\n' +
  'const curMin = Number(hh)*60 + Number(mm);\n' +
  'const winStart = (campaign && campaign.send_window_start) || "09:00";\n' +
  'const winEnd = (campaign && campaign.send_window_end) || "17:30";\n' +
  'const wsP = String(winStart).split(":"); const wsMin = Number(wsP[0])*60 + Number(wsP[1]||0);\n' +
  'const weP = String(winEnd).split(":"); const weMin = Number(weP[0])*60 + Number(weP[1]||0);\n' +
  'const insideWindow = curMin >= wsMin && curMin < weMin;\n' +
  'const isWeekend = dow === 0 || dow === 6;\n' +
  'const isHoliday = Array.isArray(holidays) && holidays.indexOf(ymd) !== -1;\n' +
  'if (skipReason === null && isWeekend) skipReason = "weekend";\n' +
  'else if (skipReason === null && isHoliday) skipReason = "holiday";\n' +
  'else if (skipReason === null && !insideWindow) skipReason = "outside_window";\n' +
  'const shouldProceed = skipReason === null;\n' +
  'const remainingQuota = campaign ? Math.max(0, Number(campaign.max_daily_sends || 0) - sentToday) : 0;\n' +
  'const batchSize = Math.min(2, remainingQuota);\n' +
  'return [{ json: { should_proceed: shouldProceed, skip_reason: skipReason, batch_size: batchSize, remaining_quota: remainingQuota, campaign_id: campaign && campaign.id, campaign_name: campaign && campaign.name, sent_today: sentToday, current_hm: hh+":"+mm, ymd: ymd, dow: dow } }];';

const computeGates = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Gates',
    parameters: { mode: 'runOnceForAllItems', jsCode: computeGatesJs },
    position: [400, 400],
  },
  output: [{ should_proceed: true, skip_reason: null, batch_size: 2, remaining_quota: 20, campaign_id: '', sent_today: 0 }],
});

const ifShouldProceed = ifElse({
  version: 2.2,
  config: {
    name: 'IF Should Proceed?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'sp-cond', leftValue: '={{ $json.should_proceed }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [600, 400],
  },
});

const respIdle = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp Idle',
    parameters: {
      assignments: {
        assignments: [
          { id: 'ri-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'ri-idle', name: 'idle', value: true, type: 'boolean' },
          { id: 'ri-reason', name: 'skip_reason', value: '={{ $json.skip_reason }}', type: 'string' },
          { id: 'ri-quota', name: 'remaining_quota', value: '={{ $json.remaining_quota }}', type: 'number' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [800, 240],
    executeOnce: true,
  },
  output: [{ ok: true, idle: true, skip_reason: '', remaining_quota: 0 }],
});

const pickBatchQuery =
  "SELECT cc.id::text AS cc_id, cc.phone, cc.personalized_context, c.name AS contact_name\n" +
  "FROM public.campaign_contacts cc\n" +
  "JOIN public.contacts c ON c.id = cc.contact_id\n" +
  "WHERE cc.campaign_id = $1::uuid\n" +
  "  AND cc.status = 'queued'\n" +
  "  AND (c.do_not_contact = false OR c.do_not_contact IS NULL)\n" +
  "ORDER BY cc.id\n" +
  "LIMIT $2::int\n" +
  "FOR UPDATE SKIP LOCKED;";

const pickBatch = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Pick Eligible Batch',
    parameters: {
      operation: 'executeQuery',
      query: pickBatchQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const g = $('Compute Gates').first().json; return [g.campaign_id, String(g.batch_size)]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [800, 520],
    alwaysOutputData: true,
  },
  output: [{ cc_id: '', phone: '', personalized_context: {}, contact_name: '' }],
});

const splitMessages = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Carry Item',
    parameters: {
      assignments: {
        assignments: [
          { id: 'ci-cc', name: 'cc_id', value: '={{ $json.cc_id }}', type: 'string' },
          { id: 'ci-phone', name: 'phone', value: '={{ $json.phone }}', type: 'string' },
          { id: 'ci-name', name: 'contact_name', value: '={{ $json.contact_name || "" }}', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1000, 520],
  },
  output: [{ cc_id: '', phone: '', contact_name: '' }],
});

const loopBatch = splitInBatches({
  version: 3,
  config: {
    name: 'Loop Batch',
    parameters: { batchSize: 1, options: {} },
    position: [1200, 520],
  },
});

const markSendingQuery =
  "UPDATE public.campaign_contacts\n" +
  "SET status = 'sending', updated_at = now()\n" +
  "WHERE id = $1::uuid AND status = 'queued'\n" +
  "RETURNING id::text AS cc_id;";

const markSending = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Mark Sending',
    parameters: {
      operation: 'executeQuery',
      query: markSendingQuery,
      options: {
        queryReplacement: "={{ [$('Loop Batch').item.json.cc_id] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1400, 680],
  },
  output: [{ cc_id: '' }],
});

const pickVariantJs =
  "const item = $('Loop Batch').item.json;\n" +
  "const stateRow = $('Load Campaign State').first().json;\n" +
  "const campaign = stateRow && stateRow.campaign || {};\n" +
  'function asArr(v, fb) { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  "let variants = asArr(campaign.message_variants, []);\n" +
  "if (!variants.length && campaign.message_template) variants = [campaign.message_template];\n" +
  'if (!variants.length) throw new Error("Sem template nem variantes disponíveis para a campanha");\n' +
  "const idx = Math.floor(Math.random() * variants.length);\n" +
  "const raw = String(variants[idx] || '');\n" +
  'const firstName = (item.contact_name || "").split(/\\s+/)[0] || "";\n' +
  'const replaced = raw.replace(/\\{nome\\}/g, firstName).replace(/Oi, !/g, "Oi!").replace(/Olá ,/g, "Olá,").replace(/^Olá !/g, "Olá!");\n' +
  "return [{ json: { cc_id: item.cc_id, phone: item.phone, contact_name: item.contact_name, message_text: replaced, message_variant: 'v' + idx, variant_idx: idx, variants_total: variants.length } }];";

const pickVariant = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Pick Variant + Personalize',
    parameters: { mode: 'runOnceForEachItem', jsCode: pickVariantJs },
    position: [1600, 680],
  },
  output: [{ cc_id: '', phone: '', contact_name: '', message_text: '', message_variant: 'v0', variant_idx: 0, variants_total: 3 }],
});

const sendWhatsApp = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send WhatsApp',
    parameters: {
      method: 'POST',
      url: '=https://evo.almaconvert.com.br/message/sendText/convert-teste',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ number: $json.phone, text: $json.message_text }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json', fullResponse: true } }, timeout: 20000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [1800, 680],
  },
  output: [{ statusCode: 201, body: { key: { id: '' } } }],
});

const ifSendOk = ifElse({
  version: 2.2,
  config: {
    name: 'IF Send OK?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'ok-status', leftValue: '={{ Number($json.statusCode || 0) }}', rightValue: 200, operator: { type: 'number', operation: 'gte', singleValue: true } },
          { id: 'ok-status-lt', leftValue: '={{ Number($json.statusCode || 0) }}', rightValue: 300, operator: { type: 'number', operation: 'lt', singleValue: true } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      },
    },
    position: [2000, 680],
  },
});

const updateSentQuery =
  "UPDATE public.campaign_contacts\n" +
  "SET status = 'sent', sent_at = now(), sent_message = $1::text, message_variant = $2::text, updated_at = now()\n" +
  "WHERE id = $3::uuid;";

const updateSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Sent',
    parameters: {
      operation: 'executeQuery',
      query: updateSentQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const v = $('Pick Variant + Personalize').item.json; return [v.message_text, v.message_variant, v.cc_id]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2200, 560],
  },
  output: [{}],
});

const updateFailedQuery =
  "UPDATE public.campaign_contacts\n" +
  "SET status = 'send_failed', skip_reason = $1::text, updated_at = now()\n" +
  "WHERE id = $2::uuid;";

const updateFailed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Failed',
    parameters: {
      operation: 'executeQuery',
      query: updateFailedQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const v = $('Pick Variant + Personalize').item.json; const r = $('Send WhatsApp').item.json; const reason = 'evolution_status_' + (r.statusCode||'unknown') + (r.body && r.body.message ? '_'+String(r.body.message).slice(0,80) : ''); return [reason, v.cc_id]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2200, 800],
  },
  output: [{}],
});

const insertEventQuery =
  "INSERT INTO public.events (event_type, phone, workflow_name, payload)\n" +
  "VALUES ('campaign_send_attempt', $1::text, 'IGOR_Campaign_Sender', $2::jsonb);";

const insertEventQR =
  "={{ (function(){ const v = $('Pick Variant + Personalize').item.json; const r = $('Send WhatsApp').item.json; const ok = Number(r.statusCode||0) >= 200 && Number(r.statusCode||0) < 300; return [v.phone, JSON.stringify({ cc_id: v.cc_id, ok: ok, status_code: r.statusCode||null, message_variant: v.message_variant, variant_idx: v.variant_idx, message_text_preview: String(v.message_text||'').slice(0,120) }) ]; })() }}";

const insertEventSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT event sent',
    parameters: {
      operation: 'executeQuery',
      query: insertEventQuery,
      options: { queryReplacement: insertEventQR },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2400, 560],
  },
  output: [{}],
});

const insertEventFailed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT event failed',
    parameters: {
      operation: 'executeQuery',
      query: insertEventQuery,
      options: { queryReplacement: insertEventQR },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2400, 800],
  },
  output: [{}],
});

const callLabels = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_04 Labels',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_LABELS_ID, cachedResultName: 'IGOR_04_Tool_Labels_Attributes' },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: '={{ 0 }}',
          chatwoot_contact_id: "={{ $('Pick Variant + Personalize').item.json.phone }}",
          labels_to_add: "={{ ['promo_maio_2026','campanha_enviada'] }}",
          labels_to_remove: '={{ [] }}',
          custom_attributes: "={{ ({ conversation: {}, contact: { campaign_status: 'sent', last_campaign: 'promo_maio_2026' } }) }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'labels_to_add', displayName: 'labels_to_add', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' },
          { id: 'labels_to_remove', displayName: 'labels_to_remove', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' },
          { id: 'custom_attributes', displayName: 'custom_attributes', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { waitForSubWorkflow: true },
    },
    position: [2600, 560],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const waitJitter = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait jitter 45-90s',
    parameters: { amount: '={{ Math.floor(45 + Math.random()*45) }}', unit: 'seconds' },
    position: [2800, 680],
  },
  output: [{}],
});

const finalOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Final Output',
    parameters: {
      assignments: {
        assignments: [
          { id: 'fo-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'fo-campaign', name: 'campaign_id', value: "={{ $('Compute Gates').first().json.campaign_id }}", type: 'string' },
          { id: 'fo-batch', name: 'batch_size', value: "={{ $('Compute Gates').first().json.batch_size }}", type: 'number' },
          { id: 'fo-quota', name: 'remaining_quota', value: "={{ $('Compute Gates').first().json.remaining_quota }}", type: 'number' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [3000, 520],
    executeOnce: true,
  },
  output: [{ ok: true, campaign_id: '', batch_size: 0, remaining_quota: 0 }],
});

export default workflow('igor-campaign-sender', 'IGOR_Campaign_Sender')
  .add(scheduleTrigger)
  .to(loadState)
  .to(computeGates)
  .to(
    ifShouldProceed
      .onFalse(respIdle)
      .onTrue(
        pickBatch
          .to(splitMessages)
          .to(
            loopBatch
              .onDone(finalOutput)
              .onEachBatch(
                markSending
                  .to(pickVariant)
                  .to(sendWhatsApp)
                  .to(
                    ifSendOk
                      .onTrue(updateSent.to(insertEventSent.to(callLabels.to(waitJitter.to(nextBatch(loopBatch))))))
                      .onFalse(updateFailed.to(insertEventFailed.to(waitJitter.to(nextBatch(loopBatch)))))
                  )
              )
          )
      )
  );
