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
// IGOR_04_Tool_Labels_Attributes
// =============================================================================
// Callable que mescla labels (GET current + add - remove) e PATCH custom_attributes
// em conversation/contact no Chatwoot. Sem LLM. Errors -> IGOR_07.
//
// 3 branches independentes guardadas por IF "Skip ?" flags computadas no Validate
// Payload:
//   - labels_branch       (GET + Merge code + POST labels + INSERT events)
//   - attrs_conv_branch   (POST custom_attributes + INSERT events)
//   - attrs_contact_branch (PUT contact + INSERT events)
// Branches independentes -> append merge final -> summary Set.
// =============================================================================

const executeTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'chatwoot_conversation_id', type: 'string' },
          { name: 'chatwoot_contact_id', type: 'string' },
          { name: 'labels_to_add', type: 'array' },
          { name: 'labels_to_remove', type: 'array' },
          { name: 'custom_attributes', type: 'object' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 0],
  },
  output: [{
    chatwoot_conversation_id: '123',
    chatwoot_contact_id: '456',
    labels_to_add: ['handoff_done'],
    labels_to_remove: [],
    custom_attributes: { conversation: { automation_state: 'human_assigned' }, contact: {} },
    test_run_id: 'IGOR_04_FIXTURE_x',
  }],
});

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const convId = (j.chatwoot_conversation_id === undefined || j.chatwoot_conversation_id === null || j.chatwoot_conversation_id === '') ? null : String(j.chatwoot_conversation_id);\n  const contactId = (j.chatwoot_contact_id === undefined || j.chatwoot_contact_id === null || j.chatwoot_contact_id === '') ? null : String(j.chatwoot_contact_id);\n  let labelsAdd = j.labels_to_add;\n  if (typeof labelsAdd === 'string') { try { labelsAdd = JSON.parse(labelsAdd); } catch (e) { labelsAdd = []; } }\n  if (!Array.isArray(labelsAdd)) labelsAdd = [];\n  labelsAdd = labelsAdd.filter(x => x !== null && x !== undefined && x !== '').map(x => String(x));\n  let labelsRemove = j.labels_to_remove;\n  if (typeof labelsRemove === 'string') { try { labelsRemove = JSON.parse(labelsRemove); } catch (e) { labelsRemove = []; } }\n  if (!Array.isArray(labelsRemove)) labelsRemove = [];\n  labelsRemove = labelsRemove.filter(x => x !== null && x !== undefined && x !== '').map(x => String(x));\n  let attrsRoot = j.custom_attributes;\n  if (typeof attrsRoot === 'string') { try { attrsRoot = JSON.parse(attrsRoot); } catch (e) { attrsRoot = {}; } }\n  if (attrsRoot === null || attrsRoot === undefined || typeof attrsRoot !== 'object' || Array.isArray(attrsRoot)) attrsRoot = {};\n  let attrsConv = attrsRoot.conversation;\n  if (typeof attrsConv === 'string') { try { attrsConv = JSON.parse(attrsConv); } catch (e) { attrsConv = {}; } }\n  if (attrsConv === null || attrsConv === undefined || typeof attrsConv !== 'object' || Array.isArray(attrsConv)) attrsConv = {};\n  let attrsContact = attrsRoot.contact;\n  if (typeof attrsContact === 'string') { try { attrsContact = JSON.parse(attrsContact); } catch (e) { attrsContact = {}; } }\n  if (attrsContact === null || attrsContact === undefined || typeof attrsContact !== 'object' || Array.isArray(attrsContact)) attrsContact = {};\n  const testRunId = (j.test_run_id === undefined || j.test_run_id === null || j.test_run_id === '') ? null : String(j.test_run_id);\n  const attrsConvKeys = Object.keys(attrsConv);\n  const attrsContactKeys = Object.keys(attrsContact);\n  const skipLabels = (labelsAdd.length === 0 && labelsRemove.length === 0);\n  const skipAttrsConversation = (attrsConvKeys.length === 0);\n  const skipAttrsContact = (contactId === null || attrsContactKeys.length === 0);\n  if (convId === null) {\n    throw new Error('IGOR_04: chatwoot_conversation_id is required');\n  }\n  return {\n    json: {\n      chatwoot_conversation_id: convId,\n      chatwoot_contact_id: contactId,\n      labels_to_add: labelsAdd,\n      labels_to_remove: labelsRemove,\n      custom_attributes: { conversation: attrsConv, contact: attrsContact },\n      custom_attributes_conversation_json: JSON.stringify(attrsConv),\n      custom_attributes_contact_json: JSON.stringify(attrsContact),\n      attrs_conversation_keys: attrsConvKeys,\n      attrs_contact_keys: attrsContactKeys,\n      test_run_id: testRunId,\n      _skip_labels: skipLabels,\n      _skip_attrs_conversation: skipAttrsConversation,\n      _skip_attrs_contact: skipAttrsContact\n    }\n  };\n});",
    },
    position: [220, 0],
  },
  output: [{
    chatwoot_conversation_id: '123',
    chatwoot_contact_id: '456',
    labels_to_add: ['handoff_done'],
    labels_to_remove: [],
    custom_attributes: { conversation: { automation_state: 'human_assigned' }, contact: {} },
    custom_attributes_conversation_json: '{"automation_state":"human_assigned"}',
    custom_attributes_contact_json: '{}',
    attrs_conversation_keys: ['automation_state'],
    attrs_contact_keys: [],
    test_run_id: 'IGOR_04_FIXTURE_x',
    _skip_labels: false,
    _skip_attrs_conversation: false,
    _skip_attrs_contact: true,
  }],
});

