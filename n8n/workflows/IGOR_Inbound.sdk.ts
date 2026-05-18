import {
  workflow,
  node,
  trigger,
  ifElse,
  switchCase,
  splitInBatches,
  nextBatch,
  languageModel,
  memory,
  tool,
  newCredential,
} from '@n8n/workflow-sdk';

// IGOR_Inbound — workflow principal único (baseado em ASX 07-FB-Leads-Inbound, adaptado para clínica Dr. Igor)
// Substitui: IGOR_01_v2 + IGOR_02 + IGOR_03 + IGOR_AUX_save_lead_partial + IGOR_AUX_update_conversation_state
// Path webhook: igor/inbound (mantém — Evolution já aponta para esse path)

const IGOR_LABELS_ID = 'AJF7dhGrqJEXMLqz';
const IGOR_HANDOFF_ID = 'mfB7MGpCYSPQvRSx'; // IGOR_Handoff (substituirá IGOR_05_v2 no mesmo ID via update_workflow)

const evolutionWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Evolution Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'igor/inbound',
      options: {},
    },
    position: [0, 400],
  },
  output: [{ body: {} }],
});

const extractFields = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extrair Campos',
    parameters: {
      assignments: {
        assignments: [
          { id: 'f-instance', name: 'instance', value: '={{ $json.body.instance }}', type: 'string' },
          { id: 'f-phone-raw', name: 'phoneRaw', value: '={{ $json.body.data.key.remoteJid }}', type: 'string' },
          { id: 'f-msgid', name: 'msgId', value: '={{ $json.body.data.key.id }}', type: 'string' },
          { id: 'f-fromme', name: 'fromMe', value: '={{ $json.body.data.key.fromMe }}', type: 'boolean' },
          { id: 'f-conv', name: 'conversation', value: "={{ $json.body.data.message.conversation || $json.body.data.message.extendedTextMessage?.text || '' }}", type: 'string' },
          { id: 'f-mtype', name: 'messageType', value: '={{ $json.body.data.messageType }}', type: 'string' },
          { id: 'f-cw-conv', name: 'chatwootConversationId', value: '={{ $json.body.data.chatwootConversationId }}', type: 'number' },
          { id: 'f-cw-inbox', name: 'chatwootInboxId', value: '={{ $json.body.data.chatwootInboxId }}', type: 'number' },
          { id: 'f-ts', name: 'timestamp', value: '={{ $json.body.data.messageTimestamp }}', type: 'string' },
          { id: 'f-push', name: 'pushName', value: '={{ $json.body.data.pushName }}', type: 'string' },
          { id: 'f-data', name: 'data', value: '={{ $json.body.data }}', type: 'object' },
        ],
      },
      options: {},
    },
    position: [200, 400],
  },
  output: [{ phoneRaw: '', msgId: '', fromMe: false, conversation: '', messageType: '', chatwootConversationId: 0, chatwootInboxId: 0, timestamp: '', pushName: '', data: {} }],
});

const normalizePayload = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Normaliza Payload',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'n-phone',
            name: 'phone',
            value:
              "={{ (() => { const p = ($json.phoneRaw || '').split('@')[0].replace(/\\D/g, ''); if (p.length === 12 && p.startsWith('55')) return p.slice(0,4) + '9' + p.slice(4); return p; })() }}",
            type: 'string',
          },
          {
            id: 'n-phone-valid',
            name: 'phoneValid',
            value: "={{ (() => { const p = ($json.phoneRaw || '').split('@')[0].replace(/\\D/g, ''); if (p.length === 13 && p.startsWith('55')) return /^[1-9][0-9]9\\d{8}$/.test(p); if (p.length === 12 && p.startsWith('55')) return /^[1-9][0-9]\\d{8}$/.test(p); return false; })() }}",
            type: 'boolean',
          },
        ],
      },
      includeOtherFields: true,
      options: {},
    },
    position: [400, 400],
  },
  output: [{ phone: '', phoneValid: false, phoneRaw: '', msgId: '', fromMe: false, conversation: '', messageType: '', chatwootConversationId: 0, chatwootInboxId: 0, timestamp: '', pushName: '', data: {} }],
});

const ifLeadMessage = ifElse({
  version: 2.2,
  config: {
    name: 'IF Lead Message',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'lead-msg', leftValue: '={{ !$json.fromMe }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [600, 400],
  },
});

const noOpFromMe = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'No Op (fromMe)', parameters: {}, position: [800, 600] },
  output: [{}],
});

const loadStateQuery =
  'WITH s AS (SELECT json_object_agg(key, value) AS j FROM public.settings),\n' +
  "ct AS (SELECT id::text AS contact_id, do_not_contact FROM public.contacts WHERE phone = $1::text LIMIT 1),\n" +
  "cv AS (SELECT id::text AS conv_id, state, ai_enabled, human_locked, owner_flow, journey_started_at::text AS journey_started_at, turn_count FROM public.conversations WHERE chatwoot_conversation_id = NULLIF($2::text,'')::int LIMIT 1),\n" +
  "camp AS (SELECT cc.id::text AS campaign_contact_id, cc.campaign_id::text AS campaign_id FROM public.campaign_contacts cc JOIN public.contacts cnt ON cnt.id = cc.contact_id WHERE cnt.phone = $1::text AND cc.status IN ('sent','delivered','replied','interested') ORDER BY cc.updated_at DESC LIMIT 1)\n" +
  'SELECT (SELECT j FROM s) AS settings_json,\n' +
  '       (SELECT contact_id FROM ct) AS contact_id,\n' +
  '       (SELECT do_not_contact FROM ct) AS do_not_contact,\n' +
  '       (SELECT conv_id FROM cv) AS conv_id,\n' +
  '       (SELECT owner_flow FROM cv) AS conv_owner_flow,\n' +
  '       (SELECT journey_started_at FROM cv) AS conv_journey_started_at,\n' +
  '       (SELECT turn_count FROM cv) AS conv_turn_count,\n' +
  '       (SELECT campaign_contact_id FROM camp) AS campaign_contact_id;';

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
          "={{ [$('Normaliza Payload').first().json.phone, String($('Normaliza Payload').first().json.chatwootConversationId || '')] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [800, 400],
    alwaysOutputData: true,
  },
  output: [{ settings_json: {}, contact_id: null, do_not_contact: null, conv_id: null, conv_owner_flow: null, conv_journey_started_at: null, conv_turn_count: 0, campaign_contact_id: null }],
});

