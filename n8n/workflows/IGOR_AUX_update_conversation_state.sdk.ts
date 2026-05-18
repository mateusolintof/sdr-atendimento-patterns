import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

const executeTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'phone', type: 'string' },
          { name: 'chatwoot_conversation_id', type: 'number' },
          { name: 'chatwoot_inbox_id', type: 'number' },
          { name: 'state', type: 'string' },
          { name: 'ai_enabled', type: 'boolean' },
          { name: 'human_locked', type: 'boolean' },
          { name: 'current_flow', type: 'string' },
          { name: 'owner_flow', type: 'string' },
          { name: 'set_journey_started', type: 'boolean' },
          { name: 'increment_turn_count', type: 'boolean' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 0],
  },
  output: [{}],
});

const validatePayloadJs =
  'const items = $input.all();\n' +
  'return items.map(item => {\n' +
  '  const j = item.json || {};\n' +
  '  const phone = (j.phone === undefined || j.phone === null) ? null : String(j.phone);\n' +
  '  const convIdRaw = j.chatwoot_conversation_id;\n' +
  '  const convId = (convIdRaw === undefined || convIdRaw === null || convIdRaw === "") ? null : parseInt(convIdRaw, 10);\n' +
  '  const inboxIdRaw = j.chatwoot_inbox_id;\n' +
  '  const inboxId = (inboxIdRaw === undefined || inboxIdRaw === null || inboxIdRaw === "") ? null : parseInt(inboxIdRaw, 10);\n' +
  '  const state = (j.state === undefined || j.state === null || j.state === "") ? null : String(j.state);\n' +
  '  const aiEnabled = (j.ai_enabled === undefined || j.ai_enabled === null) ? null : Boolean(j.ai_enabled);\n' +
  '  const humanLocked = (j.human_locked === undefined || j.human_locked === null) ? null : Boolean(j.human_locked);\n' +
  '  const currentFlow = (j.current_flow === undefined || j.current_flow === null || j.current_flow === "") ? null : String(j.current_flow);\n' +
  '  const ownerFlow = (j.owner_flow === undefined || j.owner_flow === null || j.owner_flow === "") ? null : String(j.owner_flow);\n' +
  '  const setJourneyStarted = j.set_journey_started === true || j.set_journey_started === "true";\n' +
  '  const incrementTurnCount = j.increment_turn_count === true || j.increment_turn_count === "true";\n' +
  '  const testRunId = (j.test_run_id === undefined || j.test_run_id === null) ? null : String(j.test_run_id);\n' +
  '  return {\n' +
  '    json: {\n' +
  '      phone,\n' +
  '      chatwoot_conversation_id: convId,\n' +
  '      chatwoot_inbox_id: inboxId,\n' +
  '      state,\n' +
  '      ai_enabled: aiEnabled,\n' +
  '      human_locked: humanLocked,\n' +
  '      current_flow: currentFlow,\n' +
  '      owner_flow: ownerFlow,\n' +
  '      test_run_id: testRunId,\n' +
  '      ai_enabled_param: aiEnabled === null ? null : (aiEnabled ? "true" : "false"),\n' +
  '      human_locked_param: humanLocked === null ? null : (humanLocked ? "true" : "false"),\n' +
  '      set_journey_started_param: setJourneyStarted ? "true" : "false",\n' +
  '      increment_turn_count_param: incrementTurnCount ? "true" : "false",\n' +
  '    },\n' +
  '  };\n' +
  '});';

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: validatePayloadJs,
    },
    position: [220, 0],
  },
  output: [{ phone: '', chatwoot_conversation_id: 0 }],
});

