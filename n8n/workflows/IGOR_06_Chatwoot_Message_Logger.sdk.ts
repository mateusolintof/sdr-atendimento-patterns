import { workflow, node, trigger, ifElse, switchCase, merge, newCredential } from '@n8n/workflow-sdk';

const chatwootWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Chatwoot Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'igor/chatwoot',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
      options: { rawBody: false, responseCode: { values: { responseCode: 200 } } },
    },
    position: [0, 480],
  },
  output: [{ body: {} }],
});

const isMessageCreated = ifElse({
  version: 2.3,
  config: { name: 'IF event=message_created', parameters: { conditions: { combinator: 'and', conditions: [{ id: 'evt-cond', leftValue: "={{ $json.body && $json.body.event }}", rightValue: 'message_created', operator: { type: 'string', operation: 'equals', singleValue: true } }], options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 } } }, position: [224, 480] },
});

const normalizeJs = 'const items = $input.all();\nreturn items.map(item => {\n  const root = item.json || {};\n  const b = root.body || root;\n  const account = b.account || {};\n  const conversation = b.conversation || {};\n  const sender = b.sender || {};\n  const contactInbox = conversation.contact_inbox || {};\n  const additional = b.additional_attributes || {};\n  const additionalConv = (conversation.additional_attributes || {});\n  const accountId = (account.id !== undefined && account.id !== null) ? String(account.id) : "";\n  const conversationId = (conversation.id !== undefined && conversation.id !== null) ? String(conversation.id) : "";\n  const contactId = (contactInbox.contact_id !== undefined && contactInbox.contact_id !== null) ? String(contactInbox.contact_id) : ((sender.type === "contact" && sender.id !== undefined && sender.id !== null) ? String(sender.id) : "");\n  const messageId = (b.id !== undefined && b.id !== null) ? String(b.id) : "";\n  const messageType = (b.message_type === undefined || b.message_type === null) ? "" : String(b.message_type);\n  const senderType = (sender.type === undefined || sender.type === null) ? "" : String(sender.type);\n  const senderId = (sender.id !== undefined && sender.id !== null) ? String(sender.id) : "";\n  const senderName = (sender.name === undefined || sender.name === null) ? "" : String(sender.name);\n  const content = (b.content === undefined || b.content === null) ? "" : String(b.content);\n  const contentAttributes = b.content_attributes || {};\n  const createdAt = b.created_at || new Date().toISOString();\n  const testRunId = additional.test_run_id || additionalConv.test_run_id || null;\n  let direction;\n  if (messageType === "incoming") direction = "inbound";\n  else if (messageType === "outgoing") direction = "outbound";\n  else direction = "internal";\n  let role;\n  if (senderType === "contact") role = "user";\n  else if (senderType === "user") role = "agent";\n  else if (senderType === "agent_bot") role = "assistant";\n  else role = "system";\n  const fromMe = (messageType === "outgoing");\n  let branch;\n  if (messageType === "outgoing" && senderType === "user") branch = "human_takeover";\n  else if (messageType === "outgoing" && senderType === "agent_bot") branch = "bot_noop";\n  else if (messageType === "incoming" && senderType === "contact") branch = "inbound_noop";\n  else branch = "unhandled";\n  return { json: { account_id: accountId, chatwoot_conversation_id: conversationId, chatwoot_contact_id: contactId, msg_id: messageId, message_type: messageType, sender_type: senderType, sender_id: senderId, sender_name: senderName, content: content, content_attributes_json: JSON.stringify(contentAttributes), created_at: createdAt, direction: direction, role: role, from_me: fromMe, _branch: branch, test_run_id: testRunId } };\n});';

const normalizeChatwoot = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Normalize Chatwoot Message', parameters: { mode: 'runOnceForAllItems', jsCode: normalizeJs }, position: [448, 288] },
  output: [{ chatwoot_conversation_id: '', _branch: 'unhandled' }],
});

const upsertMessages = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'UPSERT Messages', parameters: { operation: 'executeQuery', query: "INSERT INTO public.messages (conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me, created_at) SELECT c.id, NULLIF($1::text, ''), $2::text, NULL, COALESCE(NULLIF($3::text, ''), 'text'), $4::text, $5::text, $6::boolean, COALESCE(NULLIF($7::text, '')::timestamptz, now()) FROM public.conversations c WHERE c.chatwoot_conversation_id = NULLIF($8::text, '')::int ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE SET text = EXCLUDED.text, direction = EXCLUDED.direction, role = EXCLUDED.role, from_me = EXCLUDED.from_me;", options: { queryReplacement: "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.msg_id, m.content, 'text', m.direction, m.role, m.from_me, m.created_at, m.chatwoot_conversation_id]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [672, 288] },
  output: [{}],
});