const computeGatesJs =
  "const m = $('Normaliza Payload').first().json;\n" +
  "const s = $('Load State').first().json;\n" +
  'const settings = (s && s.settings_json) || {};\n' +
  'function asBool(v, fb) { if (v === true || v === "true") return true; if (v === false || v === "false") return false; return fb; }\n' +
  'function asObj(v, fb) { if (v && typeof v === "object" && !Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return (p && typeof p === "object" && !Array.isArray(p)) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asArr(v, fb) { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fb; } catch(e) { return fb; } } return fb; }\n' +
  'function asStr(v, fb) { if (typeof v === "string") { try { const p = JSON.parse(v); return typeof p === "string" ? p : fb; } catch(e) { return v; } } return fb; }\n' +
  'const aiEnabledGlobal = asBool(settings.ai_enabled_global, true);\n' +
  'const wfEnabled = asObj(settings.workflows_enabled, {});\n' +
  'const wfEnabledThis = wfEnabled.IGOR_Inbound !== false && wfEnabled.IGOR_01 !== false;\n' +
  'const tz = asStr(settings.timezone, "America/Sao_Paulo");\n' +
  'const ahStart = asStr(settings.after_hours_start, "18:30");\n' +
  'const ahEnd = asStr(settings.after_hours_end, "07:30");\n' +
  'const holidays = asArr(settings.holidays, []);\n' +
  'const holidayPolicy = asStr(settings.holiday_policy, "after_hours_force");\n' +
  'const aiTeamId = (settings.ai_team_id == null) ? 1 : Number(settings.ai_team_id);\n' +
  'const humanTeamId = (settings.human_daytime_team_id == null) ? 1 : Number(settings.human_daytime_team_id);\n' +
  'const ownerFlowBlocked = ["human_daytime","handoff_queue","ai_unqualified","compliance_hold","opt_out"];\n' +
  'const convOwnerFlow = s.conv_owner_flow || null;\n' +
  'const isOwnerFlowBlocked = convOwnerFlow !== null && ownerFlowBlocked.indexOf(convOwnerFlow) !== -1;\n' +
  'const doNotContact = s.do_not_contact === true;\n' +
  'const isNewLeadJourney = (s.conv_journey_started_at || null) === null;\n' +
  'const hasCampaignActive = !!s.campaign_contact_id;\n' +
  'const now = new Date();\n' +
  'let hh = "00", mm = "00", ymd = now.toISOString().slice(0,10);\n' +
  'try {\n' +
  '  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });\n' +
  '  const parts = fmt.formatToParts(now).reduce(function(acc,p){acc[p.type]=p.value;return acc;},{});\n' +
  '  ymd = (parts.year||"0000")+"-"+(parts.month||"01")+"-"+(parts.day||"01");\n' +
  '  hh = parts.hour||"00"; mm = parts.minute||"00";\n' +
  '  if (hh === "24") hh = "00";\n' +
  '} catch(e) {}\n' +
  'const curMin = Number(hh)*60 + Number(mm);\n' +
  'const ahStartParts = ahStart.split(":"); const startMin = Number(ahStartParts[0])*60 + Number(ahStartParts[1]||0);\n' +
  'const ahEndParts = ahEnd.split(":"); const endMin = Number(ahEndParts[0])*60 + Number(ahEndParts[1]||0);\n' +
  'let insideBusinessHours = endMin < startMin ? (curMin >= endMin && curMin < startMin) : (curMin >= endMin || curMin < startMin);\n' +
  'const isHoliday = Array.isArray(holidays) && holidays.indexOf(ymd) !== -1;\n' +
  'if (isHoliday && holidayPolicy === "after_hours_force") insideBusinessHours = false;\n' +
  'let blockReason = null;\n' +
  'if (!aiEnabledGlobal) blockReason = "ai_disabled_global";\n' +
  'else if (!wfEnabledThis) blockReason = "workflow_disabled";\n' +
  'else if (!m.phoneValid) blockReason = "phone_invalid";\n' +
  'else if (doNotContact) blockReason = "do_not_contact";\n' +
  'else if (isOwnerFlowBlocked) blockReason = "owner_flow_" + convOwnerFlow;\n' +
  'else if (hasCampaignActive) blockReason = "campaign_active";\n' +
  'const moveToHuman = (blockReason === null) && (insideBusinessHours || !isNewLeadJourney);\n' +
  'const moveReason = moveToHuman ? (insideBusinessHours ? "inside_business_hours" : "existing_journey_after_hours") : null;\n' +
  'const shouldProcessAI = (blockReason === null) && !moveToHuman;\n' +
  'return [{ json: { block_reason: blockReason, move_to_human: moveToHuman, move_reason: moveReason, should_process_ai: shouldProcessAI, ai_team_id: aiTeamId, human_daytime_team_id: humanTeamId, inside_business_hours: insideBusinessHours, is_new_lead_journey: isNewLeadJourney, is_holiday: isHoliday, ymd: ymd, current_hm: hh+":"+mm } }];';

