// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_01_Inbound_AfterHours.json`
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "settings.availableInMCP": true
//   - "tags": ["igor", "inbound", "webhook", "router", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the five properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// FORWARD DEPENDENCIES (placeholders — to be wired in subsequent waves):
//   - IGOR_03_Agent_AfterHours (Wave 4) — referenced only via events log
//     'inbound_routed_pending_IGOR_03'. The executeWorkflow node is NOT
//     materialized for IGOR_03 yet to avoid a hard reference to a missing
//     workflowId. When IGOR_03 is built, add the executeWorkflow node and
//     remove this placeholder log.
//   - IGOR_12_Campaign_Inbound_Handler — campaign phase. Same approach:
//     events('campaign_routed_pending_IGOR_12'). Wire executeWorkflow when
//     IGOR_12 exists.
//
// =============================================================================
// IGOR_01_Inbound_AfterHours
// =============================================================================
// Webhook (POST /webhook/igor/inbound) recebe payload Evolution MESSAGES_UPSERT.
//
// Matriz de bloqueio determinístico — 12 condições EM ORDEM (cada uma fecha
// curto-circuito em NoOp + events('inbound_blocked', reason=<exata>)):
//   1.  fromMe=true                                  -> events.fromMe
//   2.  settings.ai_enabled_global=false             -> events.ai_disabled_global
//   3.  settings.workflows_enabled.IGOR_01=false     -> events.workflow_disabled
//   4.  phone inválido (regex 55+DDD+9digits)         -> events.invalid_phone
//   5.  contacts.do_not_contact=true                 -> IGOR_04 label 'optout'
//                                                       + events.opt_out
//   6.  conversations.human_locked OR ai_enabled=false -> events.human_locked_or_ai_disabled
//   7.  campaign_contacts.status IN (sent,delivered,replied,interested)
//                                                    -> events.campaign_routed_pending_IGOR_12
//                                                       (placeholder; IGOR_12 wire futuro)
//   8.  hora ∈ [after_hours_end, after_hours_start)  -> events.inside_hours
//   9.  data ∈ settings.holidays (YYYY-MM-DD)         -> holiday_policy P1=after_hours_force
//                                                       (continua o fluxo)
//   10. Redis lock atômico igor:lock:inbound:{phone}
//       via INCR + EXPIRE 30. Se INCR != 1 (lock held por outro fragment) ->
//       RPUSH igor:batch:{phone} fragment + EXPIRE 60 + events.inbound_batched +
//       NoOp end. Senão (got lock=INCR===1) -> wait 3s + LRANGE batch + DEL
//       batch + merge fragments (atual + LRANGE).
//   11. messageType != text -> executeWorkflow IGOR_02_Media_Normalizer
//   12. UPSERT conversations.state='ai_after_hours' + UPSERT messages +
//       executeWorkflow IGOR_04 (labels=['fora_expediente'] +
//       custom_attributes.conversation.automation_state='ai_after_hours') +
//       events('inbound_routed_pending_IGOR_03', payload) placeholder.
//       (Wave 4 substitui events placeholder por executeWorkflow IGOR_03.)
//
// Sempre ao final do fluxo "got lock": DEL igor:lock:inbound:{phone}.
//
// Sem LLM (router puro). Errors -> IGOR_07_Error_Logger via settings.errorWorkflow.
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

const IGOR_02_WORKFLOW_ID = 'GBmG9WZzW2p8Nn6f';
const IGOR_04_WORKFLOW_ID = 'AJF7dhGrqJEXMLqz';

// -----------------------------------------------------------------------------
// 1) TRIGGER — webhook POST /igor/inbound
// -----------------------------------------------------------------------------

const webhookTrigger = trigger({
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
    position: [-1200, 0],
  },
  output: [
    {
      body: {
        event: 'messages.upsert',
        instance: 'dr_igor',
        data: {
          key: {
            id: 'EVOLUTION_MSG_ID_001',
            remoteJid: '5511999990001@s.whatsapp.net',
            fromMe: false,
          },
          messageType: 'conversation',
          message: { conversation: 'Oi, queria saber sobre tratamento de cicatriz' },
          messageTimestamp: 1779881400,
          pushName: 'Lead Teste',
        },
        chatwoot_conversation_id: 9101,
        chatwoot_contact_id: 5101,
        additional_attributes: { test_run_id: 'IGOR_01_FIXTURE_text_afterhours' },
      },
    },
  ],
});

// -----------------------------------------------------------------------------
// 2) NORMALIZE PAYLOAD — extrai todos os campos do Evolution MESSAGES_UPSERT
// -----------------------------------------------------------------------------

const normalizePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const items = $input.all();\n" +
        "return items.map(item => {\n" +
        "  const root = item.json || {};\n" +
        "  const b = root.body || root;\n" +
        "  const data = b.data || {};\n" +
        "  const key = data.key || {};\n" +
        "  const message = data.message || {};\n" +
        "  const additional = b.additional_attributes || {};\n" +
        "  const msgId = key.id ? String(key.id) : '';\n" +
        "  const remoteJid = key.remoteJid ? String(key.remoteJid) : '';\n" +
        "  const rawPhone = remoteJid.split('@')[0] || '';\n" +
        "  const fromMe = key.fromMe === true;\n" +
        "  let messageType = data.messageType || '';\n" +
        "  if (messageType === 'conversation' || messageType === 'extendedTextMessage') messageType = 'text';\n" +
        "  else if (messageType === 'audioMessage' || messageType === 'pttMessage') messageType = 'audio';\n" +
        "  else if (messageType === 'imageMessage') messageType = 'image';\n" +
        "  else if (messageType === 'documentMessage' || messageType === 'documentWithCaptionMessage') messageType = 'document';\n" +
        "  else if (messageType === 'videoMessage') messageType = 'video';\n" +
        "  else if (!messageType) messageType = 'unknown';\n" +
        "  let text = '';\n" +
        "  let caption = '';\n" +
        "  let mediaUrl = '';\n" +
        "  let mediaBase64 = '';\n" +
        "  let mimeType = '';\n" +
        "  if (message.conversation) text = String(message.conversation);\n" +
        "  else if (message.extendedTextMessage && message.extendedTextMessage.text) text = String(message.extendedTextMessage.text);\n" +
        "  if (message.audioMessage) {\n" +
        "    mimeType = String(message.audioMessage.mimetype || 'audio/ogg');\n" +
        "    mediaUrl = String(message.audioMessage.url || '');\n" +
        "  } else if (message.imageMessage) {\n" +
        "    mimeType = String(message.imageMessage.mimetype || 'image/jpeg');\n" +
        "    mediaUrl = String(message.imageMessage.url || '');\n" +
        "    caption = String(message.imageMessage.caption || '');\n" +
        "  } else if (message.documentMessage) {\n" +
        "    mimeType = String(message.documentMessage.mimetype || 'application/pdf');\n" +
        "    mediaUrl = String(message.documentMessage.url || '');\n" +
        "    caption = String(message.documentMessage.caption || message.documentMessage.title || '');\n" +
        "  }\n" +
        "  if (data.mediaBase64) mediaBase64 = String(data.mediaBase64);\n" +
        "  else if (data.media_base64) mediaBase64 = String(data.media_base64);\n" +
        "  const tsRaw = data.messageTimestamp;\n" +
        "  let timestamp;\n" +
        "  if (typeof tsRaw === 'number') timestamp = new Date(tsRaw * 1000).toISOString();\n" +
        "  else if (typeof tsRaw === 'string' && /^\\d+$/.test(tsRaw)) timestamp = new Date(Number(tsRaw) * 1000).toISOString();\n" +
        "  else timestamp = new Date().toISOString();\n" +
        "  const conversationId = (b.chatwoot_conversation_id !== undefined && b.chatwoot_conversation_id !== null) ? String(b.chatwoot_conversation_id) : '';\n" +
        "  const contactId = (b.chatwoot_contact_id !== undefined && b.chatwoot_contact_id !== null) ? String(b.chatwoot_contact_id) : '';\n" +
        "  const instance = String(b.instance || '');\n" +
        "  const pushName = String((data.pushName) || '');\n" +
        "  const testRunId = additional.test_run_id || (b.test_run_id) || null;\n" +
        "  return {\n" +
        "    json: {\n" +
        "      raw_phone: rawPhone,\n" +
        "      msg_id: msgId,\n" +
        "      from_me: fromMe,\n" +
        "      message_type: messageType,\n" +
        "      text: text,\n" +
        "      caption: caption,\n" +
        "      media_url: mediaUrl,\n" +
        "      media_base64: mediaBase64,\n" +
        "      mime_type: mimeType,\n" +
        "      chatwoot_conversation_id: conversationId,\n" +
        "      chatwoot_contact_id: contactId,\n" +
        "      instance: instance,\n" +
        "      push_name: pushName,\n" +
        "      timestamp: timestamp,\n" +
        "      test_run_id: testRunId,\n" +
        "      raw_payload_json: JSON.stringify(b),\n" +
        "    },\n" +
        "  };\n" +
        "});",
    },
    position: [-980, 0],
  },
  output: [
    {
      raw_phone: '5511999990001',
      msg_id: 'EVOLUTION_MSG_ID_001',
      from_me: false,
      message_type: 'text',
      text: 'Oi, queria saber sobre tratamento de cicatriz',
      caption: '',
      media_url: '',
      media_base64: '',
      mime_type: '',
      chatwoot_conversation_id: '9101',
      chatwoot_contact_id: '5101',
      instance: 'dr_igor',
      push_name: 'Lead Teste',
      timestamp: '2026-05-15T22:30:00.000Z',
      test_run_id: 'IGOR_01_FIXTURE_text_afterhours',
      raw_payload_json: '{}',
    },
  ],
});

// -----------------------------------------------------------------------------
// 3) LOG inbound_received
// -----------------------------------------------------------------------------

const logInboundReceived = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT inbound_received',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'inbound_received',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ msg_id: m.msg_id, message_type: m.message_type, from_me: m.from_me, instance: m.instance, content_length: (m.text || '').length, has_media_url: !!m.media_url, has_media_base64: !!m.media_base64, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [-760, 0],
  },
  output: [{ executionStatus: 'success' }],
});

// -----------------------------------------------------------------------------
// COND 1: fromMe -> block
// -----------------------------------------------------------------------------

const ifFromMe = ifElse({
  version: 2.3,
  config: {
    name: 'COND1 fromMe?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'c1-frommie',
            leftValue: expr("={{ $('Normalize Payload').first().json.from_me }}"),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [-540, 0],
  },
});

// Block event insert + block response set (inlined per node — SDK does not allow function declarations).
const blockFromMe = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block fromMe',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'inbound_blocked',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'fromMe', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [-320, -220],
  },
  output: [{ executionStatus: 'success' }],
});

const respFromMe = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp fromMe',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rfm-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rfm-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rfm-br', name: 'branch', value: 'blocked_fromMe', type: 'string' },
          { id: 'rfm-cd', name: 'blocked_at_condition', value: 1, type: 'number' },
          { id: 'rfm-rs', name: 'reason', value: 'fromMe', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [-100, -220],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_fromMe', blocked_at_condition: 1, reason: 'fromMe' }],
});

// -----------------------------------------------------------------------------
// READ SETTINGS — 7 keys
// -----------------------------------------------------------------------------

const readSettings = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Read Settings',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT\n" +
        "  (SELECT value::text FROM public.settings WHERE key='ai_enabled_global')   AS ai_enabled_global,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='workflows_enabled')   AS workflows_enabled,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='holidays')            AS holidays,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='holiday_policy')      AS holiday_policy,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='after_hours_start')   AS after_hours_start,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='after_hours_end')     AS after_hours_end,\n" +
        "  (SELECT value::text FROM public.settings WHERE key='timezone')            AS timezone;",
      options: {},
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    continueOnFail: true,
    position: [-320, 220],
  },
  output: [
    {
      ai_enabled_global: 'true',
      workflows_enabled: '{"IGOR_01":true,"IGOR_03":true,"IGOR_10":true}',
      holidays: '["2026-12-25","2026-01-01"]',
      holiday_policy: '"after_hours_force"',
      after_hours_start: '"19:00"',
      after_hours_end: '"08:00"',
      timezone: '"America/Sao_Paulo"',
    },
  ],
});

// -----------------------------------------------------------------------------
// COND 2: ai_enabled_global=false
// -----------------------------------------------------------------------------

const ifAiDisabledGlobal = ifElse({
  version: 2.3,
  config: {
    name: 'COND2 ai_disabled_global?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'c2-ai-disabled',
            leftValue: expr(
              "={{ (function(){ try { return JSON.parse(($('Read Settings').first().json.ai_enabled_global || 'true')) === false; } catch(e) { return ($('Read Settings').first().json.ai_enabled_global || 'true').toString().toLowerCase() === 'false'; } })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [-100, 220],
  },
});

const blockAiDisabledGlobal = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block ai_disabled_global',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours', $3::jsonb);",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'ai_disabled_global', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [120, 60],
  },
  output: [{ executionStatus: 'success' }],
});
const respAiDisabledGlobal = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp ai_disabled_global',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rad-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rad-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rad-br', name: 'branch', value: 'blocked_ai_disabled_global', type: 'string' },
          { id: 'rad-cd', name: 'blocked_at_condition', value: 2, type: 'number' },
          { id: 'rad-rs', name: 'reason', value: 'ai_disabled_global', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [340, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_ai_disabled_global' }],
});

// -----------------------------------------------------------------------------
// COND 3: workflows_enabled.IGOR_01=false
// -----------------------------------------------------------------------------

