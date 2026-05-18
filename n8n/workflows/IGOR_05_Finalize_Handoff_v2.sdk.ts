import { workflow, node, trigger, ifElse, merge, newCredential } from '@n8n/workflow-sdk';

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
          { name: 'lead_id', type: 'string' },
          { name: 'outcome', type: 'string' },
          { name: 'lead_name', type: 'string' },
          { name: 'handoff_reason', type: 'string' },
          { name: 'summary', type: 'string' },
          { name: 'callback_period', type: 'string' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 96],
  },
  output: [{}],
});

const loadGatesQuery =
  'SELECT\n' +
  "  COALESCE((SELECT (value)::text::boolean FROM public.settings WHERE key='dry_run_send'), true) AS dry_run_send,\n" +
  "  COALESCE((SELECT (value)::text::boolean FROM public.settings WHERE key='allow_real_whatsapp_send'), false) AS allow_real_whatsapp_send,\n" +
  "  (SELECT NULLIF(value::text, 'null')::int FROM public.settings WHERE key='chatwoot_human_assignee_id') AS chatwoot_human_assignee_id,\n" +
  "  COALESCE((SELECT NULLIF(value::text, 'null')::int FROM public.settings WHERE key='ai_team_id'), 1) AS ai_team_id,\n" +
  "  COALESCE((SELECT NULLIF(value::text, 'null')::int FROM public.settings WHERE key='human_daytime_team_id'), 1) AS human_daytime_team_id,\n" +
  "  COALESCE((SELECT NULLIF(value::text, 'null')::int FROM public.settings WHERE key='handoff_queue_team_id'), 1) AS handoff_queue_team_id;";

const loadGates = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Gates',
    parameters: {
      operation: 'executeQuery',
      query: loadGatesQuery,
      options: {},
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [200, 96],
    onError: 'continueRegularOutput',
  },
  output: [
    {
      dry_run_send: true,
      allow_real_whatsapp_send: false,
      chatwoot_human_assignee_id: null,
      ai_team_id: 1,
      human_daytime_team_id: 1,
      handoff_queue_team_id: 1,
    },
  ],
});