const insertMirrored = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'INSERT message_mirrored', parameters: { operation: 'executeQuery', query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('message_mirrored', NULL, NULLIF($1::text, '')::int, 'IGOR_06_Chatwoot_Message_Logger', $2::jsonb);", options: { queryReplacement: "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ msg_id: m.msg_id, message_type: m.message_type, sender_type: m.sender_type, sender_id: m.sender_id, direction: m.direction, role: m.role, from_me: m.from_me, branch: m._branch, content_length: (m.content || '').length, test_run_id: m.test_run_id })]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [896, 288] },
  output: [{}],
});

const insertEventFiltered = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'INSERT event_filtered', parameters: { operation: 'executeQuery', query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('event_filtered', NULL, NULLIF($1::text, '')::int, 'IGOR_06_Chatwoot_Message_Logger', $2::jsonb);", options: { queryReplacement: "={{ (function(){ const b = ($('Chatwoot Webhook').first() && $('Chatwoot Webhook').first().json && $('Chatwoot Webhook').first().json.body) || {}; const cid = (b.conversation && b.conversation.id) ? String(b.conversation.id) : ''; return [cid, JSON.stringify({ reason: 'event_not_message_created', event: b.event || null, message_type: b.message_type || null, test_run_id: (b.additional_attributes && b.additional_attributes.test_run_id) || null })]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [1792, 768] },
  output: [{}],
});

const filteredResponse = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Filtered Response', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'fr-ok', name: 'ok', value: true, type: 'boolean' }, { id: 'fr-branch', name: 'branch', value: 'event_filtered', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [2016, 768] },
  output: [{ ok: true, branch: 'event_filtered' }],
});

const mergeBranches = merge({
  version: 3.2,
  config: { name: 'Merge Branches', parameters: { mode: 'append', numberInputs: 5 }, position: [2240, 336] },
});

const routeByBranch = switchCase({
  version: 3.4,
  config: {
    name: 'Route By Branch',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'case-human-takeover', leftValue: "={{ $('Normalize Chatwoot Message').first().json._branch }}", rightValue: 'human_takeover', operator: { type: 'string', operation: 'equals', singleValue: true } }] }, renameOutput: true, outputKey: 'human_takeover' },
          { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'case-bot-noop', leftValue: "={{ $('Normalize Chatwoot Message').first().json._branch }}", rightValue: 'bot_noop', operator: { type: 'string', operation: 'equals', singleValue: true } }] }, renameOutput: true, outputKey: 'bot_noop' },
          { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'case-inbound-noop', leftValue: "={{ $('Normalize Chatwoot Message').first().json._branch }}", rightValue: 'inbound_noop', operator: { type: 'string', operation: 'equals', singleValue: true } }] }, renameOutput: true, outputKey: 'inbound_noop' },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'unhandled', ignoreCase: true, allMatchingOutputs: false },
    },
    position: [1120, 256],
  },
});

const updateConvHumanLocked = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'UPDATE conversations human_assumed', parameters: { operation: 'executeQuery', query: "UPDATE public.conversations SET human_locked = true, ai_enabled = false, state = 'human_assigned', owner_flow = 'human_daytime', last_human_message_at = COALESCE(NULLIF($1::text, '')::timestamptz, now()), updated_at = now() WHERE chatwoot_conversation_id = NULLIF($2::text, '')::int RETURNING id, chatwoot_conversation_id, human_locked, ai_enabled, owner_flow, state;", options: { queryReplacement: "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.created_at, m.chatwoot_conversation_id]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [1344, 0] },
  output: [{ id: '', chatwoot_conversation_id: 0, owner_flow: 'human_daytime' }],
});