const ifWorkflowDisabled = ifElse({
  version: 2.3,
  config: {
    name: 'COND3 workflow_disabled?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'c3-wf-disabled',
            leftValue: expr(
              "={{ (function(){ try { const we = JSON.parse(($('Read Settings').first().json.workflows_enabled || '{}')); return we && we.IGOR_01 === false; } catch(e) { return false; } })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [560, 220],
  },
});

const blockWorkflowDisabled = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block workflow_disabled',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours', $3::jsonb);",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'workflow_disabled', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [780, 60],
  },
  output: [{ executionStatus: 'success' }],
});
const respWorkflowDisabled = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp workflow_disabled',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rwd-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rwd-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rwd-br', name: 'branch', value: 'blocked_workflow_disabled', type: 'string' },
          { id: 'rwd-cd', name: 'blocked_at_condition', value: 3, type: 'number' },
          { id: 'rwd-rs', name: 'reason', value: 'workflow_disabled', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1000, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_workflow_disabled' }],
});

// -----------------------------------------------------------------------------
// COND 4: Normalize Phone (regex 55+DDD+9digits)
// -----------------------------------------------------------------------------

const normalizePhone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Phone',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const m = $('Normalize Payload').first().json;\n" +
        "const raw = String(m.raw_phone || '');\n" +
        "let digits = raw.replace(/\\D/g, '');\n" +
        "if (digits.length === 13 && digits.startsWith('55')) {\n" +
        "  const ddd = digits.substring(2, 4);\n" +
        "  const rest = digits.substring(4);\n" +
        "  if (/^[1-9][0-9]$/.test(ddd) && /^9\\d{8}$/.test(rest)) {\n" +
        "    return [{ json: { phone: digits, phone_valid: true, raw_phone: raw } }];\n" +
        "  }\n" +
        "}\n" +
        "if (digits.length === 12 && digits.startsWith('55')) {\n" +
        "  const ddd = digits.substring(2, 4);\n" +
        "  const rest = digits.substring(4);\n" +
        "  if (/^[1-9][0-9]$/.test(ddd) && /^\\d{8}$/.test(rest)) {\n" +
        "    const normalized = '55' + ddd + '9' + rest;\n" +
        "    return [{ json: { phone: normalized, phone_valid: true, phone_normalized_from_8_digits: true, raw_phone: raw } }];\n" +
        "  }\n" +
        "}\n" +
        "return [{ json: { phone: '', phone_valid: false, raw_phone: raw, reason: 'invalid_format_expected_55DDD9DDDDDDDD' } }];",
    },
    position: [1220, 220],
  },
  output: [
    { phone: '5511999990001', phone_valid: true, raw_phone: '5511999990001' },
  ],
});

const ifPhoneInvalid = ifElse({
  version: 2.3,
  config: {
    name: 'COND4 phone invalid?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'c4-invalid',
            leftValue: expr("={{ $('Normalize Phone').first().json.phone_valid }}"),
            rightValue: false,
            operator: { type: 'boolean', operation: 'false', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [1440, 220],
  },
});

const insertInvalidPhone = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT invalid_phone',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'invalid_phone',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; const p = $('Normalize Phone').first().json; return [p.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ raw_phone: p.raw_phone, reason: p.reason || 'invalid_phone', msg_id: m.msg_id, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [1660, 60],
  },
  output: [{ executionStatus: 'success' }],
});

const respInvalidPhone = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp invalid_phone',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rip-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rip-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rip-br', name: 'branch', value: 'blocked_invalid_phone', type: 'string' },
          { id: 'rip-cd', name: 'blocked_at_condition', value: 4, type: 'number' },
          { id: 'rip-rs', name: 'reason', value: 'invalid_phone', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1880, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_invalid_phone' }],
});

// -----------------------------------------------------------------------------
// COND 5: contacts.do_not_contact=true
// -----------------------------------------------------------------------------

const lookupContact = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Contact',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT\n" +
        "  c.id::text AS contact_id,\n" +
        "  c.phone,\n" +
        "  c.do_not_contact,\n" +
        "  c.consent_marketing,\n" +
        "  c.optout_at::text AS optout_at\n" +
        "FROM public.contacts c\n" +
        "WHERE c.phone = $1::text\n" +
        "LIMIT 1;",
      options: {
        queryReplacement: expr("={{ $('Normalize Phone').first().json.phone }}"),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    continueOnFail: true,
    alwaysOutputData: true,
    position: [2100, 220],
  },
  output: [
    { contact_id: 'uuid-contact-row', phone: '5511999990001', do_not_contact: false, consent_marketing: true, optout_at: null },
  ],
});

const ifDoNotContact = ifElse({
  version: 2.3,
  config: {
    name: 'COND5 do_not_contact?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'c5-dnc',
            leftValue: expr(
              "={{ (function(){ const all = $('Lookup Contact').all(); if (!all || all.length === 0) return false; const c = all[0].json || {}; return c.do_not_contact === true; })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [2320, 220],
  },
});

const callIgor04Optout = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'CALL IGOR_04 optout label',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: IGOR_04_WORKFLOW_ID,
        cachedResultName: 'IGOR_04_Tool_Labels_Attributes',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: expr(
            "={{ $('Normalize Payload').first().json.chatwoot_conversation_id }}"
          ),
          chatwoot_contact_id: expr(
            "={{ $('Normalize Payload').first().json.chatwoot_contact_id }}"
          ),
          labels_to_add: expr("={{ ['optout'] }}"),
          labels_to_remove: expr('={{ [] }}'),
          custom_attributes: expr(
            "={{ ({ conversation: { automation_state: 'opt_out_blocked' }, contact: { do_not_contact: true } }) }}"
          ),
          test_run_id: expr("={{ $('Normalize Payload').first().json.test_run_id }}"),
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
    continueOnFail: true,
    position: [2540, 60],
  },
  output: [{ ok: true }],
});

const blockOptOut = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block opt_out',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours', $3::jsonb);",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'opt_out', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [2760, 60],
  },
  output: [{ executionStatus: 'success' }],
});
const respOptOut = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp opt_out',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'roo-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'roo-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'roo-br', name: 'branch', value: 'blocked_opt_out', type: 'string' },
          { id: 'roo-cd', name: 'blocked_at_condition', value: 5, type: 'number' },
          { id: 'roo-rs', name: 'reason', value: 'opt_out', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2980, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_opt_out' }],
});

// -----------------------------------------------------------------------------
// COND 6: conversations.human_locked OR ai_enabled=false
// -----------------------------------------------------------------------------

