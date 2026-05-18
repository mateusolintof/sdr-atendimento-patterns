import {
  workflow,
  node,
  trigger,
  ifElse,
  splitInBatches,
  nextBatch,
  languageModel,
  memory,
  tool,
  newCredential,
} from '@n8n/workflow-sdk';

const IGOR_05_V2_ID = 'mfB7MGpCYSPQvRSx';
const IGOR_04_ID = 'AJF7dhGrqJEXMLqz';
const IGOR_AUX_SAVE_LEAD_ID = 'hRogDlGsgQxGwnD8';
const IGOR_AUX_UPDATE_CONV_ID = 'mFuRPrGGt7yWVqEw';

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
          { name: 'msgId', type: 'string' },
          { name: 'chatwoot_conversation_id', type: 'string' },
          { name: 'chatwoot_contact_id', type: 'string' },
          { name: 'normalized_text', type: 'string' },
          { name: 'safety_flags', type: 'object' },
          { name: 'should_handoff', type: 'boolean' },
          { name: 'handoff_reason', type: 'string' },
          { name: 'fragments_count', type: 'number' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 144],
  },
  output: [{}],
});

const loadGates = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Gates',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT COALESCE((SELECT (value)::text::boolean FROM public.settings WHERE key='dry_run_send'), true) AS dry_run_send, COALESCE((SELECT (value)::text::boolean FROM public.settings WHERE key='allow_real_whatsapp_send'), false) AS allow_real_whatsapp_send;",
      options: {},
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [112, 144],
    onError: 'continueRegularOutput',
  },
  output: [{ dry_run_send: true, allow_real_whatsapp_send: false }],
});

const validatePayloadJs =
  "const items = $('Execute Workflow Trigger').all();\n" +
  'return items.map(item => {\n' +
  '  const j = item.json || {};\n' +
  '  const phone = (j.phone === undefined || j.phone === null) ? "" : String(j.phone).trim();\n' +
  '  const msgId = (j.msgId === undefined || j.msgId === null) ? "" : String(j.msgId).trim();\n' +
  '  const convId = (j.chatwoot_conversation_id === undefined || j.chatwoot_conversation_id === null) ? "" : String(j.chatwoot_conversation_id).trim();\n' +
  '  const contactId = (j.chatwoot_contact_id === undefined || j.chatwoot_contact_id === null) ? "" : String(j.chatwoot_contact_id).trim();\n' +
  '  const normalizedText = (j.normalized_text === undefined || j.normalized_text === null) ? "" : String(j.normalized_text);\n' +
  '  let safetyFlags = j.safety_flags;\n' +
  '  if (typeof safetyFlags === "string") { try { safetyFlags = JSON.parse(safetyFlags); } catch (e) { safetyFlags = {}; } }\n' +
  '  if (!safetyFlags || typeof safetyFlags !== "object" || Array.isArray(safetyFlags)) safetyFlags = {};\n' +
  '  const clinical = safetyFlags.clinical === true;\n' +
  '  const sensitiveImage = safetyFlags.sensitive_image === true;\n' +
  '  const paymentProof = safetyFlags.payment_proof === true;\n' +
  '  const shouldHandoff = j.should_handoff === true || j.should_handoff === "true";\n' +
  '  const handoffReason = (j.handoff_reason === undefined || j.handoff_reason === null) ? "" : String(j.handoff_reason);\n' +
  '  const fragmentsCount = (typeof j.fragments_count === "number") ? j.fragments_count : (parseInt(j.fragments_count, 10) || 1);\n' +
  '  const testRunId = (j.test_run_id === undefined || j.test_run_id === null) ? "" : String(j.test_run_id);\n' +
  '  const isCompliance = shouldHandoff || clinical || sensitiveImage || paymentProof;\n' +
  '  let resolvedHandoffReason = handoffReason;\n' +
  '  if (!resolvedHandoffReason) {\n' +
  '    if (clinical) resolvedHandoffReason = "documento_clinico_sensivel";\n' +
  '    else if (sensitiveImage) resolvedHandoffReason = "imagem_sensivel";\n' +
  '    else if (paymentProof) resolvedHandoffReason = "comprovante_pagamento";\n' +
  '    else if (shouldHandoff) resolvedHandoffReason = "safety_flag_generic";\n' +
  '  }\n' +
  "  const gates = $('Load Gates').first().json;\n" +
  '  const allowReal = gates.allow_real_whatsapp_send === true;\n' +
  '  const dryRun = gates.dry_run_send === true;\n' +
  '  const shouldSendReal = allowReal && !dryRun;\n' +
  '  const sendGateReason = shouldSendReal ? "real_send_authorized" : (allowReal ? "igor_dry_run=true" : "allow_real_whatsapp_send=false");\n' +
  '  const sessionKey = "after_hours_" + phone;\n' +
  '  const igor05CompliancePayload = {\n' +
  '    chatwoot_conversation_id: convId,\n' +
  '    chatwoot_contact_id: contactId,\n' +
  '    lead_id: "",\n' +
  '    outcome: "compliance",\n' +
  '    lead_name: "",\n' +
  '    handoff_reason: resolvedHandoffReason,\n' +
  '    summary: "Conteúdo clínico/sensível detectado pelo normalizer de mídia.",\n' +
  '    callback_period: "",\n' +
  '    test_run_id: testRunId,\n' +
  '  };\n' +
  '  return { json: {\n' +
  '    phone, msg_id: msgId, chatwoot_conversation_id: convId, chatwoot_contact_id: contactId,\n' +
  '    normalized_text: normalizedText, safety_flags: safetyFlags,\n' +
  '    should_handoff: shouldHandoff, handoff_reason: resolvedHandoffReason,\n' +
  '    fragments_count: fragmentsCount, test_run_id: testRunId,\n' +
  '    _is_compliance: isCompliance, _safety_clinical: clinical,\n' +
  '    _safety_sensitive_image: sensitiveImage, _safety_payment_proof: paymentProof,\n' +
  '    _allow_real_whatsapp_send: allowReal, _igor_dry_run: dryRun,\n' +
  '    _should_send_real: shouldSendReal, _send_gate_reason: sendGateReason,\n' +
  '    session_key: sessionKey,\n' +
  '    igor05_compliance_payload_json: JSON.stringify(igor05CompliancePayload),\n' +
  '  } };\n' +
  '});';

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: { mode: 'runOnceForAllItems', jsCode: validatePayloadJs },
    position: [224, 144],
  },
  output: [{ phone: '', chatwoot_conversation_id: '', normalized_text: '', _is_compliance: false, _should_send_real: false, session_key: '', igor05_compliance_payload_json: '{}' }],
});

