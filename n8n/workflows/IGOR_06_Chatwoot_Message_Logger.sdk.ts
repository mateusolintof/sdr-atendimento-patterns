// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_06_Chatwoot_Message_Logger.json`
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "settings.availableInMCP": true
//   - "tags": ["igor", "inbound", "webhook", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the five properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// Do NOT treat this SDK file as the single source of truth without
// re-applying the JSON-only properties above.
// =============================================================================

import {
  workflow,
  node,
  trigger,
  ifElse,
  switchCase,
  merge,
  newCredential,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// IGOR_06_Chatwoot_Message_Logger
// =============================================================================
// Webhook (POST /webhook/igor/chatwoot) recebe payloads do Chatwoot.
//
// Decisões deterministicas:
//   - Filtro: body.event === 'message_created' (outros eventos -> events('event_filtered') + 200 NoOp).
//   - Sempre INSERT/UPSERT em messages (espelhamento).
//   - Sempre INSERT events('message_mirrored').
//   - Switch por (message_type, sender_type):
//       * outgoing + user      -> HUMAN_TAKEOVER (UPDATE conversations + CALL IGOR_04 + events('human_assumed'))
//       * outgoing + agent_bot -> BOT_NOOP (mirror only)
//       * incoming + contact   -> INBOUND_NOOP (mirror only; IGOR_01 lida via Evolution)
//       * default              -> UNHANDLED_LOG (events('unhandled_message_type'))
//
// Sem LLM. Errors -> IGOR_07.
// =============================================================================

const IGOR_04_WORKFLOW_ID = 'AJF7dhGrqJEXMLqz';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Chatwoot Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'igor/chatwoot',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
      options: {
        rawBody: false,
        responseCode: { values: { responseCode: 200 } },
      },
    },
    position: [0, 480],
  },
  output: [
    {
      body: {
        event: 'message_created',
        message_type: 'outgoing',
        id: 99001,
        content: 'Oi, tudo bem?',
        created_at: '2026-05-15T14:00:00Z',
        sender: { id: 7, type: 'user', name: 'Alice' },
        conversation: { id: 9001, contact_inbox: { contact_id: 5001 } },
        account: { id: 1 },
      },
    },
  ],
});

const filterEventCreated = ifElse({
  version: 2.3,
  config: {
    name: 'IF event=message_created',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'evt-cond',
            leftValue: expr('={{ $json.body && $json.body.event }}'),
            rightValue: 'message_created',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
      options: {},
    },
    position: [220, 480],
  },
});

const logEventFiltered = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT event_filtered',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'event_filtered',\n" +
        "  NULL,\n" +
        "  NULLIF($1::text, '')::int,\n" +
        "  'IGOR_06_Chatwoot_Message_Logger',\n" +
        "  $2::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const b = ($('Chatwoot Webhook').first() && $('Chatwoot Webhook').first().json && $('Chatwoot Webhook').first().json.body) || {}; const cid = (b.conversation && b.conversation.id) ? String(b.conversation.id) : ''; return [cid, JSON.stringify({ reason: 'event_not_message_created', event: b.event || null, message_type: b.message_type || null, test_run_id: (b.additional_attributes && b.additional_attributes.test_run_id) || null })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [440, 320],
  },
  output: [{ executionStatus: 'success' }],
});

const filteredResponse = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Filtered Response',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'fr-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'fr-branch', name: 'branch', value: 'event_filtered', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [660, 320],
  },
  output: [{ ok: true, branch: 'event_filtered' }],
});