const validatePayloadJs =
  "const items = $('Execute Workflow Trigger').all();\n" +
  "const gates = $('Load Gates').first().json;\n" +
  'return items.map(item => {\n' +
  '  const j = item.json || {};\n' +
  "  const str = (v) => (v === undefined || v === null || v === '') ? null : String(v);\n" +
  '  const convId = str(j.chatwoot_conversation_id);\n' +
  "  if (convId === null) throw new Error('IGOR_05: chatwoot_conversation_id is required');\n" +
  '  const contactId = str(j.chatwoot_contact_id);\n' +
  '  const leadId = str(j.lead_id);\n' +
  '  const outcomeRaw = (str(j.outcome) || "qualified").toLowerCase();\n' +
  '  const allowedOutcomes = { qualified: 1, unqualified: 1, compliance: 1 };\n' +
  '  const outcome = allowedOutcomes[outcomeRaw] ? outcomeRaw : "qualified";\n' +
  '  const leadName = str(j.lead_name);\n' +
  '  const handoffReason = str(j.handoff_reason) || (outcome === "compliance" ? "compliance_hold" : (outcome === "unqualified" ? "lead_disengaged" : "after_hours_callback"));\n' +
  '  const summary = str(j.summary) || "(sem resumo)";\n' +
  '  const callbackPeriod = str(j.callback_period);\n' +
  '  const testRunId = str(j.test_run_id);\n' +
  '  const handoffAt = new Date().toISOString();\n' +
  '  const allowReal = gates.allow_real_whatsapp_send === true;\n' +
  '  const dryRun = gates.dry_run_send === true;\n' +
  '  const shouldSendReal = allowReal && !dryRun;\n' +
  '  const sendGateReason = shouldSendReal ? "real_send_authorized" : (allowReal ? "igor_dry_run=true" : "allow_real_whatsapp_send=false");\n' +
  '  let ownerFlow, targetTeamId, labelsAdd, labelsRemove, finalMessage, conversationState;\n' +
  '  const namePart = leadName ? (", " + leadName) : "";\n' +
  '  const periodPart = callbackPeriod ? (" " + callbackPeriod.replace(/^(no|na|de|em)\\s+/i, "")) : " no próximo expediente";\n' +
  '  if (outcome === "qualified") {\n' +
  '    ownerFlow = "handoff_queue";\n' +
  '    targetTeamId = gates.handoff_queue_team_id;\n' +
  '    labelsAdd = ["handoff_done", "lead_qualificado", "aguardando_atendente", "callback_horario_coletado"];\n' +
  '    labelsRemove = ["qualificacao_rapida", "callback_solicitado", "ai_after_hours"];\n' +
  '    finalMessage = "Combinado" + namePart + ". A equipe vai entrar em contato" + periodPart + ".";\n' +
  '    conversationState = "handoff_qualified";\n' +
  '  } else if (outcome === "unqualified") {\n' +
  '    ownerFlow = "ai_unqualified";\n' +
  '    targetTeamId = gates.handoff_queue_team_id;\n' +
  '    labelsAdd = ["nao_qualificado_ia", "ai_disabled", "handoff_done"];\n' +
  '    labelsRemove = ["qualificacao_rapida", "callback_solicitado", "ai_after_hours"];\n' +
  '    finalMessage = "Tudo bem" + namePart + ". Quando quiser retomar é só me chamar por aqui.";\n' +
  '    conversationState = "handoff_unqualified";\n' +
  '  } else {\n' +
  '    ownerFlow = "compliance_hold";\n' +
  '    targetTeamId = gates.human_daytime_team_id;\n' +
  '    labelsAdd = ["compliance_humano", "ai_disabled", "handoff_done"];\n' +
  '    labelsRemove = ["ai_after_hours"];\n' +
  '    finalMessage = "Pra esse tipo de conteúdo, preciso passar pro nosso time olhar com cuidado. A equipe entra em contato no próximo expediente.";\n' +
  '    conversationState = "compliance_hold";\n' +
  '  }\n' +
  '  const convAttrs = { automation_state: conversationState, lead_status: "aguardando_atendente", handoff_reason: handoffReason, handoff_at: handoffAt, owner_flow: ownerFlow, handoff_outcome: outcome, ai_enabled: false };\n' +
  '  if (callbackPeriod !== null) convAttrs.callback_period = callbackPeriod;\n' +
  '  const summarySnippet = summary.length > 400 ? summary.slice(0, 400) + "…" : summary;\n' +
  '  const callbackLine = callbackPeriod ? ("Período preferido de retorno: " + callbackPeriod + "\\n") : "";\n' +
  '  const namedLine = leadName ? ("Nome: " + leadName + "\\n") : "";\n' +
  '  const privateNoteContent = "📋 *Resumo automático Igor (handoff " + outcome + ")*\\n\\nMotivo: " + handoffReason + "\\n" + namedLine + callbackLine + "\\nResumo da conversa:\\n" + summary + "\\n\\nLead status: aguardando_atendente\\nIA: desligada nesta conversa (ai_enabled=false, human_locked=true, owner_flow=" + ownerFlow + ")";\n' +
  '  return { json: { chatwoot_conversation_id: convId, chatwoot_contact_id: contactId, lead_id: leadId, outcome, lead_name: leadName, handoff_reason: handoffReason, summary, summary_snippet: summarySnippet, callback_period: callbackPeriod, owner_flow: ownerFlow, target_team_id: targetTeamId, conversation_state: conversationState, test_run_id: testRunId, handoff_at: handoffAt, _has_lead: leadId !== null, _should_send_real: shouldSendReal, _send_gate_reason: sendGateReason, _allow_real_whatsapp_send: allowReal, _igor_dry_run: dryRun, _chatwoot_human_assignee_id: gates.chatwoot_human_assignee_id, private_note_content: privateNoteContent, final_lead_message: finalMessage, igor04_payload_json: JSON.stringify({ chatwoot_conversation_id: convId, chatwoot_contact_id: contactId, labels_to_add: labelsAdd, labels_to_remove: labelsRemove, custom_attributes: { conversation: convAttrs, contact: {} }, test_run_id: testRunId }) } };\n' +
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
    position: [400, 96],
  },
  output: [
    {
      chatwoot_conversation_id: '',
      outcome: 'qualified',
      target_team_id: 1,
      owner_flow: 'handoff_queue',
      _has_lead: false,
      _should_send_real: false,
      _chatwoot_human_assignee_id: null,
      final_lead_message: '',
      private_note_content: '',
      igor04_payload_json: '{}',
    },
  ],
});