const computeGates = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Gates',
    parameters: { mode: 'runOnceForAllItems', jsCode: computeGatesJs },
    position: [1000, 400],
  },
  output: [{ block_reason: null, move_to_human: false, should_process_ai: true, ai_team_id: 3, human_daytime_team_id: 1, is_new_lead_journey: true, inside_business_hours: false }],
});

const ifBlocked = ifElse({
  version: 2.2,
  config: {
    name: 'IF Block Reason?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'block-cond', leftValue: "={{ $('Compute Gates').first().json.block_reason }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      },
    },
    position: [1200, 400],
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
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_blocked', NULLIF($1::text,''), NULLIF($2::text,'')::int, 'IGOR_Inbound', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Normaliza Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, String(m.chatwootConversationId||''), JSON.stringify({ reason: g.block_reason, msg_id: m.msgId, message_type: m.messageType })]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1400, 280],
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
      assignments: {
        assignments: [
          { id: 'rb-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rb-blocked', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rb-reason', name: 'reason', value: "={{ $('Compute Gates').first().json.block_reason }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1600, 280],
    executeOnce: true,
  },
  output: [{ ok: true, blocked: true, reason: '' }],
});

const ifMoveToHuman = ifElse({
  version: 2.2,
  config: {
    name: 'IF Move to Human?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'move-cond', leftValue: "={{ $('Compute Gates').first().json.move_to_human }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [1400, 520],
  },
});

const upsertConvHumanQuery =
  'WITH ct AS (INSERT INTO public.contacts (phone, name) VALUES ($1::text, NULLIF($2::text,\'\')) ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name,\'\'), public.contacts.name), updated_at = now() RETURNING id)\n' +
  "INSERT INTO public.conversations (contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state, ai_enabled, human_locked, current_flow, owner_flow, assigned_team_id)\n" +
  "SELECT ct.id, NULLIF($3::text,'')::int, 1, 'human_assigned', false, true, 'after_hours', 'human_daytime', $4::int FROM ct\n" +
  "ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET state='human_assigned', ai_enabled=false, human_locked=true, owner_flow='human_daytime', assigned_team_id=$4::int, updated_at=now()\n" +
  'RETURNING id;';

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
          "={{ (function(){ const m = $('Normaliza Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, m.pushName||'', String(m.chatwootConversationId||''), String(g.human_daytime_team_id)]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1600, 440],
    executeOnce: true,
  },
  output: [{ id: '' }],
});

const postAssignHumanTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Human Team',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Normaliza Payload').first().json.chatwootConversationId }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ team_id: Number($('Compute Gates').first().json.human_daytime_team_id) }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 15000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [1800, 440],
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
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('inbound_moved_to_human', NULLIF($1::text,''), NULLIF($2::text,'')::int, 'IGOR_Inbound', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Normaliza Payload').first().json; const g = $('Compute Gates').first().json; return [m.phone, String(m.chatwootConversationId||''), JSON.stringify({ reason: g.move_reason, inside_business_hours: g.inside_business_hours, is_new_lead_journey: g.is_new_lead_journey, msg_id: m.msgId, message_type: m.messageType })]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2000, 440],
    executeOnce: true,
  },
  output: [{}],
});