const normalize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Chatwoot Message',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const items = $input.all();\n" +
        "return items.map(item => {\n" +
        "  const root = item.json || {};\n" +
        "  const b = root.body || root;\n" +
        "  const account = b.account || {};\n" +
        "  const conversation = b.conversation || {};\n" +
        "  const sender = b.sender || {};\n" +
        "  const contactInbox = conversation.contact_inbox || {};\n" +
        "  const additional = b.additional_attributes || {};\n" +
        "  const additionalConv = (conversation.additional_attributes || {});\n" +
        "  const accountId = (account.id !== undefined && account.id !== null) ? String(account.id) : '';\n" +
        "  const conversationId = (conversation.id !== undefined && conversation.id !== null) ? String(conversation.id) : '';\n" +
        "  const contactId = (contactInbox.contact_id !== undefined && contactInbox.contact_id !== null) ? String(contactInbox.contact_id) : ((sender.type === 'contact' && sender.id !== undefined && sender.id !== null) ? String(sender.id) : '');\n" +
        "  const messageId = (b.id !== undefined && b.id !== null) ? String(b.id) : '';\n" +
        "  const messageType = (b.message_type === undefined || b.message_type === null) ? '' : String(b.message_type);\n" +
        "  const senderType = (sender.type === undefined || sender.type === null) ? '' : String(sender.type);\n" +
        "  const senderId = (sender.id !== undefined && sender.id !== null) ? String(sender.id) : '';\n" +
        "  const senderName = (sender.name === undefined || sender.name === null) ? '' : String(sender.name);\n" +
        "  const content = (b.content === undefined || b.content === null) ? '' : String(b.content);\n" +
        "  const contentAttributes = b.content_attributes || {};\n" +
        "  const createdAt = b.created_at || new Date().toISOString();\n" +
        "  const testRunId = additional.test_run_id || additionalConv.test_run_id || null;\n" +
        "  let direction;\n" +
        "  if (messageType === 'incoming') direction = 'inbound';\n" +
        "  else if (messageType === 'outgoing') direction = 'outbound';\n" +
        "  else direction = 'internal';\n" +
        "  let role;\n" +
        "  if (senderType === 'contact') role = 'user';\n" +
        "  else if (senderType === 'user') role = 'agent';\n" +
        "  else if (senderType === 'agent_bot') role = 'assistant';\n" +
        "  else role = 'system';\n" +
        "  const fromMe = (messageType === 'outgoing');\n" +
        "  let branch;\n" +
        "  if (messageType === 'outgoing' && senderType === 'user') branch = 'human_takeover';\n" +
        "  else if (messageType === 'outgoing' && senderType === 'agent_bot') branch = 'bot_noop';\n" +
        "  else if (messageType === 'incoming' && senderType === 'contact') branch = 'inbound_noop';\n" +
        "  else branch = 'unhandled';\n" +
        "  return {\n" +
        "    json: {\n" +
        "      account_id: accountId,\n" +
        "      chatwoot_conversation_id: conversationId,\n" +
        "      chatwoot_contact_id: contactId,\n" +
        "      msg_id: messageId,\n" +
        "      message_type: messageType,\n" +
        "      sender_type: senderType,\n" +
        "      sender_id: senderId,\n" +
        "      sender_name: senderName,\n" +
        "      content: content,\n" +
        "      content_attributes_json: JSON.stringify(contentAttributes),\n" +
        "      created_at: createdAt,\n" +
        "      direction: direction,\n" +
        "      role: role,\n" +
        "      from_me: fromMe,\n" +
        "      _branch: branch,\n" +
        "      test_run_id: testRunId,\n" +
        "    },\n" +
        "  };\n" +
        "});",
    },
    position: [440, 600],
  },
  output: [
    {
      account_id: '1',
      chatwoot_conversation_id: '9001',
      chatwoot_contact_id: '5001',
      msg_id: '99001',
      message_type: 'outgoing',
      sender_type: 'user',
      sender_id: '7',
      sender_name: 'Alice',
      content: 'Oi, tudo bem?',
      content_attributes_json: '{}',
      created_at: '2026-05-15T14:00:00Z',
      direction: 'outbound',
      role: 'agent',
      from_me: true,
      _branch: 'human_takeover',
      test_run_id: 'IGOR_06_FIXTURE_outgoing_human',
    },
  ],
});

const upsertMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT Messages',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.messages (\n" +
        "  conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me, created_at\n" +
        ")\n" +
        "SELECT\n" +
        "  c.id,\n" +
        "  NULLIF($1::text, ''),\n" +
        "  $2::text,\n" +
        "  NULL,\n" +
        "  COALESCE(NULLIF($3::text, ''), 'text'),\n" +
        "  $4::text,\n" +
        "  $5::text,\n" +
        "  $6::boolean,\n" +
        "  COALESCE(NULLIF($7::text, '')::timestamptz, now())\n" +
        "FROM public.conversations c\n" +
        "WHERE c.chatwoot_conversation_id = NULLIF($8::text, '')::int\n" +
        "ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE\n" +
        "SET\n" +
        "  text = EXCLUDED.text,\n" +
        "  direction = EXCLUDED.direction,\n" +
        "  role = EXCLUDED.role,\n" +
        "  from_me = EXCLUDED.from_me;",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.msg_id, m.content, 'text', m.direction, m.role, m.from_me, m.created_at, m.chatwoot_conversation_id]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    continueOnFail: true,
    position: [660, 600],
  },
  output: [{ executionStatus: 'success' }],
});

const logMessageMirrored = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT message_mirrored',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'message_mirrored',\n" +
        "  NULL,\n" +
        "  NULLIF($1::text, '')::int,\n" +
        "  'IGOR_06_Chatwoot_Message_Logger',\n" +
        "  $2::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ msg_id: m.msg_id, message_type: m.message_type, sender_type: m.sender_type, sender_id: m.sender_id, direction: m.direction, role: m.role, from_me: m.from_me, branch: m._branch, content_length: (m.content || '').length, test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [880, 600],
  },
  output: [{ executionStatus: 'success' }],
});

const routeByBranch = switchCase({
  version: 3.4,
  config: {
    name: 'Route By Branch',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'case-human-takeover',
                  leftValue: expr("={{ $('Normalize Chatwoot Message').first().json._branch }}"),
                  rightValue: 'human_takeover',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'human_takeover',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'case-bot-noop',
                  leftValue: expr("={{ $('Normalize Chatwoot Message').first().json._branch }}"),
                  rightValue: 'bot_noop',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'bot_noop',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'case-inbound-noop',
                  leftValue: expr("={{ $('Normalize Chatwoot Message').first().json._branch }}"),
                  rightValue: 'inbound_noop',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'inbound_noop',
          },
        ],
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'unhandled',
        ignoreCase: true,
        allMatchingOutputs: false,
      },
    },
    position: [1100, 600],
  },
});

const updateConversationHumanLocked = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE conversations SET human_locked',
    parameters: {
      operation: 'executeQuery',
      query:
        "UPDATE public.conversations\n" +
        "SET human_locked = true,\n" +
        "    ai_enabled = false,\n" +
        "    state = 'human_assigned',\n" +
        "    last_human_message_at = COALESCE(NULLIF($1::text, '')::timestamptz, now()),\n" +
        "    updated_at = now()\n" +
        "WHERE chatwoot_conversation_id = NULLIF($2::text, '')::int\n" +
        "RETURNING id, chatwoot_conversation_id, human_locked, ai_enabled, state;",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.created_at, m.chatwoot_conversation_id]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1320, 360],
  },
  output: [
    {
      id: 'uuid-conv-row',
      chatwoot_conversation_id: 9001,
      human_locked: true,
      ai_enabled: false,
      state: 'human_assigned',
    },
  ],
});

