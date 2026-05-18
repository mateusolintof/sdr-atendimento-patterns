import { workflow, node, trigger, ifElse, merge, newCredential } from '@n8n/workflow-sdk';

// IGOR_01_v2: roteador inbound after-hours. Gate "lead novo" via journey_started_at.
// Topologia: 1 webhook → normalize → load state (1 query) → 4 gates compostos →
// Redis lock/batching → media → IGOR_03 agent.

const evolutionWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Evolution Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'igor/inbound',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
      options: {
        rawBody: false,
        responseCode: { values: { responseCode: 200 } },
      },
    },
    position: [0, 600],
  },
  output: [{ body: {} }],
});

const normalizePayloadJs =
  'const items = $input.all();\n' +
  'return items.map(item => {\n' +
  '  const root = item.json || {};\n' +
  '  const b = root.body || root;\n' +
  '  const data = b.data || {};\n' +
  '  const key = data.key || {};\n' +
  '  const message = data.message || {};\n' +
  '  const additional = b.additional_attributes || {};\n' +
  '  const msgId = key.id ? String(key.id) : "";\n' +
  '  const remoteJid = key.remoteJid ? String(key.remoteJid) : "";\n' +
  '  const rawPhone = remoteJid.split("@")[0] || "";\n' +
  '  const fromMe = key.fromMe === true;\n' +
  '  let messageType = data.messageType || "";\n' +
  '  if (messageType === "conversation" || messageType === "extendedTextMessage") messageType = "text";\n' +
  '  else if (messageType === "audioMessage" || messageType === "pttMessage") messageType = "audio";\n' +
  '  else if (messageType === "imageMessage") messageType = "image";\n' +
  '  else if (messageType === "documentMessage" || messageType === "documentWithCaptionMessage") messageType = "document";\n' +
  '  else if (messageType === "videoMessage") messageType = "video";\n' +
  '  else if (!messageType) messageType = "unknown";\n' +
  '  let text = "";\n' +
  '  let caption = "";\n' +
  '  let mediaUrl = "";\n' +
  '  let mediaBase64 = "";\n' +
  '  let mimeType = "";\n' +
  '  if (message.conversation) text = String(message.conversation);\n' +
  '  else if (message.extendedTextMessage && message.extendedTextMessage.text) text = String(message.extendedTextMessage.text);\n' +
  '  if (message.audioMessage) { mimeType = String(message.audioMessage.mimetype || "audio/ogg"); mediaUrl = String(message.audioMessage.url || ""); }\n' +
  '  else if (message.imageMessage) { mimeType = String(message.imageMessage.mimetype || "image/jpeg"); mediaUrl = String(message.imageMessage.url || ""); caption = String(message.imageMessage.caption || ""); }\n' +
  '  else if (message.documentMessage) { mimeType = String(message.documentMessage.mimetype || "application/pdf"); mediaUrl = String(message.documentMessage.url || ""); caption = String(message.documentMessage.caption || message.documentMessage.title || ""); }\n' +
  '  if (data.mediaBase64) mediaBase64 = String(data.mediaBase64);\n' +
  '  else if (data.media_base64) mediaBase64 = String(data.media_base64);\n' +
  '  const tsRaw = data.messageTimestamp;\n' +
  '  let timestamp;\n' +
  '  if (typeof tsRaw === "number") timestamp = new Date(tsRaw * 1000).toISOString();\n' +
  '  else if (typeof tsRaw === "string" && /^\\d+$/.test(tsRaw)) timestamp = new Date(Number(tsRaw) * 1000).toISOString();\n' +
  '  else timestamp = new Date().toISOString();\n' +
  '  const conversationId = (b.chatwoot_conversation_id !== undefined && b.chatwoot_conversation_id !== null) ? String(b.chatwoot_conversation_id) : "";\n' +
  '  const contactId = (b.chatwoot_contact_id !== undefined && b.chatwoot_contact_id !== null) ? String(b.chatwoot_contact_id) : "";\n' +
  '  const instance = String(b.instance || "");\n' +
  '  const pushName = String((data.pushName) || "");\n' +
  '  const testRunId = additional.test_run_id || b.test_run_id || null;\n' +
  '  let digits = rawPhone.replace(/\\D/g, "");\n' +
  '  let phone = "";\n' +
  '  let phoneValid = false;\n' +
  '  if (digits.length === 13 && digits.startsWith("55")) {\n' +
  '    const ddd = digits.substring(2, 4);\n' +
  '    const rest = digits.substring(4);\n' +
  '    if (/^[1-9][0-9]$/.test(ddd) && /^9\\d{8}$/.test(rest)) { phone = digits; phoneValid = true; }\n' +
  '  } else if (digits.length === 12 && digits.startsWith("55")) {\n' +
  '    const ddd = digits.substring(2, 4);\n' +
  '    const rest = digits.substring(4);\n' +
  '    if (/^[1-9][0-9]$/.test(ddd) && /^\\d{8}$/.test(rest)) { phone = "55" + ddd + "9" + rest; phoneValid = true; }\n' +
  '  }\n' +
  '  return {\n' +
  '    json: {\n' +
  '      raw_phone: rawPhone,\n' +
  '      phone: phone || rawPhone,\n' +
  '      phone_valid: phoneValid,\n' +
  '      msg_id: msgId,\n' +
  '      from_me: fromMe,\n' +
  '      message_type: messageType,\n' +
  '      text: text,\n' +
  '      caption: caption,\n' +
  '      media_url: mediaUrl,\n' +
  '      media_base64: mediaBase64,\n' +
  '      mime_type: mimeType,\n' +
  '      chatwoot_conversation_id: conversationId,\n' +
  '      chatwoot_contact_id: contactId,\n' +
  '      instance: instance,\n' +
  '      push_name: pushName,\n' +
  '      timestamp: timestamp,\n' +
  '      test_run_id: testRunId,\n' +
  '      raw_payload_json: JSON.stringify(b)\n' +
  '    }\n' +
  '  };\n' +
  '});';

const normalizePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Payload',
    parameters: { mode: 'runOnceForAllItems', jsCode: normalizePayloadJs },
    position: [200, 600],
  },
  output: [
    {
      raw_phone: '',
      phone: '',
      phone_valid: false,
      msg_id: '',
      from_me: false,
      message_type: 'text',
      text: '',
      chatwoot_conversation_id: '',
      chatwoot_contact_id: '',
      timestamp: '',
      test_run_id: null,
    },
  ],
});

const loadStateQuery =
  'WITH s AS (\n' +
  "  SELECT json_object_agg(key, value) AS j FROM public.settings\n" +
  '),\n' +
  'ct AS (\n' +
  '  SELECT id::text AS contact_id, do_not_contact, consent_marketing\n' +
  '  FROM public.contacts WHERE phone = $1::text LIMIT 1\n' +
  '),\n' +
  'cv AS (\n' +
  '  SELECT id::text AS conv_id, state, ai_enabled, human_locked, owner_flow,\n' +
  '         journey_started_at, turn_count\n' +
  '  FROM public.conversations\n' +
  "  WHERE chatwoot_conversation_id = NULLIF($2::text, '')::int LIMIT 1\n" +
  '),\n' +
  'camp AS (\n' +
  '  SELECT cc.id::text AS campaign_contact_id, cc.campaign_id::text AS campaign_id, cc.status\n' +
  '  FROM public.campaign_contacts cc\n' +
  '  JOIN public.contacts cnt ON cnt.id = cc.contact_id\n' +
  "  WHERE cnt.phone = $1::text AND cc.status IN ('sent','delivered','replied','interested')\n" +
  '  ORDER BY cc.updated_at DESC LIMIT 1\n' +
  ')\n' +
  'SELECT\n' +
  '  (SELECT j FROM s) AS settings_json,\n' +
  '  (SELECT contact_id FROM ct) AS contact_id,\n' +
  '  (SELECT do_not_contact FROM ct) AS do_not_contact,\n' +
  '  (SELECT conv_id FROM cv) AS conv_id,\n' +
  '  (SELECT state FROM cv) AS conv_state,\n' +
  '  (SELECT ai_enabled FROM cv) AS conv_ai_enabled,\n' +
  '  (SELECT human_locked FROM cv) AS conv_human_locked,\n' +
  '  (SELECT owner_flow FROM cv) AS conv_owner_flow,\n' +
  '  (SELECT journey_started_at::text FROM cv) AS conv_journey_started_at,\n' +
  '  (SELECT turn_count FROM cv) AS conv_turn_count,\n' +
  '  (SELECT campaign_contact_id FROM camp) AS campaign_contact_id,\n' +
  '  (SELECT campaign_id FROM camp) AS campaign_id,\n' +
  '  (SELECT status FROM camp) AS campaign_status;';