const complianceFastPathIf = ifElse({
  version: 2.3,
  config: {
    name: 'Compliance Fast-Path?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [{ id: 'is-compliance-cond', leftValue: "={{ $('Validate Payload').first().json._is_compliance }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [448, 144],
  },
});

const logAgentRoutedToHandoff = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log agent_routed_to_handoff',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('agent_routed_to_handoff', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: "={{ [$('Validate Payload').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ handoff_reason: $('Validate Payload').first().json.handoff_reason, safety_flags: $('Validate Payload').first().json.safety_flags, should_handoff_input: $('Validate Payload').first().json.should_handoff, msg_id: $('Validate Payload').first().json.msg_id, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, fragments_count: $('Validate Payload').first().json.fragments_count, test_run_id: $('Validate Payload').first().json.test_run_id, origin_workflow: 'IGOR_03_Agent_AfterHours' })] }}" },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [672, 0],
    executeOnce: true,
  },
  output: [{}],
});

const callIgor05Compliance = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_05 (compliance)',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_05_V2_ID, cachedResultName: 'IGOR_05_Finalize_Handoff_v2' },
      mode: 'once',
      workflowInputs: "={{ $('Validate Payload').first().json.igor05_compliance_payload_json }}",
      options: { waitForSubWorkflow: true },
    },
    position: [1216, 0],
    executeOnce: true,
  },
  output: [{ ok: true, outcome: 'compliance' }],
});

const complianceOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Compliance Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'cf-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'cf-branch', name: 'branch', value: 'compliance', type: 'string' },
          { id: 'cf-messages', name: 'messages_sent', value: 0, type: 'number' },
          { id: 'cf-mode', name: 'mode', value: 'compliance', type: 'string' },
          { id: 'cf-test-run-id', name: 'test_run_id', value: "={{ $('Validate Payload').first().json.test_run_id }}", type: 'string' },
        ],
      },
      options: {},
    },
    position: [1744, 0],
    executeOnce: true,
  },
  output: [{ ok: true, branch: 'compliance', messages_sent: 0 }],
});