const lookupConversation = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Conversation',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT\n" +
        "  cv.id::text AS conv_id,\n" +
        "  cv.chatwoot_conversation_id::text AS cw_conv_id,\n" +
        "  cv.state,\n" +
        "  cv.ai_enabled,\n" +
        "  cv.human_locked,\n" +
        "  cv.current_flow\n" +
        "FROM public.conversations cv\n" +
        "WHERE cv.chatwoot_conversation_id = NULLIF($1::text, '')::int\n" +
        "LIMIT 1;",
      options: {
        queryReplacement: expr(
          "={{ $('Normalize Payload').first().json.chatwoot_conversation_id }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    continueOnFail: true,
    alwaysOutputData: true,
    position: [3200, 220],
  },
  output: [
    { conv_id: 'uuid-conv-row', cw_conv_id: '9101', state: 'new', ai_enabled: true, human_locked: false, current_flow: null },
  ],
});

const ifConversationLocked = ifElse({
  version: 2.3,
  config: {
    name: 'COND6 human_locked OR ai_disabled?',
    parameters: {
      conditions: {
        combinator: 'or',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'c6-hl',
            leftValue: expr(
              "={{ (function(){ const all = $('Lookup Conversation').all(); if (!all || all.length === 0) return false; const cv = all[0].json || {}; if (!cv || cv.conv_id === undefined) return false; return cv.human_locked === true; })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
          {
            id: 'c6-ai-off',
            leftValue: expr(
              "={{ (function(){ const all = $('Lookup Conversation').all(); if (!all || all.length === 0) return false; const cv = all[0].json || {}; if (!cv || cv.conv_id === undefined) return false; return cv.ai_enabled === false; })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [3420, 220],
  },
});

const blockConvLocked = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block human_locked_or_ai_disabled',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours', $3::jsonb);",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'human_locked_or_ai_disabled', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [3640, 60],
  },
  output: [{ executionStatus: 'success' }],
});
const respConvLocked = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp human_locked_or_ai_disabled',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rcl-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rcl-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rcl-br', name: 'branch', value: 'blocked_human_locked_or_ai_disabled', type: 'string' },
          { id: 'rcl-cd', name: 'blocked_at_condition', value: 6, type: 'number' },
          { id: 'rcl-rs', name: 'reason', value: 'human_locked_or_ai_disabled', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [3860, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_human_locked_or_ai_disabled' }],
});

// -----------------------------------------------------------------------------
// COND 7: campaign_contacts active
// -----------------------------------------------------------------------------

const lookupCampaignContacts = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Campaign Contacts',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT\n" +
        "  cc.id::text AS campaign_contact_id,\n" +
        "  cc.campaign_id::text AS campaign_id,\n" +
        "  cc.status\n" +
        "FROM public.campaign_contacts cc\n" +
        "JOIN public.contacts c ON c.id = cc.contact_id\n" +
        "WHERE c.phone = $1::text\n" +
        "  AND cc.status IN ('sent','delivered','replied','interested')\n" +
        "ORDER BY cc.updated_at DESC\n" +
        "LIMIT 1;",
      options: {
        queryReplacement: expr("={{ $('Normalize Phone').first().json.phone }}"),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    continueOnFail: true,
    alwaysOutputData: true,
    position: [4080, 220],
  },
  output: [{}],
});

const ifCampaignActive = ifElse({
  version: 2.3,
  config: {
    name: 'COND7 campaign_active?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'c7-camp',
            leftValue: expr(
              "={{ (function(){ const all = $('Lookup Campaign Contacts').all(); if (!all || all.length === 0) return false; const c = all[0].json || {}; return !!c.campaign_contact_id; })() }}"
            ),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [4300, 220],
  },
});

const logCampaignRoutedPending = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT campaign_routed_pending_IGOR_12',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, campaign_id, campaign_contact_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'campaign_routed_pending_IGOR_12',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  NULLIF($3::text, '')::uuid,\n" +
        "  NULLIF($4::text, '')::uuid,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $5::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; const p = $('Normalize Phone').first().json; const all = $('Lookup Campaign Contacts').all(); const cc = (all && all[0] && all[0].json) || {}; return [p.phone, m.chatwoot_conversation_id, cc.campaign_id || '', cc.campaign_contact_id || '', JSON.stringify({ reason: 'IGOR_12_not_yet_implemented', campaign_contact_status: cc.status || null, msg_id: m.msg_id, text_preview: (m.text || '').slice(0, 120), message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [4520, 60],
  },
  output: [{ executionStatus: 'success' }],
});

const respCampaignRouted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp campaign_routed_pending_IGOR_12',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rcr-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rcr-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rcr-br', name: 'branch', value: 'campaign_routed_pending_IGOR_12', type: 'string' },
          { id: 'rcr-cd', name: 'blocked_at_condition', value: 7, type: 'number' },
          { id: 'rcr-rs', name: 'reason', value: 'campaign_routed_pending_IGOR_12', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [4740, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'campaign_routed_pending_IGOR_12' }],
});

// -----------------------------------------------------------------------------
// COND 8 + 9: Check Business Hours + Check Holiday
// -----------------------------------------------------------------------------

const checkBusinessHours = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Business Hours + Holiday',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const s = $('Read Settings').first().json || {};\n" +
        "function parseJsonSetting(raw, fallback) {\n" +
        "  if (raw === undefined || raw === null || raw === '') return fallback;\n" +
        "  try { return JSON.parse(raw); } catch(e) { return fallback; }\n" +
        "}\n" +
        "const ahStart = parseJsonSetting(s.after_hours_start, '19:00');\n" +
        "const ahEnd   = parseJsonSetting(s.after_hours_end,   '08:00');\n" +
        "const tz      = parseJsonSetting(s.timezone,          'America/Sao_Paulo');\n" +
        "const holidaysList = parseJsonSetting(s.holidays,     []);\n" +
        "const holidayPolicy = parseJsonSetting(s.holiday_policy, 'after_hours_force');\n" +
        "// Compute current hh:mm and YYYY-MM-DD in tz\n" +
        "const now = new Date();\n" +
        "let hh = '00';\n" +
        "let mm = '00';\n" +
        "let ymd = now.toISOString().slice(0, 10);\n" +
        "try {\n" +
        "  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });\n" +
        "  const parts = fmt.formatToParts(now).reduce(function(acc, p) { acc[p.type] = p.value; return acc; }, {});\n" +
        "  ymd = (parts.year || '0000') + '-' + (parts.month || '01') + '-' + (parts.day || '01');\n" +
        "  hh = parts.hour || '00';\n" +
        "  mm = parts.minute || '00';\n" +
        "  if (hh === '24') hh = '00';\n" +
        "} catch(e) {}\n" +
        "const curHm = hh + ':' + mm;\n" +
        "function hmToMin(s) {\n" +
        "  const parts = String(s || '').split(':');\n" +
        "  const h = Number(parts[0] || 0);\n" +
        "  const m = Number(parts[1] || 0);\n" +
        "  return h * 60 + m;\n" +
        "}\n" +
        "const curMin   = hmToMin(curHm);\n" +
        "const startMin = hmToMin(ahStart);\n" +
        "const endMin   = hmToMin(ahEnd);\n" +
        "// Business hours window = [end, start) (e.g. 08:00 .. 19:00)\n" +
        "// after_hours = NOT business hours\n" +
        "let insideBusinessHours;\n" +
        "if (endMin < startMin) {\n" +
        "  // Standard same-day window (e.g. 08:00 .. 19:00)\n" +
        "  insideBusinessHours = (curMin >= endMin && curMin < startMin);\n" +
        "} else {\n" +
        "  // Wrap window (overnight); business hours wraps midnight\n" +
        "  insideBusinessHours = (curMin >= endMin || curMin < startMin);\n" +
        "}\n" +
        "const isHoliday = Array.isArray(holidaysList) && holidaysList.indexOf(ymd) !== -1;\n" +
        "// Holiday policy P1: 'after_hours_force' => holiday forces after_hours flow (treat as outside).\n" +
        "let effectiveInsideBusinessHours = insideBusinessHours;\n" +
        "if (isHoliday && holidayPolicy === 'after_hours_force') {\n" +
        "  effectiveInsideBusinessHours = false;\n" +
        "}\n" +
        "return [{\n" +
        "  json: {\n" +
        "    current_hm: curHm,\n" +
        "    current_ymd: ymd,\n" +
        "    timezone: tz,\n" +
        "    after_hours_start: ahStart,\n" +
        "    after_hours_end: ahEnd,\n" +
        "    inside_business_hours_raw: insideBusinessHours,\n" +
        "    is_holiday: isHoliday,\n" +
        "    holiday_policy: holidayPolicy,\n" +
        "    inside_business_hours: effectiveInsideBusinessHours,\n" +
        "  },\n" +
        "}];",
    },
    executeOnce: true,
    position: [4960, 220],
  },
  output: [
    {
      current_hm: '22:30',
      current_ymd: '2026-05-15',
      timezone: 'America/Sao_Paulo',
      after_hours_start: '19:00',
      after_hours_end: '08:00',
      inside_business_hours_raw: false,
      is_holiday: false,
      holiday_policy: 'after_hours_force',
      inside_business_hours: false,
    },
  ],
});