const respMoved = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resp moved',
    parameters: {
      assignments: {
        assignments: [
          { id: 'rm-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'rm-blocked', name: 'blocked', value: true, type: 'boolean' },
          { id: 'rm-reason', name: 'reason', value: "={{ $('Compute Gates').first().json.move_reason }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2200, 440],
    executeOnce: true,
  },
  output: [{ ok: true, blocked: true, reason: '' }],
});

// ===== Mídia: Switch Message Type =====

const switchMessageType = switchCase({
  version: 3.2,
  config: {
    name: 'Switch Message Type',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { conditions: { combinator: 'and', conditions: [{ id: 's-text', leftValue: "={{ $('Normaliza Payload').first().json.messageType }}", rightValue: 'conversation', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } }, renameOutput: true, outputKey: 'text' },
          { conditions: { combinator: 'and', conditions: [{ id: 's-text2', leftValue: "={{ $('Normaliza Payload').first().json.messageType }}", rightValue: 'extendedTextMessage', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } }, renameOutput: true, outputKey: 'extendedText' },
          { conditions: { combinator: 'and', conditions: [{ id: 's-audio', leftValue: "={{ $('Normaliza Payload').first().json.messageType }}", rightValue: 'audioMessage', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } }, renameOutput: true, outputKey: 'audio' },
          { conditions: { combinator: 'and', conditions: [{ id: 's-image', leftValue: "={{ $('Normaliza Payload').first().json.messageType }}", rightValue: 'imageMessage', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } }, renameOutput: true, outputKey: 'image' },
          { conditions: { combinator: 'and', conditions: [{ id: 's-doc', leftValue: "={{ $('Normaliza Payload').first().json.messageType }}", rightValue: 'documentMessage', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } }, renameOutput: true, outputKey: 'document' },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'unknown' },
    },
    position: [1600, 600],
  },
});

const extractText = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extract Text',
    parameters: {
      assignments: {
        assignments: [
          { id: 'et-msg', name: 'message', value: "={{ $('Normaliza Payload').first().json.conversation || '' }}", type: 'string' },
          { id: 'et-clinical', name: 'clinical', value: false, type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 560],
  },
  output: [{ message: '', clinical: false }],
});

const extractBase64Audio = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Extrai Base64 Audio',
    parameters: {
      assignments: {
        assignments: [
          { id: 'au-b64', name: 'base64', value: "={{ $('Normaliza Payload').first().json.data?.message?.audioMessage?.base64 || $('Normaliza Payload').first().json.data?.message?.base64 || '' }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 720],
  },
  output: [{ base64: '' }],
});

const audioToFile = node({
  type: 'n8n-nodes-base.convertToFile',
  version: 1.1,
  config: {
    name: 'Base64 to Audio File',
    parameters: {
      operation: 'toBinary',
      sourceProperty: 'base64',
      options: { fileName: 'audio', mimeType: 'audio/ogg' },
    },
    position: [2000, 720],
  },
  output: [{}],
});

const transcribeAudio = node({
  type: '@n8n/n8n-nodes-langchain.openAi',
  version: 1.8,
  config: {
    name: 'Transcribe Audio',
    parameters: {
      resource: 'audio',
      operation: 'transcribe',
      options: {},
    },
    credentials: { openAiApi: newCredential('igor_openai') },
    position: [2200, 720],
  },
  output: [{ text: '' }],
});

const padronizaAudio = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Padroniza Saida Audio',
    parameters: {
      assignments: {
        assignments: [
          { id: 'pa-msg', name: 'message', value: "={{ $json.text || $json.transcription || '[áudio]' }}", type: 'string' },
          { id: 'pa-clinical', name: 'clinical', value: false, type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2400, 720],
  },
  output: [{ message: '', clinical: false }],
});

const prepareImage = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Preparar Imagem',
    parameters: {
      assignments: {
        assignments: [
          { id: 'im-b64', name: 'imageBase64', value: "={{ $('Normaliza Payload').first().json.data?.message?.imageMessage?.base64 || $('Normaliza Payload').first().json.data?.message?.base64 || '' }}", type: 'string' },
          { id: 'im-caption', name: 'caption', value: "={{ $('Normaliza Payload').first().json.data?.message?.imageMessage?.caption || '' }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 880],
  },
  output: [{ imageBase64: '', caption: '' }],
});

const imageToFile = node({
  type: 'n8n-nodes-base.convertToFile',
  version: 1.1,
  config: {
    name: 'Base64 to Image File',
    parameters: {
      operation: 'toBinary',
      sourceProperty: 'imageBase64',
      binaryPropertyName: 'image',
      options: { fileName: 'imagem' },
    },
    position: [2000, 880],
  },
  output: [{}],
});

const analyzeImage = node({
  type: '@n8n/n8n-nodes-langchain.openAi',
  version: 1.8,
  config: {
    name: 'Analyze Image',
    parameters: {
      resource: 'image',
      operation: 'analyze',
      modelId: { __rl: true, value: 'gpt-4o-mini', mode: 'list' },
      text:
        'Você analisa imagens enviadas por pacientes via WhatsApp da clínica Dr. Igor.\n\n' +
        'A imagem pode ser:\n' +
        '- documento clínico (exame, laudo, receita, prescrição, antes/depois, foto do corpo)\n' +
        '- imagem genérica (selfie, paisagem, foto comum)\n\n' +
        'Sua tarefa:\n' +
        '1. Identificar se é conteúdo clínico/sensível.\n' +
        '2. Responder APENAS em JSON: {"clinical": true|false, "tipo": "exame|laudo|receita|antes_depois|foto_corpo|generica", "descricao": "breve, sem interpretar nada clinicamente"}\n\n' +
        'NUNCA interprete clinicamente exames/laudos/receitas. Sua função é só CLASSIFICAR.',
      inputType: 'base64',
      binaryPropertyName: 'image',
      options: {},
    },
    credentials: { openAiApi: newCredential('igor_openai') },
    position: [2200, 880],
  },
  output: [{ content: [{ text: '' }] }],
});

const normalizeImageResult = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Normalize Image Result',
    parameters: {
      assignments: {
        assignments: [
          { id: 'ni-msg', name: 'message', value: "={{ (() => { try { const txt = $json.content?.[0]?.text || $json.message?.content || $json.text || ''; const parsed = JSON.parse(txt); return '[imagem ' + (parsed.tipo || 'recebida') + ': ' + (parsed.descricao || '') + ']'; } catch(e) { return '[imagem recebida]'; } })() }}", type: 'string' },
          { id: 'ni-clinical', name: 'clinical', value: "={{ (() => { try { const txt = $json.content?.[0]?.text || $json.message?.content || $json.text || ''; const parsed = JSON.parse(txt); return parsed.clinical === true; } catch(e) { return false; } })() }}", type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2400, 880],
  },
  output: [{ message: '', clinical: false }],
});

const handleDocument = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Handle Document',
    parameters: {
      assignments: {
        assignments: [
          { id: 'doc-msg', name: 'message', value: "={{ '[documento: ' + ($('Normaliza Payload').first().json.data?.message?.documentMessage?.fileName || 'sem nome') + ']' }}", type: 'string' },
          { id: 'doc-clinical', name: 'clinical', value: "={{ (() => { const fn = ($('Normaliza Payload').first().json.data?.message?.documentMessage?.fileName || '').toLowerCase(); const cap = ($('Normaliza Payload').first().json.data?.message?.documentMessage?.caption || '').toLowerCase(); const re = /(exame|laudo|receita|prescr|hemograma|ressonancia|tomografia|raio|raio-x|raio x|ultrassom|ecografia|biopsia|consulta|atestado)/; return re.test(fn) || re.test(cap); })() }}", type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 1040],
  },
  output: [{ message: '', clinical: false }],
});

const handleUnknown = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Handle Unknown',
    parameters: {
      assignments: {
        assignments: [
          { id: 'unk-msg', name: 'message', value: "={{ '[mensagem do tipo ' + ($('Normaliza Payload').first().json.messageType || 'desconhecido') + ']' }}", type: 'string' },
          { id: 'unk-clinical', name: 'clinical', value: false, type: 'boolean' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1800, 1200],
  },
  output: [{ message: '', clinical: false }],
});

const prepareForRedis = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare for Redis',
    parameters: {
      assignments: {
        assignments: [
          { id: 'pr-phone', name: 'phone', value: "={{ $('Normaliza Payload').first().json.phone }}", type: 'string' },
          { id: 'pr-msg', name: 'message', value: "={{ $json.message || '' }}", type: 'string' },
          { id: 'pr-msgid', name: 'msgId', value: "={{ $('Normaliza Payload').first().json.msgId }}", type: 'string' },
          { id: 'pr-cwconv', name: 'chatwootConversationId', value: "={{ $('Normaliza Payload').first().json.chatwootConversationId }}", type: 'number' },
          { id: 'pr-cwinbox', name: 'chatwootInboxId', value: "={{ $('Normaliza Payload').first().json.chatwootInboxId }}", type: 'number' },
          { id: 'pr-mtype', name: 'messageType', value: "={{ $('Normaliza Payload').first().json.messageType }}", type: 'string' },
          { id: 'pr-clinical', name: 'clinical', value: "={{ $json.clinical === true }}", type: 'boolean' },
          { id: 'pr-payload', name: 'redis_payload', value: "={{ JSON.stringify({ msgId: $('Normaliza Payload').first().json.msgId, message: ($json.message || ''), chatwootConversationId: $('Normaliza Payload').first().json.chatwootConversationId, chatwootInboxId: $('Normaliza Payload').first().json.chatwootInboxId, messageType: $('Normaliza Payload').first().json.messageType, clinical: $json.clinical === true }) }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2600, 720],
  },
  output: [{ phone: '', message: '', msgId: '', chatwootConversationId: 0, chatwootInboxId: 0, messageType: '', clinical: false, redis_payload: '' }],
});

const redisPush = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Push',
    parameters: {
      operation: 'push',
      list: "={{ 'igor:batch:' + $('Prepare for Redis').first().json.phone }}",
      messageData: "={{ $('Prepare for Redis').first().json.redis_payload }}",
      tail: true,
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [2800, 720],
  },
  output: [{}],
});

const wait10s = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 10s', parameters: { amount: 10, unit: 'seconds' }, position: [3000, 720] },
  output: [{}],
});

const redisGet = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Get',
    parameters: {
      operation: 'get',
      key: "={{ 'igor:batch:' + $('Prepare for Redis').first().json.phone }}",
      keyType: 'list',
      propertyName: 'message',
    },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [3200, 720],
    alwaysOutputData: true,
  },
  output: [{ message: [] }],
});

const parseRedisBatchJs =
  'const raw = $json.message;\n' +
  'const rawEntries = Array.isArray(raw) ? raw : (raw ? [raw] : []);\n' +
  'const entries = rawEntries.map(function(entry){ if (typeof entry !== "string") return entry; try { return JSON.parse(entry); } catch(e) { return { msgId: null, message: entry, chatwootConversationId: null, chatwootInboxId: null, clinical: false, legacy: true }; } });\n' +
  "const current = $('Prepare for Redis').first().json;\n" +
  'const lastEntry = entries.length ? entries[entries.length - 1] : null;\n' +
  'const lastWithContext = entries.slice().reverse().find(function(e){ return e.chatwootConversationId || e.chatwootInboxId; }) || {};\n' +
  'const mergedMessages = entries.map(function(e){ return e.message || ""; }).filter(Boolean).join("\\n");\n' +
  'const anyClinical = entries.some(function(e){ return e.clinical === true; });\n' +
  'return [{ json: { entries: entries, last_match_key: (lastEntry && (lastEntry.msgId || lastEntry.message)) || "", current_match_key: current.msgId || current.message || "", txt: mergedMessages, phone: current.phone, chatwootConversationId: lastWithContext.chatwootConversationId || current.chatwootConversationId || null, chatwootInboxId: lastWithContext.chatwootInboxId || current.chatwootInboxId || null, clinical: anyClinical, fragments_count: entries.length || 1 } }];';

const parseRedisBatch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Parse Redis Batch', parameters: { mode: 'runOnceForAllItems', jsCode: parseRedisBatchJs }, position: [3400, 720] },
  output: [{ last_match_key: '', current_match_key: '', txt: '', phone: '', chatwootConversationId: 0, chatwootInboxId: 0, clinical: false, fragments_count: 1 }],
});