// -----------------------------------------------------------------------------
// LABELS BRANCH
// -----------------------------------------------------------------------------

const skipLabelsIf = ifElse({
  version: 2.3,
  config: {
    name: 'Skip Labels?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'skip-labels-cond',
            leftValue: expr('{{ $json._skip_labels }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
      },
    },
    position: [440, -300],
  },
});

const getCurrentLabels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GET Current Labels',
    parameters: {
      method: 'GET',
      url: expr('={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $env.CHATWOOT_ACCOUNT_ID }}/conversations/{{ $json.chatwoot_conversation_id }}/labels'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      options: {
        response: {
          response: {
            neverError: false,
            responseFormat: 'json',
          },
        },
        timeout: 15000,
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_chatwoot_api'),
    },
    position: [660, -360],
  },
  output: [{ payload: ['qualificacao_rapida', 'algumlabel'] }],
});

const mergeLabels = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Labels',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const validated = $('Validate Payload').first().json;\nconst items = $input.all();\nreturn items.map(item => {\n  const resp = item.json || {};\n  let current = resp.payload;\n  if (!Array.isArray(current)) current = [];\n  current = current.filter(x => x !== null && x !== undefined && x !== '').map(x => String(x));\n  const add = Array.isArray(validated.labels_to_add) ? validated.labels_to_add : [];\n  const remove = Array.isArray(validated.labels_to_remove) ? validated.labels_to_remove : [];\n  const currentSet = new Set(current);\n  const removeSet = new Set(remove);\n  const addedDeltas = add.filter(l => !currentSet.has(l));\n  const removedDeltas = remove.filter(l => currentSet.has(l));\n  const merged = Array.from(new Set([...current, ...add])).filter(l => !removeSet.has(l));\n  const labelEventsPayload = [\n    ...addedDeltas.map(label => ({\n      event_type: 'label_added',\n      payload: { label, chatwoot_conversation_id: validated.chatwoot_conversation_id, test_run_id: validated.test_run_id }\n    })),\n    ...removedDeltas.map(label => ({\n      event_type: 'label_removed',\n      payload: { label, chatwoot_conversation_id: validated.chatwoot_conversation_id, test_run_id: validated.test_run_id }\n    }))\n  ];\n  return {\n    json: {\n      chatwoot_conversation_id: validated.chatwoot_conversation_id,\n      test_run_id: validated.test_run_id,\n      current_labels: current,\n      merged_labels: merged,\n      added_deltas: addedDeltas,\n      removed_deltas: removedDeltas,\n      label_events_count: labelEventsPayload.length,\n      label_events_json: JSON.stringify(labelEventsPayload),\n      _skip_label_events: labelEventsPayload.length === 0\n    }\n  };\n});",
    },
    position: [880, -360],
  },
  output: [{
    chatwoot_conversation_id: '123',
    test_run_id: 'IGOR_04_FIXTURE_x',
    current_labels: ['qualificacao_rapida'],
    merged_labels: ['handoff_done', 'ai_disabled'],
    added_deltas: ['handoff_done', 'ai_disabled'],
    removed_deltas: ['qualificacao_rapida'],
    label_events_count: 3,
    label_events_json: '[]',
    _skip_label_events: false,
  }],
});