const loadState = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load State',
    parameters: {
      operation: 'executeQuery',
      query: loadStateQuery,
      options: {
        queryReplacement:
          "={{ [ $('Normalize Payload').first().json.phone, $('Normalize Payload').first().json.chatwoot_conversation_id ] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [400, 600],
    executeOnce: true,
    alwaysOutputData: true,
  },
  output: [
    {
      settings_json: {},
      contact_id: null,
      do_not_contact: null,
      conv_id: null,
      conv_owner_flow: null,
      conv_journey_started_at: null,
      conv_turn_count: 0,
      campaign_contact_id: null,
    },
  ],
});

const computeGatesJs =
  "const m = $('Normalize Payload').first().json;\n" +
  "const s = $('Load State').first().json;\n" +
  'const settings = (s && s.settings_json) || {};\n' +
  'function asBool(v, fb) { if (v === true || v === "true") return true; if (v === false || v === "false") return false; return fb; }\n' +
  'function asObj(v, fb) { if (v && typeof v === "object" && !Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return (p && typeof p === "object" && !Array.isArray(p)) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asArr(v, fb) { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asStr(v, fb) { if (typeof v === "string") { try { const p = JSON.parse(v); return typeof p === "string" ? p : fb; } catch(e) { return v; } } return fb; }\n' +
  'const aiEnabledGlobal = asBool(settings.ai_enabled_global, true);\n' +
  'const wfEnabled = asObj(settings.workflows_enabled, {});\n' +
  'const wfEnabledThis = wfEnabled.IGOR_01 !== false;\n' +
  'const tz = asStr(settings.timezone, "America/Sao_Paulo");\n' +
  'const ahStart = asStr(settings.after_hours_start, "19:00");\n' +
  'const ahEnd = asStr(settings.after_hours_end, "08:00");\n' +
  'const holidays = asArr(settings.holidays, []);\n' +
  'const holidayPolicy = asStr(settings.holiday_policy, "after_hours_force");\n' +
  'const aiTeamId = (settings.ai_team_id === null || settings.ai_team_id === undefined) ? 1 : Number(settings.ai_team_id);\n' +
  'const humanDaytimeTeamId = (settings.human_daytime_team_id === null || settings.human_daytime_team_id === undefined) ? 1 : Number(settings.human_daytime_team_id);\n' +
  'const ownerFlowBlocked = ["human_daytime", "handoff_queue", "ai_unqualified", "compliance_hold", "opt_out"];\n' +
  'const convOwnerFlow = s.conv_owner_flow || null;\n' +
  'const isOwnerFlowBlocked = convOwnerFlow !== null && ownerFlowBlocked.indexOf(convOwnerFlow) !== -1;\n' +
  'const doNotContact = s.do_not_contact === true;\n' +
  'const journeyStartedAt = s.conv_journey_started_at || null;\n' +
  'const isNewLeadJourney = journeyStartedAt === null;\n' +
  'const hasCampaignActive = !!s.campaign_contact_id;\n' +
  'const now = new Date();\n' +
  'let hh = "00", mm = "00", ymd = now.toISOString().slice(0, 10);\n' +
  'try {\n' +
  '  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });\n' +
  '  const parts = fmt.formatToParts(now).reduce(function(acc, p) { acc[p.type] = p.value; return acc; }, {});\n' +
  '  ymd = (parts.year || "0000") + "-" + (parts.month || "01") + "-" + (parts.day || "01");\n' +
  '  hh = parts.hour || "00";\n' +
  '  mm = parts.minute || "00";\n' +
  '  if (hh === "24") hh = "00";\n' +
  '} catch(e) {}\n' +
  'const curHm = hh + ":" + mm;\n' +
  'function hmToMin(str) { const parts = String(str || "").split(":"); return Number(parts[0] || 0) * 60 + Number(parts[1] || 0); }\n' +
  'const curMin = hmToMin(curHm);\n' +
  'const startMin = hmToMin(ahStart);\n' +
  'const endMin = hmToMin(ahEnd);\n' +
  'let insideBusinessHours;\n' +
  'if (endMin < startMin) insideBusinessHours = (curMin >= endMin && curMin < startMin);\n' +
  'else insideBusinessHours = (curMin >= endMin || curMin < startMin);\n' +
  'const isHoliday = Array.isArray(holidays) && holidays.indexOf(ymd) !== -1;\n' +
  'let effectiveInsideBusinessHours = insideBusinessHours;\n' +
  'if (isHoliday && holidayPolicy === "after_hours_force") effectiveInsideBusinessHours = false;\n' +
  'let blockReason = null;\n' +
  'if (m.from_me) blockReason = "fromMe";\n' +
  'else if (!aiEnabledGlobal) blockReason = "ai_disabled_global";\n' +
  'else if (!wfEnabledThis) blockReason = "workflow_disabled";\n' +
  'else if (!m.phone_valid) blockReason = "invalid_phone";\n' +
  'else if (doNotContact) blockReason = "do_not_contact";\n' +
  'else if (isOwnerFlowBlocked) blockReason = "owner_flow_" + convOwnerFlow;\n' +
  'else if (hasCampaignActive) blockReason = "campaign_active";\n' +
  'const moveToHumanDaytime = (blockReason === null) && (effectiveInsideBusinessHours || !isNewLeadJourney);\n' +
  'const moveReason = moveToHumanDaytime ? (effectiveInsideBusinessHours ? "inside_business_hours" : "existing_journey_after_hours") : null;\n' +
  'const shouldProcessAI = (blockReason === null) && !moveToHumanDaytime;\n' +
  'return [{ json: {\n' +
  '  block_reason: blockReason,\n' +
  '  move_to_human_daytime: moveToHumanDaytime,\n' +
  '  move_reason: moveReason,\n' +
  '  should_process_ai: shouldProcessAI,\n' +
  '  ai_team_id: aiTeamId,\n' +
  '  human_daytime_team_id: humanDaytimeTeamId,\n' +
  '  inside_business_hours: effectiveInsideBusinessHours,\n' +
  '  is_new_lead_journey: isNewLeadJourney,\n' +
  '  is_holiday: isHoliday,\n' +
  '  ymd: ymd,\n' +
  '  current_hm: curHm,\n' +
  '  conv_id: s.conv_id || null,\n' +
  '  campaign_contact_id: s.campaign_contact_id || null,\n' +
  '  campaign_id: s.campaign_id || null,\n' +
  '} }];';