const updateConversationQuery =
  'UPDATE public.conversations\n' +
  '  SET state = $1,\n' +
  '      ai_enabled = false,\n' +
  '      human_locked = true,\n' +
  "      owner_flow = $2,\n" +
  '      assigned_team_id = NULLIF($3, \'\')::int,\n' +
  '      updated_at = now()\n' +
  '  WHERE chatwoot_conversation_id = $4::int\n' +
  '  RETURNING id, contact_id, chatwoot_conversation_id, owner_flow, state;';

const updateConversation = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE conversations',
    parameters: {
      operation: 'executeQuery',
      query: updateConversationQuery,
      options: {
        queryReplacement:
          "={{ [ $('Validate Payload').first().json.conversation_state, $('Validate Payload').first().json.owner_flow, String($('Validate Payload').first().json.target_team_id || ''), $('Validate Payload').first().json.chatwoot_conversation_id ] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [600, 96],
  },
  output: [{ id: '', chatwoot_conversation_id: 0, owner_flow: 'handoff_queue', state: '' }],
});

const hasLeadIf = ifElse({
  version: 2.3,
  config: {
    name: 'Has lead_id?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'has-lead-cond',
            leftValue: "={{ $('Validate Payload').first().json._has_lead }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [800, 96],
  },
});

const updateLeadsQuery =
  'UPDATE public.leads\n' +
  '  SET status = $1,\n' +
  '      handoff_at = now(),\n' +
  '      updated_at = now()\n' +
  '  WHERE id = $2::uuid\n' +
  '  RETURNING id, contact_id, conversation_id, status, handoff_at;';

const updateLeads = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE leads',
    parameters: {
      operation: 'executeQuery',
      query: updateLeadsQuery,
      options: {
        queryReplacement:
          "={{ [ ($('Validate Payload').first().json.outcome === 'compliance' ? 'compliance_hold' : ($('Validate Payload').first().json.outcome === 'unqualified' ? 'nao_qualificado' : 'aguardando_atendente')), $('Validate Payload').first().json.lead_id ] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1000, 0],
  },
  output: [{ id: '', status: '' }],
});

const noLeadPassthrough = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Lead Passthrough',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [{ id: 'no-lead-flag', name: 'lead_updated', value: false, type: 'boolean' }],
      },
      options: {},
    },
    position: [1000, 192],
  },
  output: [{ lead_updated: false }],
});

const mergeLeadBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Lead Branches',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [1200, 96],
  },
});

const callIgor04 = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_04',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: 'AJF7dhGrqJEXMLqz',
        cachedResultName: 'IGOR_04_Tool_Labels_Attributes',
      },
      mode: 'once',
      workflowInputs: "={{ $('Validate Payload').first().json.igor04_payload_json }}",
      options: { waitForSubWorkflow: true },
    },
    position: [1400, 96],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const postPrivateNote = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Private Note',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/messages",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ content: $('Validate Payload').first().json.private_note_content, private: true, message_type: 'outgoing', content_type: 'text' }) }}",
      options: {
        response: { response: { neverError: false, responseFormat: 'json' } },
        timeout: 15000,
      },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [1600, 96],
    executeOnce: true,
  },
  output: [{ id: 0 }],
});

const postAssignTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Team',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ team_id: Number($('Validate Payload').first().json.target_team_id) }) }}",
      options: {
        response: { response: { neverError: false, responseFormat: 'json' } },
        timeout: 15000,
      },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [1800, 96],
    executeOnce: true,
  },
  output: [{ team_id: 1 }],
});