const setMergedLabels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Merged Labels',
    parameters: {
      method: 'POST',
      url: expr('={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $env.CHATWOOT_ACCOUNT_ID }}/conversations/{{ $json.chatwoot_conversation_id }}/labels'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ labels: $json.merged_labels }) }}'),
      options: {
        response: {
          response: {
            neverError: false,
            responseFormat: 'json',
          },
        },
        timeout: 15000,
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_chatwoot_api'),
    },
    position: [1100, -360],
  },
  output: [{ payload: ['handoff_done', 'ai_disabled'] }],
});

const insertLabelEvents = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Label Events',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, workflow_name, payload)\nSELECT\n  (elem->>'event_type'),\n  'IGOR_04_Tool_Labels_Attributes',\n  (elem->'payload')\nFROM jsonb_array_elements($1::jsonb) AS elem\nWHERE jsonb_typeof($1::jsonb) = 'array'\n  AND jsonb_array_length($1::jsonb) > 0;",
      options: {
        queryReplacement: expr("={{ [$('Merge Labels').first().json.label_events_json] }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [1320, -360],
  },
  output: [{ executionStatus: 'success' }],
});

const labelsBranchPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Labels Branch Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'labels-branch-source',
            name: 'branch',
            value: 'labels',
            type: 'string',
          },
          {
            id: 'labels-added-out',
            name: 'labels_added',
            value: expr("={{ $('Merge Labels').first().json.added_deltas }}"),
            type: 'array',
          },
          {
            id: 'labels-removed-out',
            name: 'labels_removed',
            value: expr("={{ $('Merge Labels').first().json.removed_deltas }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [1540, -360],
  },
  output: [{ branch: 'labels', labels_added: ['handoff_done'], labels_removed: [] }],
});

const labelsBranchSkipPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Labels Branch Skipped',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'labels-branch-source-skip',
            name: 'branch',
            value: 'labels_skipped',
            type: 'string',
          },
          {
            id: 'labels-added-out-skip',
            name: 'labels_added',
            value: expr("={{ [] }}"),
            type: 'array',
          },
          {
            id: 'labels-removed-out-skip',
            name: 'labels_removed',
            value: expr("={{ [] }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [660, -240],
  },
  output: [{ branch: 'labels_skipped', labels_added: [], labels_removed: [] }],
});

// -----------------------------------------------------------------------------
// ATTRS CONVERSATION BRANCH
// -----------------------------------------------------------------------------

const skipAttrsConversationIf = ifElse({
  version: 2.3,
  config: {
    name: 'Skip Attrs Conversation?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'skip-attrs-conv-cond',
            leftValue: expr('{{ $json._skip_attrs_conversation }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
      },
    },
    position: [440, 0],
  },
});