const ifLastMessage = ifElse({
  version: 2.2,
  config: {
    name: 'IF Last Message',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          { id: 'last-msg', leftValue: '={{ $json.last_match_key }}', rightValue: '={{ $json.current_match_key }}', operator: { type: 'string', operation: 'equals' } },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [3600, 720],
  },
});

const noOpNotLast = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'No Op (not last)', parameters: {}, position: [3800, 880] },
  output: [{}],
});

const mergeMessages = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Merge Messages',
    parameters: {
      assignments: {
        assignments: [
          { id: 'mm-phone', name: 'phone', value: '={{ $json.phone }}', type: 'string' },
          { id: 'mm-txt', name: 'txt', value: '={{ $json.txt }}', type: 'string' },
          { id: 'mm-cwconv', name: 'chatwootConversationId', value: '={{ $json.chatwootConversationId }}', type: 'number' },
          { id: 'mm-cwinbox', name: 'chatwootInboxId', value: '={{ $json.chatwootInboxId }}', type: 'number' },
          { id: 'mm-clinical', name: 'clinical', value: '={{ $json.clinical }}', type: 'boolean' },
          { id: 'mm-frag', name: 'fragments_count', value: '={{ $json.fragments_count }}', type: 'number' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [3800, 600],
  },
  output: [{ phone: '', txt: '', chatwootConversationId: 0, chatwootInboxId: 0, clinical: false, fragments_count: 1 }],
});

const redisDelete = node({
  type: 'n8n-nodes-base.redis',
  version: 1,
  config: {
    name: 'Redis Delete',
    parameters: { operation: 'delete', key: "={{ 'igor:batch:' + $('Merge Messages').first().json.phone }}" },
    credentials: { redis: newCredential('igor_redis_embedded') },
    position: [4000, 600],
  },
  output: [{}],
});

const upsertConvAiQuery =
  "WITH ct AS (INSERT INTO public.contacts (phone, name) VALUES ($1::text, NULLIF($2::text,'')) ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name,''), public.contacts.name), updated_at = now() RETURNING id)\n" +
  "INSERT INTO public.conversations (contact_id, chatwoot_conversation_id, chatwoot_inbox_id, state, ai_enabled, human_locked, current_flow, owner_flow, assigned_team_id, journey_started_at, turn_count, last_message_at)\n" +
  "SELECT ct.id, NULLIF($3::text,'')::int, COALESCE(NULLIF($4::text,'')::int, 1), 'ai_after_hours', true, false, 'after_hours', 'ai_active', $5::int, now(), 1, now() FROM ct\n" +
  "ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET state='ai_after_hours', ai_enabled=true, owner_flow='ai_active', assigned_team_id=$5::int, journey_started_at=COALESCE(public.conversations.journey_started_at, now()), turn_count=public.conversations.turn_count + 1, last_message_at=now(), updated_at=now()\n" +
  'RETURNING id::text AS conversation_uuid, chatwoot_conversation_id, owner_flow, turn_count;';

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
          "={{ (function(){ const m = $('Merge Messages').first().json; const ec = $('Extrair Campos').first().json; const g = $('Compute Gates').first().json; return [m.phone, ec.pushName||'', String(m.chatwootConversationId||''), String(m.chatwootInboxId||''), String(g.ai_team_id)]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [4200, 600],
  },
  output: [{ conversation_uuid: '', chatwoot_conversation_id: 0, owner_flow: 'ai_active', turn_count: 1 }],
});

const logUserMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log User Message',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.messages (conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me, safety_flags, created_at) SELECT c.id, NULLIF($1::text,''), $2::text, $2::text, 'text', 'inbound', 'user', false, $3::jsonb, now() FROM public.conversations c WHERE c.chatwoot_conversation_id = NULLIF($4::text,'')::int ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO NOTHING;",
      options: {
        queryReplacement:
          "={{ (function(){ const m = $('Merge Messages').first().json; const ec = $('Extrair Campos').first().json; return [ec.msgId, m.txt, JSON.stringify({ clinical: m.clinical }), String(m.chatwootConversationId||'')]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [4400, 600],
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
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Merge Messages').first().json.chatwootConversationId }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ team_id: Number($('Compute Gates').first().json.ai_team_id) }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 15000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [4600, 600],
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
      workflowId: { __rl: true, mode: 'id', value: IGOR_LABELS_ID, cachedResultName: 'IGOR_04_Tool_Labels_Attributes' },
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Merge Messages').first().json.chatwootConversationId }}",
          chatwoot_contact_id: "={{ $('Extrair Campos').first().json.chatwootContactId || '' }}",
          labels_to_add: "={{ ['lead_novo', 'fora_expediente', 'ai_after_hours'] }}",
          labels_to_remove: '={{ [] }}',
          custom_attributes: "={{ ({ conversation: { automation_state: 'ai_after_hours', owner_flow: 'ai_active', lead_status: 'qualificacao_inicial' }, contact: {} }) }}",
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
    position: [4800, 600],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

// ===== Alice Agent + tools =====

const openAiModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Model Alice',
    parameters: { model: { __rl: true, value: 'gpt-4.1-mini', mode: 'list' }, options: { temperature: 0.3 } },
    credentials: { openAiApi: newCredential('igor_openai') },
    position: [4900, 880],
  },
});

const aliceMemory = memory({
  type: '@n8n/n8n-nodes-langchain.memoryPostgresChat',
  version: 1.4,
  config: {
    name: 'Memory Alice',
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: "=after_hours_{{ $('Merge Messages').first().json.phone }}",
      tableName: 'n8n_chat_histories',
      contextWindowLength: 25,
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [5050, 880],
  },
});

const setLabelTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'set_label_and_attr',
    parameters: {
      description: 'Aplica labels e custom_attributes na conversa Chatwoot atual. Use ao marcar transição: qualificacao_rapida após coletar nome+objetivo, callback_solicitado após período, ou compliance_humano em conteúdo clínico. NUNCA apague labels existentes.',
      workflowId: { __rl: true, mode: 'id', value: IGOR_LABELS_ID, cachedResultName: 'IGOR_04_Tool_Labels_Attributes' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Merge Messages').first().json.chatwootConversationId }}",
          chatwoot_contact_id: '',
          labels_to_add: '={{ $fromAI("labels_to_add", "Array de labels a adicionar (ex: qualificacao_rapida, callback_solicitado).", "json") }}',
          labels_to_remove: '={{ $fromAI("labels_to_remove", "Array de labels a remover.", "json") }}',
          custom_attributes: '={{ $fromAI("custom_attributes", "Objeto {conversation: {}, contact: {}} para PATCH no Chatwoot.", "json") }}',
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
    },
    position: [5200, 880],
  },
});

const handoffTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'request_handoff',
    parameters: {
      description: 'Finaliza atendimento e transfere para equipe humana via IGOR_Handoff. Use APENAS quando: (a) coletou nome+objetivo+período → outcome=qualified, (b) lead não engajou ou max 6 turnos → outcome=unqualified, (c) conteúdo clínico/sensível → outcome=compliance. SEMPRE forneça outcome, lead_name, handoff_reason, summary PT-BR. Após chamar, envie a mensagem final ao lead e PARE de responder.',
      workflowId: { __rl: true, mode: 'id', value: IGOR_HANDOFF_ID, cachedResultName: 'IGOR_Handoff' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Merge Messages').first().json.chatwootConversationId }}",
          chatwoot_contact_id: '',
          outcome: '={{ $fromAI("outcome", "qualified | unqualified | compliance", "string") }}',
          lead_name: '={{ $fromAI("lead_name", "Nome do lead se coletado, vazio se não.", "string") }}',
          lead_phone: "={{ $('Merge Messages').first().json.phone }}",
          handoff_reason: '={{ $fromAI("handoff_reason", "Motivo: after_hours_callback, lead_disengaged, max_turns_reached, off_topic, pedido_humano, documento_clinico_sensivel.", "string") }}',
          summary: '={{ $fromAI("summary", "Resumo 1-2 frases PT-BR para a atendente humana.", "string") }}',
          callback_period: '={{ $fromAI("callback_period", "Período de retorno informado pelo lead (ex: manhã, tarde, horário X).", "string") }}',
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'outcome', displayName: 'outcome', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'lead_name', displayName: 'lead_name', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'lead_phone', displayName: 'lead_phone', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'handoff_reason', displayName: 'handoff_reason', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'summary', displayName: 'summary', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'callback_period', displayName: 'callback_period', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [5400, 880],
  },
});

const aliceSystemPrompt =
  '=<context>\n' +
  "Telefone do lead: {{ $('Merge Messages').first().json.phone }}\n" +
  "Conversa Chatwoot: {{ $('Merge Messages').first().json.chatwootConversationId }}\n" +
  "Turno atual: {{ $('UPSERT conv ai_active').first().json.turn_count }}\n" +
  "Conteúdo clínico detectado: {{ $('Merge Messages').first().json.clinical }}\n" +
  '</context>\n\n' +
  '<role>\n' +
  'Você é Alice, assistente virtual do Instituto Dr. Igor (clínica médica). Atua APENAS no fluxo receptivo fora do expediente humano e SOMENTE em LEADS NOVOS. Função: acolher, qualificar minimamente e entregar o lead à equipe humana no próximo dia útil.\n' +
  '</role>\n\n' +
  '<objetivo>\n' +
  'Coletar 3 informações em até 6 turnos:\n' +
  '1. Nome do lead\n' +
  '2. Objetivo principal (emagrecimento, performance, reposição hormonal, estética, saúde geral)\n' +
  '3. Melhor período/horário para retorno (manhã/tarde + horário aproximado)\n' +
  '</objetivo>\n\n' +
  '<gatilhos_de_handoff>\n' +
  '- Coletou os 3 → request_handoff(outcome="qualified") + mensagem final + PARE\n' +
  '- 6 turnos sem coletar mínimo → request_handoff(outcome="unqualified", handoff_reason="max_turns_reached")\n' +
  '- Lead disengage explícito (não quero, depois eu vejo, off-topic) → request_handoff(outcome="unqualified", handoff_reason="lead_disengaged")\n' +
  '- Conteúdo clínico/sensível detectado (clinical=true OU lead enviou exame/laudo/imagem do corpo) → request_handoff(outcome="compliance", handoff_reason="documento_clinico_sensivel")\n' +
  '- Lead insiste em falar com humano → request_handoff(outcome="qualified", handoff_reason="pedido_humano")\n' +
  '</gatilhos_de_handoff>\n\n' +
  '<comportamento>\n' +
  '- Natural, conversacional, frases curtas estilo WhatsApp. Uma pergunta por vez.\n' +
  '- Sem emoji, sem caixa alta, sem markdown.\n' +
  '- Tom acolhedor, seguro, profissional.\n' +
  '- Separe mensagens em parágrafos (linha em branco entre). Até 3 parágrafos por turno.\n' +
  '- Não use termos internos: "workflow", "lead", "label", "handoff", "IA", "automação", "tool", "sistema".\n' +
  '</comportamento>\n\n' +
  '<proibicoes>\n' +
  '- Diagnosticar, prescrever, interpretar exames/laudos/imagens.\n' +
  '- Pedir CPF, RG, plano de saúde, histórico médico extenso.\n' +
  '- Simular agendamento real ("reservei", "marquei", "confirmei horário do Dr.").\n' +
  '- Inventar preço, condição comercial, política, disponibilidade.\n' +
  '- Continuar respondendo após request_handoff.\n' +
  '</proibicoes>\n\n' +
  '<sequencia_tipica>\n' +
  '1. Primeira msg sem nome: saudação + apresentação + aviso fora do expediente + pergunta nome.\n' +
  '   Ex: "Oi, tudo bem? Sou a Alice, assistente do Dr. Igor. A equipe encerrou o expediente, mas posso adiantar seu atendimento por aqui. Qual seu nome?"\n' +
  '2. Lead diz nome: confirme + pergunte objetivo.\n' +
  '3. Lead diz objetivo: acolha sem prometer + pergunte período.\n' +
  '4. Lead diz período: request_handoff(qualified) + mensagem final.\n' +
  '   Ex: "Combinado, {nome}. Vou deixar registrado pra equipe te chamar amanhã de {período}."\n' +
  '</sequencia_tipica>\n\n' +
  '<edge_cases>\n' +
  '- Pergunta preço: "A equipe confirma valores quando ligar. Qual o melhor período?"\n' +
  '- Pede agendamento direto: "A equipe finaliza horários. Qual período é melhor pra te chamar?"\n' +
  '- Manda áudio: trate a transcrição como texto comum.\n' +
  '- Manda exame/laudo/imagem clínica: NÃO interprete. request_handoff(compliance).\n' +
  '- Quer parar contato: agradeça + register opt-out (será tratado em pipeline separado) + request_handoff(unqualified).\n' +
  '</edge_cases>\n\n' +
  '<tools>\n' +
  '- set_label_and_attr: aplicar labels operacionais (qualificacao_rapida, callback_solicitado, compliance_humano) e custom_attributes.\n' +
  '- request_handoff: ÚNICA forma de finalizar o atendimento. Sempre passe outcome.\n' +
  '</tools>\n\n' +
  '<formato>\n' +
  'Responda em PT-BR natural estilo WhatsApp. Sem prefixos, sem "(resposta:)" — apenas o texto que o lead vai ver. Use linha em branco para separar parágrafos (cada parágrafo vira uma mensagem).\n' +
  '</formato>';

const aliceAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Alice Agent',
    parameters: {
      promptType: 'define',
      text: "={{ $('Merge Messages').first().json.txt }}",
      options: {
        systemMessage: aliceSystemPrompt,
        maxIterations: 6,
        returnIntermediateSteps: false,
      },
    },
    subnodes: {
      model: openAiModel,
      memory: aliceMemory,
      tools: [setLabelTool, handoffTool],
    },
    position: [5000, 600],
  },
  output: [{ output: '' }],
});

const logAssistantMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Assistant Message',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.messages (conversation_id, text, normalized_text, message_type, direction, role, from_me, created_at) SELECT c.id, $1::text, $1::text, 'text', 'outbound', 'assistant', false, now() FROM public.conversations c WHERE c.chatwoot_conversation_id = NULLIF($2::text,'')::int;",
      options: {
        queryReplacement:
          "={{ [$('Alice Agent').first().json.output || '', String($('Merge Messages').first().json.chatwootConversationId||'')] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [5200, 600],
    executeOnce: true,
  },
  output: [{}],
});

const formatAiOutputJs =
  "const raw = String($('Alice Agent').first().json.output || '').trim();\n" +
  'if (!raw) return [{ json: { messages: [], message_count: 0 } }];\n' +
  'const parts = raw.indexOf("||") !== -1 ? raw.split(/\\s*\\|\\|\\s*/) : raw.split(/\\n{2,}/);\n' +
  'const messages = parts.map(function(p){ return p.trim(); }).filter(function(p){ return p.length > 0; }).slice(0, 4);\n' +
  'return [{ json: { messages: messages, message_count: messages.length, raw_output: raw } }];';

const formatAiOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Format AI Output', parameters: { mode: 'runOnceForAllItems', jsCode: formatAiOutputJs }, position: [5400, 600] },
  output: [{ messages: [], message_count: 0, raw_output: '' }],
});

const splitMessages = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: {
    name: 'Split Messages',
    parameters: { fieldToSplitOut: 'messages', include: 'noOtherFields', options: { destinationFieldName: 'message' } },
    position: [5600, 600],
  },
  output: [{ message: '' }],
});

const loopItems = splitInBatches({
  version: 3,
  config: { name: 'Loop Items', parameters: { batchSize: 1, options: {} }, position: [5800, 600] },
});

const presenceComposing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Presence Composing',
    parameters: {
      method: 'POST',
      url: '=https://evo.almaconvert.com.br/chat/sendPresence/convert-teste',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ number: $('Merge Messages').first().json.phone, presence: 'composing', delay: Math.max(800, Math.min(3000, String($('Loop Items').item.json.message || '').length * 30)) }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 10000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    onError: 'continueRegularOutput',
    position: [6000, 720],
  },
  output: [{ ok: true }],
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
      jsonBody: "={{ JSON.stringify({ number: $('Merge Messages').first().json.phone, text: $('Loop Items').item.json.message }) }}",
      options: { response: { response: { neverError: false, responseFormat: 'json' } }, timeout: 20000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [6200, 720],
  },
  output: [{ key: { id: '' } }],
});

const wait2s = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 2s', parameters: { amount: 2, unit: 'seconds' }, position: [6400, 720] },
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
          { id: 'fo-branch', name: 'branch', value: 'routed_ai', type: 'string' },
          { id: 'fo-msgs', name: 'messages_sent', value: "={{ $('Format AI Output').first().json.message_count }}", type: 'number' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [6000, 480],
    executeOnce: true,
  },
  output: [{ ok: true, branch: 'routed_ai', messages_sent: 0 }],
});

export default workflow('igor-inbound', 'IGOR_Inbound')
  .add(evolutionWebhook)
  .to(extractFields)
  .to(normalizePayload)
  .to(
    ifLeadMessage
      .onFalse(noOpFromMe)
      .onTrue(
        loadState
          .to(computeGates)
          .to(
            ifBlocked
              .onTrue(insertBlockedEvent.to(respBlocked))
              .onFalse(
                ifMoveToHuman
                  .onTrue(upsertConvHuman.to(postAssignHumanTeam.to(insertMovedEvent.to(respMoved))))
                  .onFalse(
                    switchMessageType
                      .onCase(0, extractText.to(prepareForRedis))
                      .onCase(1, extractText.to(prepareForRedis))
                      .onCase(2, extractBase64Audio.to(audioToFile.to(transcribeAudio.to(padronizaAudio.to(prepareForRedis)))))
                      .onCase(3, prepareImage.to(imageToFile.to(analyzeImage.to(normalizeImageResult.to(prepareForRedis)))))
                      .onCase(4, handleDocument.to(prepareForRedis))
                      .onCase(5, handleUnknown.to(prepareForRedis))
                  )
              )
          )
      )
  )
  .add(prepareForRedis)
  .to(redisPush)
  .to(wait10s)
  .to(redisGet)
  .to(parseRedisBatch)
  .to(
    ifLastMessage
      .onFalse(noOpNotLast)
      .onTrue(
        mergeMessages
          .to(redisDelete)
          .to(upsertConvAi)
          .to(logUserMessage)
          .to(postAssignAiTeam)
          .to(callIgor04Labels)
          .to(aliceAgent)
          .to(logAssistantMessage)
          .to(formatAiOutput)
          .to(splitMessages)
          .to(
            loopItems
              .onDone(finalOutput)
              .onEachBatch(presenceComposing.to(sendWhatsApp.to(wait2s.to(nextBatch(loopItems)))))
          )
      )
  );