const callIgor04 = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'CALL IGOR_04 atendimento_humano',
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
            "={{ $('Normalize Chatwoot Message').first().json.chatwoot_conversation_id }}"
          ),
          chatwoot_contact_id: expr(
            "={{ $('Normalize Chatwoot Message').first().json.chatwoot_contact_id }}"
          ),
          labels_to_add: expr("={{ ['atendimento_humano', 'ai_disabled'] }}"),
          labels_to_remove: expr('={{ [] }}'),
          custom_attributes: expr(
            "={{ ({ conversation: { automation_state: 'human_assigned', lead_status: 'humano_em_atendimento', taken_at: $('Normalize Chatwoot Message').first().json.created_at }, contact: {} }) }}"
          ),
          test_run_id: expr(
            "={{ $('Normalize Chatwoot Message').first().json.test_run_id }}"
          ),
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
    position: [1540, 360],
  },
  output: [{ ok: true, branch: 'igor_04_done' }],
});

const logHumanAssumed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT human_assumed',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'human_assumed',\n" +
        "  NULL,\n" +
        "  NULLIF($1::text, '')::int,\n" +
        "  'IGOR_06_Chatwoot_Message_Logger',\n" +
        "  $2::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ chatwoot_conversation_id: m.chatwoot_conversation_id, chatwoot_contact_id: m.chatwoot_contact_id, agent_user_id: m.sender_id, agent_user_name: m.sender_name, msg_id: m.msg_id, taken_at: m.created_at, labels_applied: ['atendimento_humano','ai_disabled'], test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1760, 360],
  },
  output: [{ executionStatus: 'success' }],
});

const humanTakeoverOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Human Takeover Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'ht-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'ht-branch', name: 'branch', value: 'human_takeover', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1980, 360],
  },
  output: [{ ok: true, branch: 'human_takeover' }],
});

const botNoopOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Bot NoOp Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'bot-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'bot-branch', name: 'branch', value: 'bot_noop', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1320, 540],
  },
  output: [{ ok: true, branch: 'bot_noop' }],
});

const inboundNoopOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Inbound NoOp Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'in-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'in-branch', name: 'branch', value: 'inbound_noop', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1320, 720],
  },
  output: [{ ok: true, branch: 'inbound_noop' }],
});

const logUnhandled = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT unhandled_message_type',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\n" +
        "VALUES (\n" +
        "  'unhandled_message_type',\n" +
        "  NULL,\n" +
        "  NULLIF($1::text, '')::int,\n" +
        "  'IGOR_06_Chatwoot_Message_Logger',\n" +
        "  $2::jsonb\n" +
        ");",
      options: {
        queryReplacement: expr(
          "={{ (function(){ const m = $('Normalize Chatwoot Message').first().json; return [m.chatwoot_conversation_id, JSON.stringify({ msg_id: m.msg_id, message_type: m.message_type, sender_type: m.sender_type, reason: 'unhandled_combo', test_run_id: m.test_run_id })]; })() }}"
        ),
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1320, 900],
  },
  output: [{ executionStatus: 'success' }],
});

const unhandledOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Unhandled Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'un-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'un-branch', name: 'branch', value: 'unhandled', type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1540, 900],
  },
  output: [{ ok: true, branch: 'unhandled' }],
});

const mergeBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Branches',
    parameters: { mode: 'append', numberInputs: 5 },
    position: [2200, 600],
  },
});

export default workflow('IGOR_06_Chatwoot_Message_Logger', 'IGOR_06_Chatwoot_Message_Logger')
  .add(webhookTrigger)
  .to(
    filterEventCreated
      .onFalse(logEventFiltered.to(filteredResponse.to(mergeBranches.input(0))))
      .onTrue(normalize.to(upsertMessage.to(logMessageMirrored)))
  )
  .add(logMessageMirrored)
  .to(
    routeByBranch
      .onCase(
        0,
        updateConversationHumanLocked
          .to(callIgor04)
          .to(logHumanAssumed)
          .to(humanTakeoverOutput)
          .to(mergeBranches.input(1))
      )
      .onCase(1, botNoopOutput.to(mergeBranches.input(2)))
      .onCase(2, inboundNoopOutput.to(mergeBranches.input(3)))
      .onCase(3, logUnhandled.to(unhandledOutput.to(mergeBranches.input(4))))
  );