const upsertQuery =
  'WITH ct AS (\n' +
  '  INSERT INTO public.contacts (phone, name)\n' +
  '  VALUES ($1, NULL)\n' +
  '  ON CONFLICT (phone) DO UPDATE SET updated_at = now()\n' +
  '  RETURNING id\n' +
  '),\n' +
  'cv_upsert AS (\n' +
  '  INSERT INTO public.conversations (\n' +
  '    contact_id, chatwoot_conversation_id, chatwoot_inbox_id,\n' +
  '    state, ai_enabled, human_locked, current_flow,\n' +
  '    owner_flow, journey_started_at, turn_count\n' +
  '  )\n' +
  '  SELECT\n' +
  '    ct.id,\n' +
  '    $2::integer,\n' +
  '    $3::integer,\n' +
  "    COALESCE($4, 'new'),\n" +
  '    COALESCE($5::boolean, true),\n' +
  '    COALESCE($6::boolean, false),\n' +
  '    $7,\n' +
  '    $8,\n' +
  '    CASE WHEN $9::boolean THEN now() ELSE NULL END,\n' +
  '    CASE WHEN $10::boolean THEN 1 ELSE 0 END\n' +
  '  FROM ct\n' +
  '  ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET\n' +
  '    state = COALESCE($4, public.conversations.state),\n' +
  '    ai_enabled = COALESCE($5::boolean, public.conversations.ai_enabled),\n' +
  '    human_locked = COALESCE($6::boolean, public.conversations.human_locked),\n' +
  '    current_flow = COALESCE($7, public.conversations.current_flow),\n' +
  '    owner_flow = COALESCE($8, public.conversations.owner_flow),\n' +
  '    journey_started_at = CASE\n' +
  '      WHEN $9::boolean THEN COALESCE(public.conversations.journey_started_at, now())\n' +
  '      ELSE public.conversations.journey_started_at\n' +
  '    END,\n' +
  '    turn_count = public.conversations.turn_count + CASE WHEN $10::boolean THEN 1 ELSE 0 END,\n' +
  '    updated_at = now()\n' +
  '  RETURNING id, chatwoot_conversation_id\n' +
  ')\n' +
  'SELECT id, chatwoot_conversation_id FROM cv_upsert;';

const upsertConversation = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert Contact + Conversation + Update State',
    parameters: {
      operation: 'executeQuery',
      query: upsertQuery,
      options: {
        queryReplacement:
          '={{ [$json.phone, $json.chatwoot_conversation_id, $json.chatwoot_inbox_id, $json.state, $json.ai_enabled_param, $json.human_locked_param, $json.current_flow, $json.owner_flow, $json.set_journey_started_param, $json.increment_turn_count_param] }}',
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [440, 0],
  },
  output: [{ id: '', chatwoot_conversation_id: 0 }],
});

const shapeEventJs =
  "const validated = $('Validate Payload').first().json;\n" +
  'const items = $input.all();\n' +
  'return items.map(item => {\n' +
  '  const j = item.json || {};\n' +
  '  const convId = j.chatwoot_conversation_id || validated.chatwoot_conversation_id;\n' +
  '  return {\n' +
  '    json: {\n' +
  '      chatwoot_conversation_id: convId,\n' +
  '      test_run_id: validated.test_run_id,\n' +
  '      event_payload_json: JSON.stringify({\n' +
  '        test_run_id: validated.test_run_id,\n' +
  '        chatwoot_conversation_id: convId,\n' +
  '        state: validated.state,\n' +
  '        ai_enabled: validated.ai_enabled,\n' +
  '        human_locked: validated.human_locked,\n' +
  '        current_flow: validated.current_flow,\n' +
  '        owner_flow: validated.owner_flow,\n' +
  "        set_journey_started: validated.set_journey_started_param === 'true',\n" +
  "        increment_turn_count: validated.increment_turn_count_param === 'true',\n" +
  '      }),\n' +
  '    },\n' +
  '  };\n' +
  '});';

const shapeEventPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape Event Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: shapeEventJs,
    },
    position: [660, 0],
  },
  output: [{ chatwoot_conversation_id: 0, event_payload_json: '{}' }],
});

const logEventQuery =
  'INSERT INTO public.events (event_type, workflow_name, payload, chatwoot_conversation_id)\n' +
  "VALUES ('conversation_state_updated', 'IGOR_AUX_update_conversation_state', $1::jsonb, $2::integer);";

const logEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Event',
    parameters: {
      operation: 'executeQuery',
      query: logEventQuery,
      options: {
        queryReplacement: '={{ [$json.event_payload_json, $json.chatwoot_conversation_id] }}',
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [880, 0],
  },
  output: [{}],
});

const successResponse = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Success Response',
    parameters: {
      assignments: {
        assignments: [
          { id: 'success-flag', name: 'success', value: true, type: 'boolean' },
          {
            id: 'conv-id-out',
            name: 'chatwoot_conversation_id',
            value: "={{ $('Shape Event Payload').first().json.chatwoot_conversation_id }}",
            type: 'number',
          },
          {
            id: 'test-run-id-out',
            name: 'test_run_id',
            value: "={{ $('Shape Event Payload').first().json.test_run_id }}",
            type: 'string',
          },
        ],
      },
      options: {},
    },
    position: [1100, 0],
  },
  output: [{ success: true, chatwoot_conversation_id: 0, test_run_id: '' }],
});

export default workflow('mFuRPrGGt7yWVqEw', 'IGOR_AUX_update_conversation_state')
  .add(executeTrigger)
  .to(validatePayload)
  .to(upsertConversation)
  .to(shapeEventPayload)
  .to(logEvent)
  .to(successResponse);