const patchConversationAttrs = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Conversation Attrs',
    parameters: {
      method: 'POST',
      url: expr('={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $env.CHATWOOT_ACCOUNT_ID }}/conversations/{{ $json.chatwoot_conversation_id }}/custom_attributes'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ custom_attributes: $json.custom_attributes.conversation }) }}'),
      options: {
        response: {
          response: {
            neverError: false,
            responseFormat: 'json',
          },
        },
        timeout: 15000,
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_chatwoot_api'),
    },
    position: [660, 60],
  },
  output: [{ id: 1, custom_attributes: { automation_state: 'human_assigned' } }],
});

const insertConversationAttrEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Conversation Attr Event',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, workflow_name, payload)\nVALUES ('attribute_set', 'IGOR_04_Tool_Labels_Attributes', $1::jsonb);",
      options: {
        queryReplacement: expr("={{ [JSON.stringify({ scope: 'conversation', keys: $('Validate Payload').first().json.attrs_conversation_keys, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, test_run_id: $('Validate Payload').first().json.test_run_id })] }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [880, 60],
  },
  output: [{ executionStatus: 'success' }],
});

const attrsConvBranchPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Attrs Conversation Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'attrs-conv-branch-source',
            name: 'branch',
            value: 'attrs_conversation',
            type: 'string',
          },
          {
            id: 'attrs-conv-keys-out',
            name: 'attrs_conversation_keys',
            value: expr("={{ $('Validate Payload').first().json.attrs_conversation_keys }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [1100, 60],
  },
  output: [{ branch: 'attrs_conversation', attrs_conversation_keys: ['automation_state'] }],
});

const attrsConvBranchSkipPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Attrs Conversation Skipped',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'attrs-conv-branch-source-skip',
            name: 'branch',
            value: 'attrs_conversation_skipped',
            type: 'string',
          },
          {
            id: 'attrs-conv-keys-out-skip',
            name: 'attrs_conversation_keys',
            value: expr("={{ [] }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [660, 180],
  },
  output: [{ branch: 'attrs_conversation_skipped', attrs_conversation_keys: [] }],
});

// -----------------------------------------------------------------------------
// ATTRS CONTACT BRANCH
// -----------------------------------------------------------------------------

const skipAttrsContactIf = ifElse({
  version: 2.3,
  config: {
    name: 'Skip Attrs Contact?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'skip-attrs-contact-cond',
            leftValue: expr('{{ $json._skip_attrs_contact }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
      },
    },
    position: [440, 360],
  },
});

const patchContactAttrs = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'PUT Contact Attrs',
    parameters: {
      method: 'PUT',
      url: expr('={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $env.CHATWOOT_ACCOUNT_ID }}/contacts/{{ $json.chatwoot_contact_id }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({ custom_attributes: $json.custom_attributes.contact }) }}'),
      options: {
        response: {
          response: {
            neverError: false,
            responseFormat: 'json',
          },
        },
        timeout: 15000,
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_chatwoot_api'),
    },
    position: [660, 480],
  },
  output: [{ id: 456, custom_attributes: { city: 'São Paulo', objetivo_principal: 'emagrecimento' } }],
});

const insertContactAttrEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Contact Attr Event',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, workflow_name, payload)\nVALUES ('attribute_set', 'IGOR_04_Tool_Labels_Attributes', $1::jsonb);",
      options: {
        queryReplacement: expr("={{ [JSON.stringify({ scope: 'contact', keys: $('Validate Payload').first().json.attrs_contact_keys, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, test_run_id: $('Validate Payload').first().json.test_run_id })] }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [880, 480],
  },
  output: [{ executionStatus: 'success' }],
});

const attrsContactBranchPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Attrs Contact Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'attrs-contact-branch-source',
            name: 'branch',
            value: 'attrs_contact',
            type: 'string',
          },
          {
            id: 'attrs-contact-keys-out',
            name: 'attrs_contact_keys',
            value: expr("={{ $('Validate Payload').first().json.attrs_contact_keys }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [1100, 480],
  },
  output: [{ branch: 'attrs_contact', attrs_contact_keys: ['city', 'objetivo_principal'] }],
});