const ifInsideHours = ifElse({
  version: 2.3,
  config: {
    name: 'COND8 inside business hours?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'c8-inside',
            leftValue: expr("={{ $('Check Business Hours + Holiday').first().json.inside_business_hours }}"),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [5180, 220],
  },
});

const blockInsideHours = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT block inside_hours',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text, ''), NULLIF($2::text, '')::int, 'IGOR_01_Inbound_AfterHours', $3::jsonb);",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'inside_hours', msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [5400, 60],
  },
  output: [{ executionStatus: 'success' }],
});
const respInsideHours = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp inside_hours',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rih-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rih-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rih-br', name: 'branch', value: 'blocked_inside_hours', type: 'string' },
          { id: 'rih-cd', name: 'blocked_at_condition', value: 8, type: 'number' },
          { id: 'rih-rs', name: 'reason', value: 'inside_hours', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [5620, 60],
  },
  output: [{ ok: true, blocked: true, branch: 'blocked_inside_hours' }],
});

// -----------------------------------------------------------------------------
// COND 9 — Holiday log (informational; flow continues per policy)
// -----------------------------------------------------------------------------

const logHolidayApplied = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT holiday_policy_applied',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'holiday_policy_applied',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; const h = $('Check Business Hours + Holiday').first().json; if (!h.is_holiday) return [m.raw_phone || null, m.chatwoot_conversation_id || null, JSON.stringify({ skip: true })]; return [m.raw_phone, m.chatwoot_conversation_id, JSON.stringify({ is_holiday: true, ymd: h.current_ymd, holiday_policy: h.holiday_policy, msg_id: m.msg_id, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    continueOnFail: true,
    position: [5840, 380],
  },
  output: [{ executionStatus: 'success' }],
});

// -----------------------------------------------------------------------------
// COND 10 — Redis lock (INCR + EXPIRE 30 atomic NX-EX substitute)
// -----------------------------------------------------------------------------

const redisLockIncr = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Lock INCR',
    parameters: {
      operation: 'incr',
      key: expr("={{ 'igor:lock:inbound:' + $('Normalize Phone').first().json.phone }}"),
      expire: true,
      ttl: 30,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    alwaysOutputData: true,
    position: [6060, 380],
  },
  output: [{ 'igor:lock:inbound:5511999990001': 1 }],
});

const evalLock = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Eval Lock Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const phone = $('Normalize Phone').first().json.phone;\n" +
        "const key = 'igor:lock:inbound:' + phone;\n" +
        "const items = $input.all();\n" +
        "const obj = (items[0] && items[0].json) || {};\n" +
        "let counter = obj[key];\n" +
        "if (counter === undefined) {\n" +
        "  for (const k of Object.keys(obj)) {\n" +
        "    if (k.indexOf('igor:lock:inbound:') === 0) { counter = obj[k]; break; }\n" +
        "  }\n" +
        "}\n" +
        "const counterNum = Number(counter);\n" +
        "const gotLock = counterNum === 1;\n" +
        "return [{ json: { phone: phone, lock_key: key, counter: isNaN(counterNum) ? null : counterNum, got_lock: gotLock } }];",
    },
    position: [6280, 380],
  },
  output: [{ phone: '5511999990001', lock_key: 'igor:lock:inbound:5511999990001', counter: 1, got_lock: true }],
});

const ifGotLock = ifElse({
  version: 2.3,
  config: {
    name: 'COND10 got lock?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'c10-got',
            leftValue: expr("={{ $('Eval Lock Result').first().json.got_lock }}"),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [6500, 380],
  },
});

// Batch branch: lock held -> RPUSH fragment to igor:batch:{phone} + EXPIRE 60
const batchPrepare = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Batch Prepare Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const m = $('Normalize Payload').first().json;\n" +
        "const p = $('Normalize Phone').first().json;\n" +
        "const payload = JSON.stringify({\n" +
        "  msg_id: m.msg_id,\n" +
        "  text: m.text,\n" +
        "  caption: m.caption,\n" +
        "  message_type: m.message_type,\n" +
        "  media_url: m.media_url,\n" +
        "  media_base64: m.media_base64 ? '[base64]' : '',\n" +
        "  mime_type: m.mime_type,\n" +
        "  timestamp: m.timestamp,\n" +
        "  test_run_id: m.test_run_id\n" +
        "});\n" +
        "return [{ json: { phone: p.phone, batch_key: 'igor:batch:' + p.phone, fragment_payload: payload } }];",
    },
    position: [6720, 540],
  },
  output: [{ phone: '5511999990001', batch_key: 'igor:batch:5511999990001', fragment_payload: '{}' }],
});

const batchRpush = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis RPUSH batch fragment',
    parameters: {
      operation: 'push',
      list: expr("={{ $('Batch Prepare Payload').first().json.batch_key }}"),
      messageData: expr("={{ $('Batch Prepare Payload').first().json.fragment_payload }}"),
      tail: true,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    position: [6940, 540],
  },
  output: [{ ok: true }],
});