const callIgor04HumanTakeover = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: { name: 'CALL IGOR_04 atendimento_humano', parameters: { source: 'database', workflowId: { __rl: true, mode: 'id', value: 'AJF7dhGrqJEXMLqz', cachedResultName: 'IGOR_04_Tool_Labels_Attributes' }, mode: 'once', workflowInputs: { mappingMode: 'defineBelow', value: { chatwoot_conversation_id: "={{ $('Normalize Chatwoot Message').first().json.chatwoot_conversation_id }}", chatwoot_contact_id: "={{ $('Normalize Chatwoot Message').first().json.chatwoot_contact_id }}", labels_to_add: "={{ ['atendimento_humano', 'ai_disabled'] }}", labels_to_remove: '={{ [] }}', custom_attributes: "={{ ({ conversation: { automation_state: 'human_assigned', owner_flow: 'human_daytime', lead_status: 'humano_em_atendimento', taken_at: $('Normalize Chatwoot Message').first().json.created_at }, contact: {} }) }}", test_run_id: "={{ $('Normalize Chatwoot Message').first().json.test_run_id }}" }, matchingColumns: [], schema: [{ id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }, { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }, { id: 'labels_to_add', displayName: 'labels_to_add', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' }, { id: 'labels_to_remove', displayName: 'labels_to_remove', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'array' }, { id: 'custom_attributes', displayName: 'custom_attributes', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'object' }, { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }], attemptToConvertTypes: false, convertFieldsToString: false }, options: { waitForSubWorkflow: true } }, position: [1568, 0] },
  output: [{ ok: true }],
});

const insertHumanAssumed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'INSERT human_assumed', parameters: { operation: 'executeQuery', query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('human_assumed', NULL, NULLIF($1::text, '')::int, 'IGOR_06_Chatwoot_Message_Logger', $2::jsonb);", options: { queryReplacement: "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ chatwoot_conversation_id: m.chatwoot_conversation_id, chatwoot_contact_id: m.chatwoot_contact_id, agent_user_id: m.sender_id, agent_user_name: m.sender_name, msg_id: m.msg_id, taken_at: m.created_at, labels_applied: ['atendimento_humano','ai_disabled'], owner_flow: 'human_daytime', test_run_id: m.test_run_id })]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [1792, 0] },
  output: [{}],
});

const humanTakeoverOutput = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Human Takeover Output', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'ht-ok', name: 'ok', value: true, type: 'boolean' }, { id: 'ht-branch', name: 'branch', value: 'human_takeover', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [2016, 0] }, output: [{ ok: true, branch: 'human_takeover' }] });
const botNoopOutput = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Bot NoOp Output', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'bot-ok', name: 'ok', value: true, type: 'boolean' }, { id: 'bot-branch', name: 'branch', value: 'bot_noop', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [2016, 192] }, output: [{ ok: true, branch: 'bot_noop' }] });
const inboundNoopOutput = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Inbound NoOp Output', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'in-ok', name: 'ok', value: true, type: 'boolean' }, { id: 'in-branch', name: 'branch', value: 'inbound_noop', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [2016, 384] }, output: [{ ok: true, branch: 'inbound_noop' }] });
const insertUnhandled = node({ type: 'n8n-nodes-base.postgres', version: 2.6, config: { name: 'INSERT unhandled_message_type', parameters: { operation: 'executeQuery', query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('unhandled_message_type', NULL, NULLIF($1::text, '')::int, 'IGOR_06_Chatwoot_Message_Logger', $2::jsonb);", options: { queryReplacement: "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ msg_id: m.msg_id, message_type: m.message_type, sender_type: m.sender_type, reason: 'unhandled_combo', test_run_id: m.test_run_id })]; })() }}" } }, credentials: { postgres: newCredential('igor_supabase_postgres') }, position: [1792, 576] }, output: [{}] });
const unhandledOutput = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Unhandled Output', parameters: { mode: 'manual', assignments: { assignments: [{ id: 'un-ok', name: 'ok', value: true, type: 'boolean' }, { id: 'un-branch', name: 'branch', value: 'unhandled', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [2016, 576] }, output: [{ ok: true, branch: 'unhandled' }] });

export default workflow('xpXRENR7Hoo2W5p3', 'IGOR_06_Chatwoot_Message_Logger')
  .add(chatwootWebhook)
  .to(
    isMessageCreated
      .onTrue(
        normalizeChatwoot
          .to(upsertMessages)
          .to(insertMirrored)
          .to(
            routeByBranch
              .onCase(0, updateConvHumanLocked.to(callIgor04HumanTakeover.to(insertHumanAssumed.to(humanTakeoverOutput.to(mergeBranches.input(1))))))
              .onCase(1, botNoopOutput.to(mergeBranches.input(2)))
              .onCase(2, inboundNoopOutput.to(mergeBranches.input(3)))
              .onCase(3, insertUnhandled.to(unhandledOutput.to(mergeBranches.input(4))))
          )
      )
      .onFalse(insertEventFiltered.to(filteredResponse.to(mergeBranches.input(0))))
  );