const logAfterHoursStarted = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log after_hours_started',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('after_hours_started', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: "={{ [$('Validate Payload').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ msg_id: $('Validate Payload').first().json.msg_id, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, fragments_count: $('Validate Payload').first().json.fragments_count, session_key: $('Validate Payload').first().json.session_key, text_preview: ($('Validate Payload').first().json.normalized_text || '').slice(0, 240), test_run_id: $('Validate Payload').first().json.test_run_id, origin_workflow: 'IGOR_03_Agent_AfterHours' })] }}" },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [672, 304],
    executeOnce: true,
  },
  output: [{}],
});

const openAiModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Chat Model (Alice)',
    parameters: {
      model: { __rl: true, mode: 'list', value: 'gpt-5.4-mini' },
      options: { temperature: 0.4, responseFormat: 'text', reasoningEffort: 'low' },
    },
    credentials: { openAiApi: newCredential('igor_openai') },
    position: [896, 528],
  },
});

const postgresChatMemory = memory({
  type: '@n8n/n8n-nodes-langchain.memoryPostgresChat',
  version: 1.4,
  config: {
    name: 'Postgres Chat Memory (after_hours)',
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: "={{ $('Validate Payload').first().json.session_key }}",
      tableName: 'n8n_chat_histories',
      contextWindowLength: 25,
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1024, 528],
  },
});

const setLabelAndAttrTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'set_label_and_attr',
    parameters: {
      description: 'Aplica labels e custom_attributes na conversa Chatwoot atual via IGOR_04. Use ao marcar transição operacional (qualificacao_rapida após nome+objetivo, callback_solicitado após período). NUNCA apague labels existentes; apenas adicione via labels_to_add.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_04_ID, cachedResultName: 'IGOR_04_Tool_Labels_Attributes' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Validate Payload').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Validate Payload').first().json.chatwoot_contact_id }}",
          labels_to_add: '={{ $fromAI("labels_to_add", "Lista (array de strings) de labels a adicionar. Exemplos: qualificacao_rapida, callback_solicitado, compliance_hold. Pode ser array vazio.", "json") }}',
          labels_to_remove: '={{ $fromAI("labels_to_remove", "Lista de labels a remover. Vazio na maioria dos casos.", "json") }}',
          custom_attributes: '={{ $fromAI("custom_attributes", "Objeto com chaves conversation/contact para PATCH no Chatwoot.", "json") }}',
          test_run_id: "={{ $('Validate Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'labels_to_add', displayName: 'labels_to_add', required: false, defaultMatch: false, display: true, type: 'array', canBeUsedToMatch: true },
          { id: 'labels_to_remove', displayName: 'labels_to_remove', required: false, defaultMatch: false, display: true, type: 'array', canBeUsedToMatch: true },
          { id: 'custom_attributes', displayName: 'custom_attributes', required: false, defaultMatch: false, display: true, type: 'object', canBeUsedToMatch: true },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1152, 528],
  },
});

const saveLeadPartialTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'save_lead_partial',
    parameters: {
      description: 'Persiste no Supabase informações parciais do lead: nome, objetivo principal, cidade (opcional), callback_period. Chame TODA VEZ que extrair um desses. Use external_id=telefone (55DDD9DDDDDDDD), source=inbound_after_hours.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_AUX_SAVE_LEAD_ID, cachedResultName: 'IGOR_AUX_save_lead_partial' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          contact_id: '={{ $fromAI("contact_id", "UUID do contato no Supabase se conhecido. Vazio caso contrário.", "string") }}',
          phone: "={{ $('Validate Payload').first().json.phone }}",
          source: 'inbound_after_hours',
          external_id: "={{ $('Validate Payload').first().json.phone }}",
          objective: '={{ $fromAI("objective", "Objetivo principal: emagrecimento, performance, reposicao_hormonal, estetica, saude_geral. Vazio se não identificado.", "string") }}',
          city: '={{ $fromAI("city", "Cidade do lead se mencionada naturalmente. Vazio caso contrário.", "string") }}',
          callback_period: '={{ $fromAI("callback_period", "Melhor período/horário informado pelo lead. Vazio se ainda não coletado.", "string") }}',
          kommo_data: '={{ $fromAI("kommo_data", "Objeto JSON com name, observacoes.", "json") }}',
          test_run_id: "={{ $('Validate Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'contact_id', displayName: 'contact_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'source', displayName: 'source', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'external_id', displayName: 'external_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'objective', displayName: 'objective', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'city', displayName: 'city', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'callback_period', displayName: 'callback_period', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'kommo_data', displayName: 'kommo_data', required: false, defaultMatch: false, display: true, type: 'object', canBeUsedToMatch: true },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1280, 528],
  },
});

const updateConversationStateTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'update_conversation_state',
    parameters: {
      description: 'Reflete progresso da conversa no banco. Estados válidos: collecting_name, quick_qualification, collecting_callback_time, handoff_pending, compliance_hold. SEMPRE passe owner_flow=ai_active e increment_turn_count=true para incrementar contador de turnos. Mantenha ai_enabled=true e human_locked=false até o handoff.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_AUX_UPDATE_CONV_ID, cachedResultName: 'IGOR_AUX_update_conversation_state' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          phone: "={{ $('Validate Payload').first().json.phone }}",
          chatwoot_conversation_id: "={{ Number($('Validate Payload').first().json.chatwoot_conversation_id) }}",
          chatwoot_inbox_id: '={{ $fromAI("chatwoot_inbox_id", "ID numérico do inbox Chatwoot. Use 1 se desconhecido.", "number") }}',
          state: '={{ $fromAI("state", "Novo conversation state: collecting_name, quick_qualification, collecting_callback_time, handoff_pending, compliance_hold.", "string") }}',
          ai_enabled: '={{ $fromAI("ai_enabled", "Deixe true durante coleta, false em handoff/compliance.", "boolean") }}',
          human_locked: '={{ $fromAI("human_locked", "Deixe false durante coleta, true em handoff/compliance.", "boolean") }}',
          current_flow: 'after_hours',
          owner_flow: 'ai_active',
          increment_turn_count: true,
          set_journey_started: false,
          test_run_id: "={{ $('Validate Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'phone', displayName: 'phone', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
          { id: 'chatwoot_inbox_id', displayName: 'chatwoot_inbox_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
          { id: 'state', displayName: 'state', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'ai_enabled', displayName: 'ai_enabled', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'human_locked', displayName: 'human_locked', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'current_flow', displayName: 'current_flow', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'owner_flow', displayName: 'owner_flow', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'increment_turn_count', displayName: 'increment_turn_count', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'set_journey_started', displayName: 'set_journey_started', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1408, 528],
  },
});

const requestHandoffTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'request_handoff',
    parameters: {
      description: 'Finaliza atendimento e transfere para a equipe humana via IGOR_05_v2. Chame SOMENTE quando: (a) tiver nome+objetivo+callback coletados -> outcome=qualified; OU (b) lead não engajou/disse não/atingiu max 6 turnos -> outcome=unqualified; OU (c) conteúdo clínico/sensível -> outcome=compliance. SEMPRE forneça outcome, handoff_reason e summary curto PT-BR. Após chamar, envie a mensagem final e PARE de responder.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: IGOR_05_V2_ID, cachedResultName: 'IGOR_05_Finalize_Handoff_v2' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Validate Payload').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Validate Payload').first().json.chatwoot_contact_id }}",
          lead_id: '={{ $fromAI("lead_id", "UUID do lead no Supabase se conhecido. Vazio caso contrário.", "string") }}',
          outcome: '={{ $fromAI("outcome", "Resultado da qualificação: qualified (coletou nome+objetivo+período), unqualified (não engajou/max_turns), compliance (conteúdo clínico/sensível).", "string") }}',
          lead_name: '={{ $fromAI("lead_name", "Nome do lead se coletado. Vazio se ainda não tiver.", "string") }}',
          handoff_reason: '={{ $fromAI("handoff_reason", "Motivo: after_hours_callback, lead_disengaged, max_turns_reached, off_topic, pedido_humano, documento_clinico_sensivel, imagem_sensivel, comprovante_pagamento.", "string") }}',
          summary: '={{ $fromAI("summary", "Resumo curto PT-BR (1-2 frases) para a atendente — inclua nome se coletado, objetivo e contexto.", "string") }}',
          callback_period: '={{ $fromAI("callback_period", "Período de retorno informado. Vazio em compliance/unqualified.", "string") }}',
          test_run_id: "={{ $('Validate Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'lead_id', displayName: 'lead_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'outcome', displayName: 'outcome', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'lead_name', displayName: 'lead_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'handoff_reason', displayName: 'handoff_reason', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'summary', displayName: 'summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'callback_period', displayName: 'callback_period', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1536, 528],
  },
});