const hasAssigneeIf = ifElse({
  version: 2.3,
  config: {
    name: 'Has Assignee?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'has-assignee-cond',
            leftValue: "={{ $('Validate Payload').first().json._chatwoot_human_assignee_id }}",
            rightValue: 0,
            operator: { type: 'number', operation: 'gt', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      },
    },
    position: [2000, 96],
  },
});

const postAssignAssignee = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Assignee',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ assignee_id: Number($('Validate Payload').first().json._chatwoot_human_assignee_id) }) }}",
      options: {
        response: { response: { neverError: false, responseFormat: 'json' } },
        timeout: 15000,
      },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [2200, 0],
    executeOnce: true,
  },
  output: [{ assignee_id: 0 }],
});

const noAssigneePassthrough = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Assignee Passthrough',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [{ id: 'no-assignee-flag', name: 'assignee_set', value: false, type: 'boolean' }],
      },
      options: {},
    },
    position: [2200, 192],
    executeOnce: true,
  },
  output: [{ assignee_set: false }],
});

const mergeAssigneeBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Assignee Branches',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [2400, 96],
  },
});

const logHandoffComplete = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log handoff_complete',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, chatwoot_conversation_id, workflow_name, payload) VALUES ('handoff_complete', $1::int, 'IGOR_05_Finalize_Handoff_v2', $2::jsonb);",
      options: {
        queryReplacement:
          "={{ [$('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ outcome: $('Validate Payload').first().json.outcome, owner_flow: $('Validate Payload').first().json.owner_flow, target_team_id: $('Validate Payload').first().json.target_team_id, handoff_reason: $('Validate Payload').first().json.handoff_reason, lead_id: $('Validate Payload').first().json.lead_id, callback_period: $('Validate Payload').first().json.callback_period, summary_snippet: $('Validate Payload').first().json.summary_snippet, handoff_at: $('Validate Payload').first().json.handoff_at, test_run_id: $('Validate Payload').first().json.test_run_id })] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2600, 96],
    executeOnce: true,
  },
  output: [{}],
});

const getLeadPhone = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Get Lead Phone',
    parameters: {
      operation: 'executeQuery',
      query:
        'SELECT c.phone AS phone, conv.id AS conversation_pk FROM public.conversations conv JOIN public.contacts c ON c.id = conv.contact_id WHERE conv.chatwoot_conversation_id = $1::int LIMIT 1;',
      options: {
        queryReplacement:
          "={{ [$('Validate Payload').first().json.chatwoot_conversation_id] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2800, 96],
    executeOnce: true,
  },
  output: [{ phone: '', conversation_pk: '' }],
});

const shouldSendRealIf = ifElse({
  version: 2.3,
  config: {
    name: 'Should Send Real?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'should-send-real-cond',
            leftValue: "={{ $('Validate Payload').first().json._should_send_real }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [3000, 96],
  },
});

const evolutionSendText = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Evolution sendText',
    parameters: {
      method: 'POST',
      url: '=https://evo.almaconvert.com.br/message/sendText/convert-teste',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ number: $json.phone, text: $('Validate Payload').first().json.final_lead_message }) }}",
      options: {
        response: { response: { neverError: false, responseFormat: 'json' } },
        timeout: 20000,
      },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [3200, 0],
    executeOnce: true,
  },
  output: [{ key: { id: '' } }],
});

const logWhatsappSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log whatsapp_sent',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('whatsapp_sent', $1, $2::int, 'IGOR_05_Finalize_Handoff_v2', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ [$('Get Lead Phone').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ text: $('Validate Payload').first().json.final_lead_message, outcome: $('Validate Payload').first().json.outcome, owner_flow: $('Validate Payload').first().json.owner_flow, allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send, dry_run: $('Validate Payload').first().json._igor_dry_run, test_run_id: $('Validate Payload').first().json.test_run_id })] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3400, 0],
    executeOnce: true,
  },
  output: [{}],
});

const realSendOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Real Send Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'send-mode-real', name: 'send_mode', value: 'real', type: 'string' },
          { id: 'message-sent-real', name: 'message_sent', value: 'real', type: 'string' },
        ],
      },
      options: {},
    },
    position: [3600, 0],
    executeOnce: true,
  },
  output: [{ send_mode: 'real', message_sent: 'real' }],
});