// EXPIRE batch 60 — n8n Redis v1 does not expose EXPIRE on a list directly;
// use INCR with expire=true on a sibling marker key as a TTL proxy AND rely
// on Redis Get/Del pattern below to clear the batch on the holder's path.
// We simulate EXPIRE 60 with a marker key incr + expire 60 (ASX style).
const batchMarkerExpire = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis EXPIRE batch via marker',
    parameters: {
      operation: 'incr',
      key: expr("={{ 'igor:batch:marker:' + $('Batch Prepare Payload').first().json.phone }}"),
      expire: true,
      ttl: 60,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    position: [7160, 540],
  },
  output: [{ 'igor:batch:marker:5511999990001': 1 }],
});

const logInboundBatched = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT inbound_batched',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'inbound_batched',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Payload').first().json; const p = $('Normalize Phone').first().json; const l = $('Eval Lock Result').first().json; return [p.phone, m.chatwoot_conversation_id, JSON.stringify({ reason: 'lock_held', counter: l.counter, lock_key: l.lock_key, msg_id: m.msg_id, message_type: m.message_type, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [7380, 540],
  },
  output: [{ executionStatus: 'success' }],
});

const respBatched = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp inbound_batched',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rbt-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rbt-bl', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rbt-br', name: 'branch', value: 'batched_lock_held', type: 'string' },
          { id: 'rbt-cd', name: 'blocked_at_condition', value: 10, type: 'number' },
          { id: 'rbt-rs', name: 'reason', value: 'lock_held', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [7600, 540],
  },
  output: [{ ok: true, blocked: true, branch: 'batched_lock_held' }],
});

// Got-lock branch: wait 3s, LRANGE, DEL, merge fragments
const waitForFragments = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait 3s for Fragments',
    parameters: {
      resume: 'timeInterval',
      amount: 3,
      unit: 'seconds',
    },
    position: [6720, 220],
  },
  output: [{}],
});

const redisLrange = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Get batch (LRANGE)',
    parameters: {
      operation: 'get',
      propertyName: 'batch_fragments',
      key: expr("={{ 'igor:batch:' + $('Normalize Phone').first().json.phone }}"),
      keyType: 'list',
      options: { dotNotation: false },
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    alwaysOutputData: true,
    position: [6940, 220],
  },
  output: [{ batch_fragments: [] }],
});

const redisDelBatch = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis DEL batch',
    parameters: {
      operation: 'delete',
      key: expr("={{ 'igor:batch:' + $('Normalize Phone').first().json.phone }}"),
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    position: [7160, 220],
  },
  output: [{ ok: true }],
});

const mergeFragments = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Fragments',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const m = $('Normalize Payload').first().json;\n" +
        "const items = $input.all();\n" +
        "const lrangeOut = (items[0] && items[0].json) || {};\n" +
        "let frags = lrangeOut.batch_fragments;\n" +
        "if (typeof frags === 'string') {\n" +
        "  try { frags = JSON.parse(frags); } catch (e) { frags = [frags]; }\n" +
        "}\n" +
        "if (!Array.isArray(frags)) frags = [];\n" +
        "const parsed = [];\n" +
        "for (const f of frags) {\n" +
        "  if (typeof f === 'string') {\n" +
        "    try { parsed.push(JSON.parse(f)); } catch(e) { parsed.push({ text: f }); }\n" +
        "  } else if (f && typeof f === 'object') {\n" +
        "    parsed.push(f);\n" +
        "  }\n" +
        "}\n" +
        "const allTexts = [];\n" +
        "for (const f of parsed) {\n" +
        "  const t = (f.text || f.caption || '').trim();\n" +
        "  if (t) allTexts.push(t);\n" +
        "}\n" +
        "const currentText = (m.text || m.caption || '').trim();\n" +
        "if (currentText) allTexts.push(currentText);\n" +
        "const merged = allTexts.join('\\n').trim();\n" +
        "return [{ json: { fragments_count: parsed.length + (currentText ? 1 : 0), merged_text: merged, prior_fragments: parsed } }];",
    },
    position: [7380, 220],
  },
  output: [{ fragments_count: 1, merged_text: 'Oi, queria saber sobre tratamento de cicatriz', prior_fragments: [] }],
});

// -----------------------------------------------------------------------------
// COND 11: messageType ≠ text -> IGOR_02
// -----------------------------------------------------------------------------

const ifMediaMessage = ifElse({
  version: 2.3,
  config: {
    name: 'COND11 messageType != text?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'c11-media',
            leftValue: expr("={{ $('Normalize Payload').first().json.message_type }}"),
            rightValue: 'text',
            operator: { type: 'string', operation: 'notEquals' },
          },
        ],
      },
      options: {},
    },
    position: [7600, 220],
  },
});

const callIgor02 = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'CALL IGOR_02 Media Normalizer',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: IGOR_02_WORKFLOW_ID,
        cachedResultName: 'IGOR_02_Media_Normalizer',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          phone: expr("={{ $('Normalize Phone').first().json.phone }}"),
          msgId: expr("={{ $('Normalize Payload').first().json.msg_id }}"),
          messageType: expr("={{ $('Normalize Payload').first().json.message_type }}"),
          media_url: expr("={{ $('Normalize Payload').first().json.media_url }}"),
          media_base64: expr("={{ $('Normalize Payload').first().json.media_base64 }}"),
          caption: expr("={{ $('Normalize Payload').first().json.caption }}"),
          mimeType: expr("={{ $('Normalize Payload').first().json.mime_type }}"),
          chatwoot_conversation_id: expr(
            "={{ $('Normalize Payload').first().json.chatwoot_conversation_id }}"
          ),
          test_run_id: expr("={{ $('Normalize Payload').first().json.test_run_id }}"),
        },
        matchingColumns: [],
        schema: [
          { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'msgId', displayName: 'msgId', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'messageType', displayName: 'messageType', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'media_url', displayName: 'media_url', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'media_base64', displayName: 'media_base64', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'caption', displayName: 'caption', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'mimeType', displayName: 'mimeType', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { waitForSubWorkflow: true },
    },
    continueOnFail: true,
    position: [7820, 60],
  },
  output: [
    {
      normalized_text: '[descrição mídia]',
      safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
      should_handoff: false,
      handoff_reason: null,
    },
  ],
});

// Merge media + text paths into "Build Normalized Output"
const mergeMediaText = merge({
  version: 3.2,
  config: {
    name: 'Merge media+text',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [8040, 220],
  },
});

const buildNormalizedOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Normalized Output',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const m = $('Normalize Payload').first().json;\n" +
        "const p = $('Normalize Phone').first().json;\n" +
        "const mf = $('Merge Fragments').first().json;\n" +
        "let normalizedText = mf.merged_text || m.text || '';\n" +
        "let safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n" +
        "let shouldHandoff = false;\n" +
        "let handoffReason = null;\n" +
        "// If media path ran, grab IGOR_02 output\n" +
        "try {\n" +
        "  if (m.message_type && m.message_type !== 'text') {\n" +
        "    const media = $('CALL IGOR_02 Media Normalizer').first().json || {};\n" +
        "    if (media.normalized_text) {\n" +
        "      const mediaText = String(media.normalized_text);\n" +
        "      normalizedText = normalizedText ? (normalizedText + '\\n' + mediaText) : mediaText;\n" +
        "    }\n" +
        "    if (media.safety_flags && typeof media.safety_flags === 'object') safetyFlags = media.safety_flags;\n" +
        "    if (media.should_handoff === true) shouldHandoff = true;\n" +
        "    if (media.handoff_reason) handoffReason = media.handoff_reason;\n" +
        "  }\n" +
        "} catch(e) {}\n" +
        "return [{\n" +
        "  json: {\n" +
        "    phone: p.phone,\n" +
        "    msg_id: m.msg_id,\n" +
        "    message_type: m.message_type,\n" +
        "    chatwoot_conversation_id: m.chatwoot_conversation_id,\n" +
        "    chatwoot_contact_id: m.chatwoot_contact_id,\n" +
        "    instance: m.instance,\n" +
        "    push_name: m.push_name,\n" +
        "    timestamp: m.timestamp,\n" +
        "    normalized_text: normalizedText,\n" +
        "    fragments_count: mf.fragments_count || 1,\n" +
        "    safety_flags: safetyFlags,\n" +
        "    should_handoff: shouldHandoff,\n" +
        "    handoff_reason: handoffReason,\n" +
        "    test_run_id: m.test_run_id,\n" +
        "  },\n" +
        "}];",
    },
    executeOnce: true,
    position: [8260, 220],
  },
  output: [
    {
      phone: '5511999990001',
      msg_id: 'EVOLUTION_MSG_ID_001',
      message_type: 'text',
      chatwoot_conversation_id: '9101',
      chatwoot_contact_id: '5101',
      instance: 'dr_igor',
      push_name: 'Lead Teste',
      timestamp: '2026-05-15T22:30:00.000Z',
      normalized_text: 'Oi, queria saber sobre tratamento de cicatriz',
      fragments_count: 1,
      safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
      should_handoff: false,
      handoff_reason: null,
      test_run_id: 'IGOR_01_FIXTURE_text_afterhours',
    },
  ],
});

// -----------------------------------------------------------------------------
// UPSERT conversations + UPSERT messages
// -----------------------------------------------------------------------------

const upsertConversation = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT conversation ai_after_hours',
    parameters: {
      operation: 'executeQuery',
      query:
        "WITH up_contact AS (\n" +
        "  INSERT INTO public.contacts (phone, name)\n" +
        "  VALUES ($1::text, NULLIF($2::text, ''))\n" +
        "  ON CONFLICT (phone) DO UPDATE\n" +
        "  SET name = COALESCE(NULLIF(EXCLUDED.name, ''), public.contacts.name),\n" +
        "      updated_at = now()\n" +
        "  RETURNING id\n" +
        ")\n" +
        "INSERT INTO public.conversations (\n" +
        "  contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state, ai_enabled,\n" +
        "  current_flow, last_message_at\n" +
        ")\n" +
        "SELECT\n" +
        "  uc.id,\n" +
        "  NULLIF($3::text, '')::int,\n" +
        "  COALESCE(NULLIF($4::text, '')::int, 1),\n" +
        "  'ai_after_hours',\n" +
        "  true,\n" +
        "  'after_hours',\n" +
        "  COALESCE(NULLIF($5::text, '')::timestamptz, now())\n" +
        "FROM up_contact uc\n" +
        "ON CONFLICT (chatwoot_conversation_id) DO UPDATE\n" +
        "SET state = 'ai_after_hours',\n" +
        "    ai_enabled = CASE WHEN public.conversations.ai_enabled IS NULL THEN true ELSE public.conversations.ai_enabled END,\n" +
        "    current_flow = 'after_hours',\n" +
        "    last_message_at = EXCLUDED.last_message_at,\n" +
        "    updated_at = now()\n" +
        "RETURNING id::text AS conversation_uuid, chatwoot_conversation_id, state, ai_enabled;",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Build Normalized Output').first().json; return [m.phone, m.push_name || '', m.chatwoot_conversation_id, '1', m.timestamp]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [8480, 220],
  },
  output: [
    { conversation_uuid: 'uuid-conv-row', chatwoot_conversation_id: 9101, state: 'ai_after_hours', ai_enabled: true },
  ],
});

const upsertMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT message inbound',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.messages (\n" +
        "  conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me,\n" +
        "  media_url, media_mime_type, safety_flags, created_at\n" +
        ")\n" +
        "SELECT\n" +
        "  c.id,\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, ''),\n" +
        "  NULLIF($3::text, ''),\n" +
        "  COALESCE(NULLIF($4::text, ''), 'text'),\n" +
        "  'inbound',\n" +
        "  'user',\n" +
        "  false,\n" +
        "  NULLIF($5::text, ''),\n" +
        "  NULLIF($6::text, ''),\n" +
        "  COALESCE(NULLIF($7::text, '')::jsonb, '{}'::jsonb),\n" +
        "  COALESCE(NULLIF($8::text, '')::timestamptz, now())\n" +
        "FROM public.conversations c\n" +
        "WHERE c.chatwoot_conversation_id = NULLIF($9::text, '')::int;",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const o = $('Build Normalized Output').first().json; const m = $('Normalize Payload').first().json; return [o.msg_id, m.text || '', o.normalized_text, o.message_type, m.media_url || '', m.mime_type || '', JSON.stringify(o.safety_flags || {}), o.timestamp, o.chatwoot_conversation_id]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [8700, 220],
  },
  output: [{ executionStatus: 'success' }],
});

// -----------------------------------------------------------------------------
// CALL IGOR_04 — apply 'fora_expediente' label + automation_state attr
// -----------------------------------------------------------------------------

const callIgor04ForaExpediente = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'CALL IGOR_04 fora_expediente',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: IGOR_04_WORKFLOW_ID,
        cachedResultName: 'IGOR_04_Tool_Labels_Attributes',
      },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: expr(
            "={{ $('Build Normalized Output').first().json.chatwoot_conversation_id }}"
          ),
          chatwoot_contact_id: expr(
            "={{ $('Build Normalized Output').first().json.chatwoot_contact_id }}"
          ),
          labels_to_add: expr("={{ ['fora_expediente'] }}"),
          labels_to_remove: expr('={{ [] }}'),
          custom_attributes: expr(
            "={{ ({ conversation: { automation_state: 'ai_after_hours', lead_status: 'qualificacao_inicial' }, contact: {} }) }}"
          ),
          test_run_id: expr("={{ $('Build Normalized Output').first().json.test_run_id }}"),
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
    continueOnFail: true,
    position: [8920, 220],
  },
  output: [{ ok: true }],
});