const aliceSystemPrompt =
  'Você é Alice, assistente virtual do Instituto Dr. Igor. Atua APENAS no fluxo receptivo fora do expediente humano e SOMENTE em LEADS NOVOS (primeira jornada). Sua função é acolher e fazer qualificação mínima para entregar o lead à equipe humana no próximo dia útil.\n\n' +
  'IDENTIDADE:\n' +
  '- Natural, conversacional, frases curtas estilo WhatsApp.\n' +
  '- Uma pergunta por vez. Sem emoji. Sem caixa alta.\n' +
  '- Tom acolhedor, seguro, profissional.\n' +
  '- Não use termos internos: "workflow", "lead", "label", "handoff", "IA", "automação", "tool", "sistema".\n\n' +
  'OBJETIVO DA CONVERSA — coletar 3 informações:\n' +
  '1. Nome do lead (se ainda não souber)\n' +
  '2. Objetivo principal (emagrecimento, performance, reposição hormonal, estética, saúde geral, ou o que ele disser)\n' +
  '3. Melhor período/horário para a atendente retornar (manhã/tarde + horário aproximado)\n\n' +
  'LIMITE DE TURNOS — 6 turnos no máximo:\n' +
  '- Coletou os 3? -> request_handoff(outcome="qualified") IMEDIATAMENTE + mensagem final.\n' +
  '- 6 turnos sem coletar o mínimo? -> request_handoff(outcome="unqualified", reason="max_turns_reached").\n' +
  '- Lead disengage explícito (não quero / depois eu vejo / off-topic)? -> request_handoff(outcome="unqualified", reason="lead_disengaged").\n' +
  '- Conteúdo clínico/sensível? -> request_handoff(outcome="compliance", reason="documento_clinico_sensivel").\n\n' +
  'PROIBIDO:\n' +
  '- Diagnosticar, prescrever, interpretar exames/laudos/imagens.\n' +
  '- Pedir dados sensíveis (CPF, RG, plano de saúde, histórico médico).\n' +
  '- Simular agendamento real ("reservei", "marquei", "confirmei").\n' +
  '- Inventar preço, condição comercial, política, disponibilidade.\n' +
  '- Continuar respondendo após request_handoff.\n\n' +
  'SEQUÊNCIA TÍPICA (adapte ao lead):\n' +
  '1. Primeira mensagem sem nome: saudação + apresentação + aviso fora do expediente + pergunta de nome.\n' +
  '   Ex: "Oi, tudo bem? Sou a Alice, assistente do Dr. Igor. A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui. Qual seu nome?"\n' +
  '2. Lead diz nome: confirme + pergunte objetivo.\n' +
  '   Ex: "Perfeito, Ana. Pra eu deixar tudo certinho pra equipe, o que você está buscando hoje com o Dr. Igor?"\n' +
  '3. Lead diz objetivo: acolha sem prometer + pergunte período.\n' +
  '   Ex: "Entendi. O Dr. Igor trabalha com acompanhamento individualizado. Qual o melhor período pra atendente te chamar amanhã: manhã ou tarde?"\n' +
  '4. Lead diz período: request_handoff(outcome="qualified", summary=..., callback_period=..., lead_name=...) + mensagem final.\n' +
  '   Ex: "Combinado. Vou deixar registrado pra equipe te chamar amanhã pela manhã."\n\n' +
  'EDGE CASES:\n' +
  '- Pergunta preço: "A equipe confirma valores quando ligar. Qual o melhor período?"\n' +
  '- Pede agendamento direto: "A equipe finaliza horários. Qual período é melhor pra te chamar?"\n' +
  '- Pede humano: se insistir, request_handoff(outcome="qualified", reason="pedido_humano").\n' +
  '- Manda áudio: trate a transcrição como texto comum.\n' +
  '- Manda exame/laudo/imagem clínica: NÃO interprete. request_handoff(outcome="compliance", reason="documento_clinico_sensivel").\n' +
  '- Diz que não quer seguir: agradeça curto + request_handoff(outcome="unqualified", reason="lead_disengaged").\n\n' +
  'TOOLS — quando chamar:\n' +
  '- save_lead_partial: TODA VEZ que extrair nome/objetivo/cidade/callback_period.\n' +
  '- update_conversation_state: A CADA TURNO. SEMPRE passe owner_flow="ai_active" e increment_turn_count=true.\n' +
  '- set_label_and_attr: aplicar labels operacionais (qualificacao_rapida após nome+objetivo, callback_solicitado após período).\n' +
  '- request_handoff: quando coletar mínimo OU compliance OU unqualified. SEMPRE passe outcome.\n\n' +
  'FORMATO DA RESPOSTA:\n' +
  '- PT-BR natural estilo WhatsApp.\n' +
  '- Separe mensagens com linha em branco (parágrafo) — o sistema envia uma mensagem por parágrafo. Até 3 parágrafos por turno.\n' +
  '- Sem bullets, listas numeradas, markdown.\n' +
  '- Sem prefixos, assinaturas, "(resposta:)" — só o texto que o lead vai ver.';

const aliceAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Alice Agent',
    parameters: {
      promptType: 'define',
      text: "={{ $('Validate Payload').first().json.normalized_text }}",
      options: {
        systemMessage: aliceSystemPrompt,
        maxIterations: 6,
        returnIntermediateSteps: false,
        passthroughBinaryImages: false,
        enableStreaming: false,
      },
    },
    subnodes: {
      model: openAiModel,
      memory: postgresChatMemory,
      tools: [setLabelAndAttrTool, saveLeadPartialTool, updateConversationStateTool, requestHandoffTool],
    },
    position: [1152, 304],
  },
  output: [{ output: '' }],
});

const logAgentResponse = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log agent_response (aggregated)',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('agent_response', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: "={{ [$('Validate Payload').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ response_snippet: (String($('Alice Agent').first().json.output || '')).slice(0, 480), response_length: String($('Alice Agent').first().json.output || '').length, msg_id: $('Validate Payload').first().json.msg_id, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, session_key: $('Validate Payload').first().json.session_key, mode: $('Validate Payload').first().json._should_send_real ? 'real' : 'dry', test_run_id: $('Validate Payload').first().json.test_run_id, origin_workflow: 'IGOR_03_Agent_AfterHours' })] }}" },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1744, 304],
    executeOnce: true,
  },
  output: [{}],
});

const formatAiOutputJs =
  'const items = $input.all();\n' +
  'function splitMsg(raw) {\n' +
  '  const s = String(raw || "").trim();\n' +
  '  if (!s) return [];\n' +
  '  let parts;\n' +
  '  if (s.indexOf("||") !== -1) parts = s.split(/\\s*\\|\\|\\s*/);\n' +
  '  else parts = s.split(/\\n{2,}/);\n' +
  '  return parts.map(p => p.trim()).filter(p => p.length > 0).slice(0, 4);\n' +
  '}\n' +
  'return items.map(item => {\n' +
  '  const j = item.json || {};\n' +
  '  const raw = (j.output !== undefined && j.output !== null) ? j.output : (j.text || "");\n' +
  '  const messages = splitMsg(raw);\n' +
  '  return { json: { messages, message_count: messages.length, raw_output: raw } };\n' +
  '});';

const formatAiOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Format AI Output', parameters: { mode: 'runOnceForAllItems', jsCode: formatAiOutputJs }, position: [1968, 304] },
  output: [{ messages: [], message_count: 0, raw_output: '' }],
});

const splitMessages = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Messages', parameters: { fieldToSplitOut: 'messages', include: 'noOtherFields', options: { destinationFieldName: 'message' } }, position: [2192, 304] },
  output: [{ message: '' }],
});