const computeGates = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Gates',
    parameters: { mode: 'runOnceForAllItems', jsCode: computeGatesJs },
    position: [600, 600],
  },
  output: [
    {
      block_reason: null,
      move_to_human_daytime: false,
      should_process_ai: true,
      ai_team_id: 1,
      human_daytime_team_id: 1,
      is_new_lead_journey: true,
    },
  ],
});

const hasBlockReason = ifElse({
  version: 2.3,
  config: {
    name: 'Has Block Reason?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'block-cond',
            leftValue: "={{ $('Compute Gates').first().json.block_reason }}",
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      },
    },
    position: [800, 600],
  },
});

const insertBlockedEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT inbound_blocked',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours_v2', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Normalize Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, m.chatwoot_conversation_id, JSON.stringify({ reason: g.block_reason, msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1000, 480],
    executeOnce: true,
  },
  output: [{}],
});

const respBlocked = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp blocked',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rb-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rb-bl', name: 'blocked', value: true, type: 'boolean' },
          {
            id: 'rb-rs',
            name: 'reason',
            value: "={{ $('Compute Gates').first().json.block_reason }}",
            type: 'string',
          },
          { id: 'rb-br', name: 'branch', value: 'blocked', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1200, 480],
    executeOnce: true,
  },
  output: [{ ok: true, blocked: true, reason: '', branch: 'blocked' }],
});

const moveToHumanIf = ifElse({
  version: 2.3,
  config: {
    name: 'Move to Human?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'move-cond',
            leftValue: "={{ $('Compute Gates').first().json.move_to_human_daytime }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [1000, 720],
  },
});

const upsertConvHumanQuery =
  'WITH ct AS (\n' +
  '  INSERT INTO public.contacts (phone, name)\n' +
  '  VALUES ($1::text, NULLIF($2::text, $3::text))\n' +
  '  ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, $3::text), public.contacts.name), updated_at = now()\n' +
  '  RETURNING id\n' +
  ')\n' +
  'INSERT INTO public.conversations (\n' +
  '  contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state,\n' +
  '  ai_enabled, human_locked, current_flow, owner_flow, assigned_team_id\n' +
  ')\n' +
  "SELECT ct.id, NULLIF($4::text, '')::int, 1, 'human_assigned', false, true, 'after_hours', 'human_daytime', $5::int\n" +
  'FROM ct\n' +
  'ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET\n' +
  "  state = 'human_assigned',\n" +
  '  ai_enabled = false,\n' +
  '  human_locked = true,\n' +
  "  owner_flow = 'human_daytime',\n" +
  '  assigned_team_id = $5::int,\n' +
  '  updated_at = now()\n' +
  'RETURNING id, chatwoot_conversation_id, owner_flow;';

const upsertConvHuman = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT conv human_daytime',
    parameters: {
      operation: 'executeQuery',
      query: upsertConvHumanQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Normalize Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, m.push_name || '', '', m.chatwoot_conversation_id, String(g.human_daytime_team_id)]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1200, 624],
    executeOnce: true,
  },
  output: [{ id: '', chatwoot_conversation_id: 0, owner_flow: 'human_daytime' }],
});

const postAssignHumanTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Human Team',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Normalize Payload').first().json.chatwoot_conversation_id }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ team_id: Number($('Compute Gates').first().json.human_daytime_team_id) }) }}",
      options: {
        response: { response: { neverError: false, responseFormat: 'json' } },
        timeout: 15000,
      },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [1400, 624],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const insertMovedEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT moved_to_human',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_moved_to_human', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours_v2', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Normalize Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, m.chatwoot_conversation_id, JSON.stringify({ reason: g.move_reason, inside_business_hours: g.inside_business_hours, is_new_lead_journey: g.is_new_lead_journey, msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1600, 624],
    executeOnce: true,
  },
  output: [{}],
});

const respMovedToHuman = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp moved_to_human',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rm-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rm-bl', name: 'blocked', value: true, type: 'boolean' },
          {
            id: 'rm-rs',
            name: 'reason',
            value: "={{ $('Compute Gates').first().json.move_reason }}",
            type: 'string',
          },
          { id: 'rm-br', name: 'branch', value: 'moved_to_human_daytime', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 624],
    executeOnce: true,
  },
  output: [{ ok: true, blocked: true, reason: '', branch: 'moved_to_human_daytime' }],
});

const redisLockIncr = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Lock INCR',
    parameters: {
      operation: 'incr',
      key: "={{ 'igor:lock:inbound:' + $('Normalize Payload').first().json.phone }}",
      expire: true,
      ttl: 30,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [1200, 800],
    alwaysOutputData: true,
  },
  output: [{ value: 1 }],
});

const gotLockIf = ifElse({
  version: 2.3,
  config: {
    name: 'Got Lock?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'got-lock-cond',
            leftValue: "={{ Number($('Redis Lock INCR').first().json.value) }}",
            rightValue: 1,
            operator: { type: 'number', operation: 'equals', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [1400, 800],
  },
});

const redisRpushFragment = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis RPUSH fragment',
    parameters: {
      operation: 'push',
      list: "={{ 'igor:batch:fragments:' + $('Normalize Payload').first().json.phone }}",
      messageData:
        "={{ JSON.stringify({ text: $('Normalize Payload').first().json.text || '', caption: $('Normalize Payload').first().json.caption || '', msg_id: $('Normalize Payload').first().json.msg_id, timestamp: $('Normalize Payload').first().json.timestamp }) }}",
      tail: true,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [1600, 912],
  },
  output: [{ value: 1 }],
});

const redisMarkerIncr = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis EXPIRE marker',
    parameters: {
      operation: 'incr',
      key: "={{ 'igor:batch:marker:' + $('Normalize Payload').first().json.phone }}",
      expire: true,
      ttl: 60,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [1800, 912],
  },
  output: [{ value: 1 }],
});

const respBatched = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp batched',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rbat-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rbat-br', name: 'branch', value: 'batched_lock_held', type: 'string' },
          {
            id: 'rbat-cn',
            name: 'counter',
            value: "={{ $('Redis Lock INCR').first().json.value }}",
            type: 'number',
          },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2000, 912],
  },
  output: [{ ok: true, branch: 'batched_lock_held' }],
});

const waitBatch = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait 3s',
    parameters: { amount: 3, unit: 'seconds' },
    position: [1600, 720],
  },
  output: [{}],
});

const redisLrangeBatch = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Get Batch',
    parameters: {
      operation: 'get',
      key: "={{ 'igor:batch:fragments:' + $('Normalize Payload').first().json.phone }}",
      keyType: 'list',
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [1800, 720],
    alwaysOutputData: true,
  },
  output: [{ propertyName: [] }],
});

const redisDelBatch = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis DEL batch',
    parameters: {
      operation: 'delete',
      key: "={{ 'igor:batch:fragments:' + $('Normalize Payload').first().json.phone }}",
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [2000, 720],
  },
  output: [{}],
});