// -----------------------------------------------------------------------------
// COND 12: route to IGOR_03 (placeholder — Wave 4)
// -----------------------------------------------------------------------------

const logRoutedPendingIgor03 = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT inbound_routed_pending_IGOR_03',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'inbound_routed_pending_IGOR_03',\n" +
        "  NULLIF($1::text, ''),\n" +
        "  NULLIF($2::text, '')::int,\n" +
        "  'IGOR_01_Inbound_AfterHours',\n" +
        "  $3::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const o = $('Build Normalized Output').first().json; return [o.phone, o.chatwoot_conversation_id, JSON.stringify({ msg_id: o.msg_id, message_type: o.message_type, fragments_count: o.fragments_count, normalized_text_preview: (o.normalized_text || '').slice(0, 240), should_handoff: o.should_handoff, handoff_reason: o.handoff_reason, safety_flags: o.safety_flags, chatwoot_contact_id: o.chatwoot_contact_id, push_name: o.push_name, instance: o.instance, reason: 'IGOR_03_not_yet_implemented_wave_4_placeholder', test_run_id: o.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [9140, 220],
  },
  output: [{ executionStatus: 'success' }],
});

const redisDelLock = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis DEL lock',
    parameters: {
      operation: 'delete',
      key: expr("={{ 'igor:lock:inbound:' + $('Normalize Phone').first().json.phone }}"),
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    continueOnFail: true,
    position: [9360, 220],
  },
  output: [{ ok: true }],
});

const respRouted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp routed_ai_after_hours',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rblocked', name: 'blocked', value: false, type: 'boolean' },
          { id: 'rbranch', name: 'branch', value: 'routed_ai_after_hours', type: 'string' },
          { id: 'rcond', name: 'blocked_at_condition', value: 0, type: 'number' },
          { id: 'rreason', name: 'reason', value: 'routed_to_IGOR_03_placeholder_wave_4', type: 'string' },
          {
            id: 'rdownstream',
            name: 'downstream_calls',
            value: expr(
              "={{ (function(){ const o = $('Build Normalized Output').first().json; const calls = []; if (o.message_type && o.message_type !== 'text') calls.push('IGOR_02'); calls.push('IGOR_04:fora_expediente'); calls.push('IGOR_03:placeholder'); return calls; })() }}"
            ),
            type: 'array',
          },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [9580, 220],
  },
  output: [
    {
      ok: true,
      blocked: false,
      branch: 'routed_ai_after_hours',
      blocked_at_condition: 0,
      reason: 'routed_to_IGOR_03_placeholder_wave_4',
      downstream_calls: ['IGOR_04:fora_expediente', 'IGOR_03:placeholder'],
    },
  ],
});

// -----------------------------------------------------------------------------
// FINAL MERGE — append all 9 terminal branches into one response stream
// (1: fromMe, 2: ai_disabled_global, 3: workflow_disabled, 4: invalid_phone,
//  5: opt_out, 6: human_locked_or_ai_disabled, 7: campaign_routed,
//  8: inside_hours, 9: batched_lock_held, 10: routed)
// -----------------------------------------------------------------------------

const finalMerge = merge({
  version: 3.2,
  config: {
    name: 'Final Response Merge',
    parameters: { mode: 'append', numberInputs: 10 },
    position: [9820, 280],
  },
});

// =============================================================================
// WIRE WORKFLOW
// =============================================================================

export default workflow('IGOR_01_Inbound_AfterHours', 'IGOR_01_Inbound_AfterHours')
  .add(webhookTrigger)
  .to(normalizePayload)
  .to(logInboundReceived)
  .to(
    ifFromMe
      // COND 1
      .onTrue(blockFromMe.to(respFromMe.to(finalMerge.input(0))))
      .onFalse(
        readSettings.to(
          ifAiDisabledGlobal
            // COND 2
            .onTrue(blockAiDisabledGlobal.to(respAiDisabledGlobal.to(finalMerge.input(1))))
            .onFalse(
              ifWorkflowDisabled
                // COND 3
                .onTrue(blockWorkflowDisabled.to(respWorkflowDisabled.to(finalMerge.input(2))))
                .onFalse(
                  normalizePhone.to(
                    ifPhoneInvalid
                      // COND 4
                      .onTrue(insertInvalidPhone.to(respInvalidPhone.to(finalMerge.input(3))))
                      .onFalse(
                        lookupContact.to(
                          ifDoNotContact
                            // COND 5
                            .onTrue(
                              callIgor04Optout
                                .to(blockOptOut)
                                .to(respOptOut)
                                .to(finalMerge.input(4))
                            )
                            .onFalse(
                              lookupConversation.to(
                                ifConversationLocked
                                  // COND 6
                                  .onTrue(blockConvLocked.to(respConvLocked.to(finalMerge.input(5))))
                                  .onFalse(
                                    lookupCampaignContacts.to(
                                      ifCampaignActive
                                        // COND 7
                                        .onTrue(
                                          logCampaignRoutedPending
                                            .to(respCampaignRouted)
                                            .to(finalMerge.input(6))
                                        )
                                        .onFalse(
                                          checkBusinessHours.to(
                                            ifInsideHours
                                              // COND 8
                                              .onTrue(
                                                blockInsideHours
                                                  .to(respInsideHours)
                                                  .to(finalMerge.input(7))
                                              )
                                              .onFalse(
                                                // COND 9 (informational holiday log) → COND 10 Redis lock
                                                logHolidayApplied
                                                  .to(redisLockIncr)
                                                  .to(evalLock)
                                                  .to(
                                                    ifGotLock
                                                      // batch branch (lock held)
                                                      .onFalse(
                                                        batchPrepare
                                                          .to(batchRpush)
                                                          .to(batchMarkerExpire)
                                                          .to(logInboundBatched)
                                                          .to(respBatched)
                                                          .to(finalMerge.input(8))
                                                      )
                                                      // got-lock branch → wait + LRANGE + DEL + merge
                                                      .onTrue(
                                                        waitForFragments
                                                          .to(redisLrange)
                                                          .to(redisDelBatch)
                                                          .to(mergeFragments)
                                                          .to(
                                                            ifMediaMessage
                                                              // COND 11 — media path
                                                              .onTrue(
                                                                callIgor02.to(mergeMediaText.input(0))
                                                              )
                                                              // text path
                                                              .onFalse(mergeMediaText.input(1))
                                                          )
                                                      )
                                                  )
                                              )
                                          )
                                        )
                                    )
                                  )
                              )
                            )
                        )
                      )
                  )
                )
            )
        )
      )
  )
  .add(mergeMediaText)
  .to(buildNormalizedOutput)
  .to(upsertConversation)
  .to(upsertMessage)
  .to(callIgor04ForaExpediente)
  .to(logRoutedPendingIgor03)
  .to(redisDelLock)
  .to(respRouted)
  .to(finalMerge.input(9));