const loopMessages = splitInBatches({
  version: 3,
  config: { name: 'Loop Messages', parameters: { batchSize: 1, options: {} }, position: [2416, 304] },
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
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ number: $('Validate Payload').first().json.phone, presence: 'composing', delay: Math.max(800, Math.min(3000, String($('Loop Messages').item.json.message || '').length * 30)) }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 10000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    onError: 'continueRegularOutput',
    position: [2640, 224],
  },
  output: [{ ok: true }],
});

const sendRealIf = ifElse({
  version: 2.3,
  config: {
    name: 'Send Real?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [{ id: 'send-gate-real-cond', leftValue: "={{ $('Validate Payload').first().json._should_send_real }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [2864, 224],
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
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ number: $('Validate Payload').first().json.phone, text: $('Loop Messages').item.json.message }) }}",
      options: { response: { response: { neverError: false, responseFormat: 'json' } }, timeout: 20000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [3088, 128],
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
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('whatsapp_sent', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: "={{ [$('Validate Payload').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ message_snippet: String($('Loop Messages').item.json.message || '').slice(0, 280), message_length: String($('Loop Messages').item.json.message || '').length, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send, dry_run: $('Validate Payload').first().json._igor_dry_run, mode: 'real', test_run_id: $('Validate Payload').first().json.test_run_id, origin_workflow: 'IGOR_03_Agent_AfterHours' })] }}" },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3312, 128],
  },
  output: [{}],
});

const wait2sReal = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 2s (real)', parameters: { resume: 'timeInterval', amount: 2, unit: 'seconds' }, position: [3536, 320] },
  output: [{}],
});

const logDryRunSend = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log dry_run_send',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('dry_run_send', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: "={{ [$('Validate Payload').first().json.phone, $('Validate Payload').first().json.chatwoot_conversation_id, JSON.stringify({ message_snippet: String($('Loop Messages').item.json.message || '').slice(0, 280), message_length: String($('Loop Messages').item.json.message || '').length, chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id, chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id, reason: $('Validate Payload').first().json._send_gate_reason, allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send, dry_run: $('Validate Payload').first().json._igor_dry_run, mode: 'dry', test_run_id: $('Validate Payload').first().json.test_run_id, origin_workflow: 'IGOR_03_Agent_AfterHours' })] }}" },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [3088, 320],
  },
  output: [{}],
});

const wait2sDry = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 2s (dry)', parameters: { resume: 'timeInterval', amount: 2, unit: 'seconds' }, position: [3312, 320] },
  output: [{}],
});

const agentOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Agent Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'ag-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'ag-branch', name: 'branch', value: 'agent', type: 'string' },
          { id: 'ag-messages-sent', name: 'messages_sent', value: "={{ $('Format AI Output').first().json.message_count }}", type: 'number' },
          { id: 'ag-mode', name: 'mode', value: "={{ $('Validate Payload').first().json._should_send_real ? 'real' : 'dry' }}", type: 'string' },
          { id: 'ag-test-run-id', name: 'test_run_id', value: "={{ $('Validate Payload').first().json.test_run_id }}", type: 'string' },
        ],
      },
      options: {},
    },
    position: [2640, 32],
    executeOnce: true,
  },
  output: [{ ok: true, branch: 'agent', messages_sent: 0 }],
});

export default workflow('iQCVbe1P8dC0vhay', 'IGOR_03_Agent_AfterHours')
  .add(executeTrigger)
  .to(loadGates)
  .to(validatePayload)
  .to(
    complianceFastPathIf
      .onTrue(logAgentRoutedToHandoff.to(callIgor05Compliance.to(complianceOutput)))
      .onFalse(
        logAfterHoursStarted
          .to(aliceAgent)
          .to(logAgentResponse)
          .to(formatAiOutput)
          .to(splitMessages)
          .to(
            loopMessages
              .onDone(agentOutput)
              .onEachBatch(
                presenceComposing.to(
                  sendRealIf
                    .onTrue(evolutionSendText.to(logWhatsappSent.to(wait2sReal.to(nextBatch(loopMessages)))))
                    .onFalse(logDryRunSend.to(wait2sDry.to(nextBatch(loopMessages))))
                )
              )
          )
      )
  );