const mergeFragmentsJs =
  "const m = $('Normalize Payload').first().json;\n" +
  "let batch = $('Redis Get Batch').first().json;\n" +
  'let fragments = [];\n' +
  'if (batch) {\n' +
  '  const candidate = batch.propertyName || batch.value || batch;\n' +
  '  if (Array.isArray(candidate)) fragments = candidate;\n' +
  '  else if (typeof candidate === "string") {\n' +
  '    try { const p = JSON.parse(candidate); if (Array.isArray(p)) fragments = p; } catch(e) {}\n' +
  '  }\n' +
  '}\n' +
  'const parsedFragments = fragments.map(function(f) {\n' +
  '  if (typeof f === "string") { try { return JSON.parse(f); } catch(e) { return { text: f }; } }\n' +
  '  return f || {};\n' +
  '});\n' +
  'const texts = [];\n' +
  'parsedFragments.forEach(function(p) { if (p.text) texts.push(p.text); if (p.caption) texts.push(p.caption); });\n' +
  'if (texts.length === 0 && m.text) texts.push(m.text);\n' +
  'if (texts.length === 0 && m.caption) texts.push(m.caption);\n' +
  'const mergedText = texts.join("\\n").trim();\n' +
  'return [{ json: { merged_text: mergedText, fragments_count: parsedFragments.length || 1, fragments: parsedFragments } }];';

const mergeFragments = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Fragments',
    parameters: { mode: 'runOnceForAllItems', jsCode: mergeFragmentsJs },
    position: [2200, 720],
  },
  output: [{ merged_text: '', fragments_count: 1, fragments: [] }],
});

const hasMediaIf = ifElse({
  version: 2.3,
  config: {
    name: 'Has Media?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'has-media-cond',
            leftValue: "={{ $('Normalize Payload').first().json.message_type }}",
            rightValue: 'text',
            operator: { type: 'string', operation: 'notEquals', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [2400, 720],
  },
});

const callIgor02 = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_02 Media',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: 'GBmG9WZzW2p8Nn6f',
        cachedResultName: 'IGOR_02_Media_Normalizer',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          msg_id: "={{ $('Normalize Payload').first().json.msg_id }}",
          phone: "={{ $('Normalize Payload').first().json.phone }}",
          message_type: "={{ $('Normalize Payload').first().json.message_type }}",
          media_url: "={{ $('Normalize Payload').first().json.media_url }}",
          media_base64: "={{ $('Normalize Payload').first().json.media_base64 }}",
          mime_type: "={{ $('Normalize Payload').first().json.mime_type }}",
          caption: "={{ $('Normalize Payload').first().json.caption }}",
          test_run_id: "={{ $('Normalize Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'msg_id', displayName: 'msg_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'message_type', displayName: 'message_type', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'media_url', displayName: 'media_url', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'media_base64', displayName: 'media_base64', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'mime_type', displayName: 'mime_type', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'caption', displayName: 'caption', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { waitForSubWorkflow: true },
    },
    position: [2600, 624],
    executeOnce: true,
  },
  output: [{ normalized_text: '', safety_flags: {}, should_handoff: false, handoff_reason: null }],
});

const passthroughMedia = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Media Passthrough',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'nm-nt', name: 'normalized_text', value: '', type: 'string' },
          { id: 'nm-sf', name: 'safety_flags', value: '={{ ({ clinical: false, sensitive_image: false, payment_proof: false }) }}', type: 'object' },
          { id: 'nm-sh', name: 'should_handoff', value: false, type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2600, 816],
    executeOnce: true,
  },
  output: [{ normalized_text: '', safety_flags: {}, should_handoff: false }],
});

const mergeMediaBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Media Branches',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [2800, 720],
  },
});

const buildOutputJs =
  "const m = $('Normalize Payload').first().json;\n" +
  "const mf = $('Merge Fragments').first().json;\n" +
  "const mediaInput = $input.first().json || {};\n" +
  'let normalizedText = mf.merged_text || m.text || "";\n' +
  'let safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n' +
  'let shouldHandoff = false;\n' +
  'let handoffReason = null;\n' +
  'if (m.message_type && m.message_type !== "text" && mediaInput && mediaInput.normalized_text !== undefined) {\n' +
  '  const mediaText = String(mediaInput.normalized_text || "");\n' +
  '  if (mediaText) normalizedText = normalizedText ? (normalizedText + "\\n" + mediaText) : mediaText;\n' +
  '  if (mediaInput.safety_flags && typeof mediaInput.safety_flags === "object") safetyFlags = mediaInput.safety_flags;\n' +
  '  if (mediaInput.should_handoff === true) shouldHandoff = true;\n' +
  '  if (mediaInput.handoff_reason) handoffReason = mediaInput.handoff_reason;\n' +
  '}\n' +
  'return [{ json: {\n' +
  '  phone: m.phone,\n' +
  '  msg_id: m.msg_id,\n' +
  '  message_type: m.message_type,\n' +
  '  chatwoot_conversation_id: m.chatwoot_conversation_id,\n' +
  '  chatwoot_contact_id: m.chatwoot_contact_id,\n' +
  '  instance: m.instance,\n' +
  '  push_name: m.push_name,\n' +
  '  timestamp: m.timestamp,\n' +
  '  normalized_text: normalizedText,\n' +
  '  fragments_count: mf.fragments_count || 1,\n' +
  '  safety_flags: safetyFlags,\n' +
  '  should_handoff: shouldHandoff,\n' +
  '  handoff_reason: handoffReason,\n' +
  '  test_run_id: m.test_run_id,\n' +
  '} }];';

const buildOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Normalized Output',
    parameters: { mode: 'runOnceForAllItems', jsCode: buildOutputJs },
    position: [3000, 720],
  },
  output: [
    {
      phone: '',
      msg_id: '',
      message_type: 'text',
      chatwoot_conversation_id: '',
      normalized_text: '',
      safety_flags: {},
      should_handoff: false,
    },
  ],
});

const upsertConvAiQuery =
  'WITH ct AS (\n' +
  '  INSERT INTO public.contacts (phone, name)\n' +
  '  VALUES ($1::text, NULLIF($2::text, $3::text))\n' +
  '  ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, $3::text), public.contacts.name), updated_at = now()\n' +
  '  RETURNING id\n' +
  ')\n' +
  'INSERT INTO public.conversations (\n' +
  '  contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state,\n' +
  '  ai_enabled, human_locked, current_flow, owner_flow,\n' +
  '  assigned_team_id, journey_started_at, turn_count, last_message_at\n' +
  ')\n' +
  "SELECT ct.id, NULLIF($4::text, '')::int, 1,\n" +
  "  'ai_after_hours', true, false, 'after_hours', 'ai_active',\n" +
  "  $5::int, now(), 1, COALESCE(NULLIF($6::text, '')::timestamptz, now())\n" +
  'FROM ct\n' +
  'ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET\n' +
  "  state = 'ai_after_hours',\n" +
  '  ai_enabled = true,\n' +
  "  owner_flow = 'ai_active',\n" +
  '  assigned_team_id = $5::int,\n' +
  '  journey_started_at = COALESCE(public.conversations.journey_started_at, now()),\n' +
  '  turn_count = public.conversations.turn_count + 1,\n' +
  '  last_message_at = EXCLUDED.last_message_at,\n' +
  '  updated_at = now()\n' +
  'RETURNING id::text AS conversation_uuid, chatwoot_conversation_id, owner_flow, journey_started_at, turn_count;';

const upsertConvAi = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT conv ai_active',
    parameters: {
      operation: 'executeQuery',
      query: upsertConvAiQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const o = $('Build Normalized Output').first().json; const g = $('Compute Gates').first().json; return [o.phone, o.push_name || '', '', o.chatwoot_conversation_id, String(g.ai_team_id), o.timestamp]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3200, 720],
  },
  output: [{ conversation_uuid: '', chatwoot_conversation_id: 0, owner_flow: 'ai_active', turn_count: 1 }],
});

const upsertMessageQuery =
  'INSERT INTO public.messages (\n' +
  '  conversation_id, msg_id, text, normalized_text, message_type,\n' +
  '  direction, role, from_me, media_url, media_mime_type, safety_flags, created_at\n' +
  ')\n' +
  "SELECT c.id, NULLIF($1::text, ''), NULLIF($2::text, ''), NULLIF($3::text, ''),\n" +
  "  COALESCE(NULLIF($4::text, ''), 'text'), 'inbound', 'user', false,\n" +
  "  NULLIF($5::text, ''), NULLIF($6::text, ''),\n" +
  "  COALESCE(NULLIF($7::text, '')::jsonb, '{}'::jsonb),\n" +
  "  COALESCE(NULLIF($8::text, '')::timestamptz, now())\n" +
  'FROM public.conversations c\n' +
  "WHERE c.chatwoot_conversation_id = NULLIF($9::text, '')::int\n" +
  'ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE\n' +
  'SET text = EXCLUDED.text, normalized_text = EXCLUDED.normalized_text;';

const upsertMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT message inbound',
    parameters: {
      operation: 'executeQuery',
      query: upsertMessageQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const o = $('Build Normalized Output').first().json; const m = $('Normalize Payload').first().json; return [o.msg_id, m.text || '', o.normalized_text, o.message_type, m.media_url || '', m.mime_type || '', JSON.stringify(o.safety_flags || {}), o.timestamp, o.chatwoot_conversation_id]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3400, 720],
  },
  output: [{}],
});

const postAssignAiTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign AI Team',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Build Normalized Output').first().json.chatwoot_conversation_id }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ team_id: Number($('Compute Gates').first().json.ai_team_id) }) }}",
      options: { response: { response: { neverError: false, responseFormat: 'json' } }, timeout: 15000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [3600, 720],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const callIgor04Labels = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_04 Labels',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: 'AJF7dhGrqJEXMLqz',
        cachedResultName: 'IGOR_04_Tool_Labels_Attributes',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Build Normalized Output').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Build Normalized Output').first().json.chatwoot_contact_id }}",
          labels_to_add: "={{ ['lead_novo', 'fora_expediente', 'ai_after_hours'] }}",
          labels_to_remove: '={{ [] }}',
          custom_attributes:
            "={{ ({ conversation: { automation_state: 'ai_after_hours', owner_flow: 'ai_active', lead_status: 'qualificacao_inicial' }, contact: {} }) }}",
          test_run_id: "={{ $('Build Normalized Output').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'labels_to_add', displayName: 'labels_to_add', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' },
          { id: 'labels_to_remove', displayName: 'labels_to_remove', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' },
          { id: 'custom_attributes', displayName: 'custom_attributes', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { waitForSubWorkflow: true },
    },
    position: [3800, 720],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const callIgor03 = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_03 Agent',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: 'iQCVbe1P8dC0vhay',
        cachedResultName: 'IGOR_03_Agent_AfterHours',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          phone: "={{ $('Build Normalized Output').first().json.phone }}",
          msgId: "={{ $('Build Normalized Output').first().json.msg_id }}",
          chatwoot_conversation_id: "={{ $('Build Normalized Output').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Build Normalized Output').first().json.chatwoot_contact_id }}",
          normalized_text: "={{ $('Build Normalized Output').first().json.normalized_text }}",
          safety_flags: "={{ $('Build Normalized Output').first().json.safety_flags }}",
          should_handoff: "={{ $('Build Normalized Output').first().json.should_handoff }}",
          handoff_reason: "={{ $('Build Normalized Output').first().json.handoff_reason || '' }}",
          fragments_count: "={{ $('Build Normalized Output').first().json.fragments_count }}",
          test_run_id: "={{ $('Build Normalized Output').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'msgId', displayName: 'msgId', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'normalized_text', displayName: 'normalized_text', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'safety_flags', displayName: 'safety_flags', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' },
          { id: 'should_handoff', displayName: 'should_handoff', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'boolean' },
          { id: 'handoff_reason', displayName: 'handoff_reason', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'fragments_count', displayName: 'fragments_count', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { waitForSubWorkflow: true },
    },
    position: [4000, 720],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const redisDelLock = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis DEL lock',
    parameters: {
      operation: 'delete',
      key: "={{ 'igor:lock:inbound:' + $('Normalize Payload').first().json.phone }}",
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [4200, 720],
  },
  output: [{}],
});

const respRouted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp routed_to_IGOR_03',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rok-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rok-bl', name: 'blocked', value: false, type: 'boolean' },
          { id: 'rok-br', name: 'branch', value: 'routed_ai_after_hours', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [4400, 720],
    executeOnce: true,
  },
  output: [{ ok: true, blocked: false, branch: 'routed_ai_after_hours' }],
});

export default workflow('igor-01-v2', 'IGOR_01_Inbound_AfterHours_v2')
  .add(evolutionWebhook)
  .to(normalizePayload)
  .to(loadState)
  .to(computeGates)
  .to(
    hasBlockReason
      .onTrue(insertBlockedEvent.to(respBlocked))
      .onFalse(
        moveToHumanIf
          .onTrue(upsertConvHuman.to(postAssignHumanTeam.to(insertMovedEvent.to(respMovedToHuman))))
          .onFalse(
            redisLockIncr.to(
              gotLockIf
                .onTrue(
                  waitBatch.to(
                    redisLrangeBatch.to(
                      redisDelBatch.to(
                        mergeFragments.to(
                          hasMediaIf
                            .onTrue(callIgor02.to(mergeMediaBranches.input(0)))
                            .onFalse(passthroughMedia.to(mergeMediaBranches.input(1)))
                        )
                      )
                    )
                  )
                )
                .onFalse(redisRpushFragment.to(redisMarkerIncr.to(respBatched)))
            )
          )
      )
  )
  .add(mergeMediaBranches)
  .to(buildOutput)
  .to(upsertConvAi)
  .to(upsertMessage)
  .to(postAssignAiTeam)
  .to(callIgor04Labels)
  .to(callIgor03)
  .to(redisDelLock)
  .to(respRouted);