const attrsContactBranchSkipPass = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Attrs Contact Skipped',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'attrs-contact-branch-source-skip',
            name: 'branch',
            value: 'attrs_contact_skipped',
            type: 'string',
          },
          {
            id: 'attrs-contact-keys-out-skip',
            name: 'attrs_contact_keys',
            value: expr("={{ [] }}"),
            type: 'array',
          },
        ],
      },
      options: {},
    },
    position: [660, 600],
  },
  output: [{ branch: 'attrs_contact_skipped', attrs_contact_keys: [] }],
});

// -----------------------------------------------------------------------------
// MERGE BRANCHES + SUMMARY
// -----------------------------------------------------------------------------

const mergeBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Branches',
    parameters: {
      mode: 'append',
      numberInputs: 3,
    },
    position: [1760, 60],
  },
});

const finalSummary = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Final Summary',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'ok-flag', name: 'ok', value: true, type: 'boolean' },
          {
            id: 'sum-labels-added',
            name: 'labels_added',
            value: expr("={{ $input.all().reduce((acc, x) => acc.concat(Array.isArray(x.json.labels_added) ? x.json.labels_added : []), []) }}"),
            type: 'array',
          },
          {
            id: 'sum-labels-removed',
            name: 'labels_removed',
            value: expr("={{ $input.all().reduce((acc, x) => acc.concat(Array.isArray(x.json.labels_removed) ? x.json.labels_removed : []), []) }}"),
            type: 'array',
          },
          {
            id: 'sum-attrs-conv-keys',
            name: 'attrs_conversation_keys',
            value: expr("={{ $input.all().reduce((acc, x) => acc.concat(Array.isArray(x.json.attrs_conversation_keys) ? x.json.attrs_conversation_keys : []), []) }}"),
            type: 'array',
          },
          {
            id: 'sum-attrs-contact-keys',
            name: 'attrs_contact_keys',
            value: expr("={{ $input.all().reduce((acc, x) => acc.concat(Array.isArray(x.json.attrs_contact_keys) ? x.json.attrs_contact_keys : []), []) }}"),
            type: 'array',
          },
          {
            id: 'test-run-id-out',
            name: 'test_run_id',
            value: expr("={{ $('Validate Payload').first().json.test_run_id }}"),
            type: 'string',
          },
        ],
      },
      options: {},
      includeOtherFields: false,
    },
    executeOnce: true,
    position: [1980, 60],
  },
  output: [{
    ok: true,
    labels_added: ['handoff_done'],
    labels_removed: [],
    attrs_conversation_keys: ['automation_state'],
    attrs_contact_keys: [],
    test_run_id: 'IGOR_04_FIXTURE_x',
  }],
});

// =============================================================================
// WIRE WORKFLOW
// =============================================================================

export default workflow('IGOR_04_Tool_Labels_Attributes', 'IGOR_04_Tool_Labels_Attributes')
  .add(executeTrigger)
  .to(validatePayload)
  .to(
    skipLabelsIf
      .onFalse(
        getCurrentLabels
          .to(mergeLabels)
          .to(setMergedLabels)
          .to(insertLabelEvents)
          .to(labelsBranchPass)
          .to(mergeBranches.input(0))
      )
      .onTrue(
        labelsBranchSkipPass.to(mergeBranches.input(0))
      )
  )
  .add(validatePayload)
  .to(
    skipAttrsConversationIf
      .onFalse(
        patchConversationAttrs
          .to(insertConversationAttrEvent)
          .to(attrsConvBranchPass)
          .to(mergeBranches.input(1))
      )
      .onTrue(
        attrsConvBranchSkipPass.to(mergeBranches.input(1))
      )
  )
  .add(validatePayload)
  .to(
    skipAttrsContactIf
      .onFalse(
        patchContactAttrs
          .to(insertContactAttrEvent)
          .to(attrsContactBranchPass)
          .to(mergeBranches.input(2))
      )
      .onTrue(
        attrsContactBranchSkipPass.to(mergeBranches.input(2))
      )
  )
  .add(mergeBranches)
  .to(finalSummary);