const logDryRunSend = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log dry_run_send',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('dry_run_send', $1, $2::int, 'IGOR_05_Finalize_Handoff_v2', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ [$('Get Lead Phone').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ text: $('Validate Payload').first().json.final_lead_message, reason: $('Validate Payload').first().json._send_gate_reason, outcome: $('Validate Payload').first().json.outcome, owner_flow: $('Validate Payload').first().json.owner_flow, allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send, dry_run: $('Validate Payload').first().json._igor_dry_run, test_run_id: $('Validate Payload').first().json.test_run_id })] }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3400, 192],
    executeOnce: true,
  },
  output: [{}],
});

const drySendOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Dry Send Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'send-mode-dry', name: 'send_mode', value: 'dry_run', type: 'string' },
          { id: 'message-sent-dry', name: 'message_sent', value: 'dry', type: 'string' },
        ],
      },
      options: {},
    },
    position: [3600, 192],
    executeOnce: true,
  },
  output: [{ send_mode: 'dry_run', message_sent: 'dry' }],
});

const mergeSendBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Send Branches',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [3800, 96],
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
            id: 'outcome-out',
            name: 'outcome',
            value: "={{ $('Validate Payload').first().json.outcome }}",
            type: 'string',
          },
          {
            id: 'owner-flow-out',
            name: 'owner_flow',
            value: "={{ $('Validate Payload').first().json.owner_flow }}",
            type: 'string',
          },
          {
            id: 'target-team-id-out',
            name: 'target_team_id',
            value: "={{ $('Validate Payload').first().json.target_team_id }}",
            type: 'number',
          },
          {
            id: 'lead-updated',
            name: 'lead_updated',
            value: "={{ $('Validate Payload').first().json._has_lead }}",
            type: 'boolean',
          },
          { id: 'labels-applied', name: 'labels_applied', value: true, type: 'boolean' },
          {
            id: 'message-sent',
            name: 'message_sent',
            value:
              "={{ $input.all().reduce((acc, x) => x.json && x.json.message_sent ? x.json.message_sent : acc, 'unknown') }}",
            type: 'string',
          },
          {
            id: 'send-mode',
            name: 'send_mode',
            value:
              "={{ $input.all().reduce((acc, x) => x.json && x.json.send_mode ? x.json.send_mode : acc, 'unknown') }}",
            type: 'string',
          },
          {
            id: 'handoff-reason-out',
            name: 'handoff_reason',
            value: "={{ $('Validate Payload').first().json.handoff_reason }}",
            type: 'string',
          },
          {
            id: 'test-run-id-out',
            name: 'test_run_id',
            value: "={{ $('Validate Payload').first().json.test_run_id }}",
            type: 'string',
          },
        ],
      },
      options: {},
      includeOtherFields: false,
    },
    position: [4000, 96],
    executeOnce: true,
  },
  output: [{ ok: true, outcome: 'qualified', owner_flow: 'handoff_queue' }],
});

export default workflow('igor-05-v2', 'IGOR_05_Finalize_Handoff_v2')
  .add(executeTrigger)
  .to(loadGates)
  .to(validatePayload)
  .to(updateConversation)
  .to(
    hasLeadIf
      .onTrue(updateLeads.to(mergeLeadBranches.input(0)))
      .onFalse(noLeadPassthrough.to(mergeLeadBranches.input(1)))
  )
  .add(mergeLeadBranches)
  .to(callIgor04)
  .to(postPrivateNote)
  .to(postAssignTeam)
  .to(
    hasAssigneeIf
      .onTrue(postAssignAssignee.to(mergeAssigneeBranches.input(0)))
      .onFalse(noAssigneePassthrough.to(mergeAssigneeBranches.input(1)))
  )
  .add(mergeAssigneeBranches)
  .to(logHandoffComplete)
  .to(getLeadPhone)
  .to(
    shouldSendRealIf
      .onTrue(evolutionSendText.to(logWhatsappSent.to(realSendOutput.to(mergeSendBranches.input(0)))))
      .onFalse(logDryRunSend.to(drySendOutput.to(mergeSendBranches.input(1))))
  )
  .add(mergeSendBranches)
  .to(finalSummary);
