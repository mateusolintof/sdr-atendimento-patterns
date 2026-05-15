// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_03_Agent_AfterHours.json`
// (exportado da n8n REST API apos PUT settings + PATCH tags, workflowId =
// `iQCVbe1P8dC0vhay`).
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "tags": ["igor", "inbound", "agent", "langchain", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// SDK HARNESS RESTRICTIONS encountered when building this workflow:
//   - No function declarations or arrow functions in SDK root scope.
//   - Method `.join()` is blocked. Long multi-line strings (validatePayload
//     jsCode, formatAiOutput jsCode, aliceSystemPrompt) MUST be declared as
//     single string literals with explicit `\n` escapes (vide constantes no
//     topo do arquivo).
//   - `toolWorkflow.workflowInputs` aceita objeto literal
//     `{mappingMode:'defineBelow', value:{...}, schema:[...], ...}`.
//
// Sub-workflow callable IDs resolved at build-time (verified via
// `mcp__n8n-mcp__search_workflows` antes da escrita):
//   - IGOR_04_Tool_Labels_Attributes        workflowId = "AJF7dhGrqJEXMLqz"
//   - IGOR_05_Finalize_Handoff              workflowId = "N31QcdrNVE5AOZdu"
//   - IGOR_AUX_save_lead_partial            workflowId = "hRogDlGsgQxGwnD8"
//   - IGOR_AUX_update_conversation_state    workflowId = "mFuRPrGGt7yWVqEw"
//   - IGOR_07_Error_Logger (errorWorkflow)  workflowId = "ZrsbaSTlW5bqMEaS"
//
// Credential names (must exist in n8n with matching display names):
//   - Postgres           -> credentials.postgres        = igor_supabase_postgres  (auto-wired)
//   - OpenAI Chat        -> credentials.openAiApi       = igor_openai             (auto-wired)
//   - Evolution HTTP     -> credentials.httpHeaderAuth  = igor_evolution_api      (manual wire)
//
// NOTE: `igor_evolution_api` may not exist yet in n8n staging. The send-gate
// makes this a soft blocker: when `ALLOW_REAL_WHATSAPP_SEND !== 'true'` ou
// `IGOR_DRY_RUN === 'true'`, o reply path NUNCA atinge o POST Evolution. Cai em
// `events('dry_run_send')`. Real-send activation requires creating
// `igor_evolution_api` first via UI n8n.
// =============================================================================

import {
  workflow,
  node,
  trigger,
  ifElse,
  newCredential,
  languageModel,
  memory,
  tool,
  expr,
  splitInBatches,
  nextBatch,
} from '@n8n/workflow-sdk';

// =============================================================================
// IGOR_03_Agent_AfterHours
// =============================================================================
// Agente conversacional Alice — fluxo receptivo fora de expediente.
//
//   1. Trigger callable (executeWorkflowTrigger) com 10 campos.
//   2. Validate Payload: coerce/defaults; computa _should_send_real,
//      _is_compliance, sessionKey, igor05_compliance_payload_json.
//   3. IF Compliance Fast-Path?
//        true: log + executeWorkflow IGOR_05 direto + output compliance.
//        false: log after_hours_started -> Alice Agent (langchain) -> log agent_response
//               -> Format AI Output -> SplitOut -> SplitInBatches -> Presence
//               -> IF send-gate -> sendText|dry log -> Wait 2s -> loop.
//
// Errors -> IGOR_07 (errorWorkflow no settings do JSON canonical).
// =============================================================================

const validatePayloadJsCode = "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const phone = (j.phone === undefined || j.phone === null) ? '' : String(j.phone).trim();\n  const msgId = (j.msgId === undefined || j.msgId === null) ? '' : String(j.msgId).trim();\n  const convId = (j.chatwoot_conversation_id === undefined || j.chatwoot_conversation_id === null) ? '' : String(j.chatwoot_conversation_id).trim();\n  const contactId = (j.chatwoot_contact_id === undefined || j.chatwoot_contact_id === null) ? '' : String(j.chatwoot_contact_id).trim();\n  const normalizedText = (j.normalized_text === undefined || j.normalized_text === null) ? '' : String(j.normalized_text);\n  let safetyFlags = j.safety_flags;\n  if (typeof safetyFlags === 'string') {\n    try { safetyFlags = JSON.parse(safetyFlags); } catch (e) { safetyFlags = {}; }\n  }\n  if (!safetyFlags || typeof safetyFlags !== 'object' || Array.isArray(safetyFlags)) safetyFlags = {};\n  const clinical = safetyFlags.clinical === true;\n  const sensitiveImage = safetyFlags.sensitive_image === true;\n  const paymentProof = safetyFlags.payment_proof === true;\n  const shouldHandoff = j.should_handoff === true || j.should_handoff === 'true';\n  const handoffReason = (j.handoff_reason === undefined || j.handoff_reason === null) ? '' : String(j.handoff_reason);\n  const fragmentsCount = (typeof j.fragments_count === 'number') ? j.fragments_count : (parseInt(j.fragments_count, 10) || 1);\n  const testRunId = (j.test_run_id === undefined || j.test_run_id === null) ? '' : String(j.test_run_id);\n  const isCompliance = shouldHandoff || clinical || sensitiveImage || paymentProof;\n  let resolvedHandoffReason = handoffReason;\n  if (!resolvedHandoffReason || resolvedHandoffReason === '') {\n    if (clinical) resolvedHandoffReason = 'documento_clinico_sensivel';\n    else if (sensitiveImage) resolvedHandoffReason = 'imagem_sensivel';\n    else if (paymentProof) resolvedHandoffReason = 'comprovante_pagamento';\n    else if (shouldHandoff) resolvedHandoffReason = 'safety_flag_generic';\n  }\n  // Gates from settings table (Load Gates postgres node)\n  const allowReal = $('Load Gates').first().json.allow_real_whatsapp_send === true;\n  const dryRun = $('Load Gates').first().json.dry_run_send === true;\n  const shouldSendReal = allowReal && !dryRun;\n  let sendGateReason;\n  if (shouldSendReal) sendGateReason = 'allow_real_true_and_dry_run_false';\n  else if (!allowReal) sendGateReason = 'allow_real_whatsapp_send_not_true';\n  else sendGateReason = 'igor_dry_run_true';\n  const sessionKey = 'after_hours_' + phone;\n  const igor05CompliancePayload = {\n    chatwoot_conversation_id: convId,\n    chatwoot_contact_id: contactId,\n    lead_id: '',\n    handoff_reason: resolvedHandoffReason,\n    summary: 'Midia/conteudo sensivel detectado pelo normalizer.',\n    callback_period: '',\n    owner_flow: 'after_hours',\n    test_run_id: testRunId,\n  };\n  return {\n    json: {\n      phone,\n      msg_id: msgId,\n      chatwoot_conversation_id: convId,\n      chatwoot_contact_id: contactId,\n      normalized_text: normalizedText,\n      safety_flags: safetyFlags,\n      should_handoff: shouldHandoff,\n      handoff_reason: resolvedHandoffReason,\n      fragments_count: fragmentsCount,\n      test_run_id: testRunId,\n      _is_compliance: isCompliance,\n      _safety_clinical: clinical,\n      _safety_sensitive_image: sensitiveImage,\n      _safety_payment_proof: paymentProof,\n      _allow_real_whatsapp_send: allowReal,\n      _igor_dry_run: dryRun,\n      _should_send_real: shouldSendReal,\n      _send_gate_reason: sendGateReason,\n      session_key: sessionKey,\n      igor05_compliance_payload: igor05CompliancePayload,\n      igor05_compliance_payload_json: JSON.stringify(igor05CompliancePayload),\n    },\n  };\n});";

const formatAiOutputJsCode = "const items = $input.all();\nfunction splitMsg(raw) {\n  const s = String(raw || '').trim();\n  if (!s) return [];\n  let parts;\n  if (s.includes('||')) {\n    parts = s.split(/\\s*\\|\\|\\s*/);\n  } else {\n    parts = s.split(/\\n{2,}/);\n  }\n  return parts.map(p => p.trim()).filter(p => p.length > 0).slice(0, 4);\n}\nreturn items.map(item => {\n  const j = item.json || {};\n  const raw = (j.output !== undefined && j.output !== null) ? j.output : (j.text || '');\n  const messages = splitMsg(raw);\n  return { json: { messages, message_count: messages.length, raw_output: raw } };\n});";

// System prompt Alice (PT-BR LITERAL — baseado em docs/logica-fluxo-igor-
// receptivo-fora-expediente.md §§5, 6, 11, 12). Acentos PRESERVADOS.
// Comprimento: ~4500 chars. Mantenha em sincronia com o spec — qualquer edicao
// precisa ser refletida primeiro no spec e depois aqui + no JSON canonical.
const aliceSystemPrompt = "Você é Alice, assistente virtual do Instituto Dr. Igor. Atua no fluxo receptivo fora do expediente humano: acolhe o lead, adianta a qualificação mínima e transfere para a equipe humana retornar.\n\nPersonalidade obrigatória:\n- Natural e conversacional, frases curtas em estilo WhatsApp.\n- Uma pergunta por vez. Nunca mais de uma pergunta por mensagem.\n- Tom acolhedor, seguro e profissional. Sem emoji. Sem caixa alta.\n- Nunca usa termos internos: não diga \"workflow\", \"lead\", \"lead_status\", \"label\", \"handoff\", \"IA\", \"automação\", \"prompt\", \"tool\", \"integração\", \"sistema\".\n- Não força venda. Não promete resultado clínico.\n\nConduta obrigatória:\n- Informe, quando fizer sentido, que a equipe já encerrou o expediente e que você está adiantando o atendimento por aqui.\n- Ajude de forma breve e direta.\n- Se ainda não souber o nome do lead, pergunte o nome.\n- Entenda o objetivo principal do lead (emagrecimento, performance, reposição hormonal, estética, saúde geral). Aceite o que ele disser; não force categoria.\n- Solicite o melhor horário/período para a atendente retornar.\n- Assim que tiver nome + objetivo + callback_period coletados, chame a tool request_handoff ANTES de mandar a mensagem final ao lead.\n- Após chamar request_handoff, envie UMA mensagem curta avisando que a equipe assume e encerre sua atuação. Não continue conversando.\n\nConduta proibida:\n- Não diagnostique. Não prescreva. Não interprete exames, laudos, prescrições, imagens do corpo ou documentos clínicos.\n- Não solicite dados sensíveis desnecessários (CPF, RG, plano de saúde, histórico médico extenso, comprovantes financeiros).\n- Não faça anamnese extensa. Apenas o necessário para a atendente continuar.\n- Não simule disponibilidade real de agenda. Não diga que \"marcou\" consulta. Não confirme horário específico de atendimento.\n- Não siga respondendo se a conversa estiver com ai_enabled=false ou se você já chamou request_handoff.\n- Não invente preço, condição comercial, política ou disponibilidade que não esteja explicitamente configurada.\n\nCampos mínimos da qualificação rápida (coletar e persistir via tools):\n- nome (obrigatório se ausente; pode ser extraído da mensagem ou perguntado).\n- objetivo_principal (obrigatório; aceitar fala natural do lead).\n- callback_period (obrigatório; ex.: \"amanhã pela manhã\", \"hoje à tarde\", \"qualquer horário após 18h\").\n- cidade (opcional, só se surgir naturalmente).\n\nSequência conversacional esperada (referência — adapte ao que o lead mandar):\n1. Primeira mensagem do lead, sem nome conhecido: saudação curta + apresentação como Alice + aviso de fora do expediente + pergunta de nome.\n   Exemplo: \"Oi, tudo bem? Sou a Alice, assistente do Dr. Igor. A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui. Qual seu nome?\"\n2. Lead informa o nome: confirme curto e pergunte objetivo.\n   Exemplo: \"Perfeito, Ana. Pra eu deixar tudo certinho para a equipe, o que você está buscando hoje com o Dr. Igor?\"\n3. Lead informa o objetivo: acolha sem prometer resultado, pergunte período de retorno.\n   Exemplo: \"Entendi. O Dr. Igor trabalha com acompanhamento individualizado e a equipe consegue te explicar os próximos passos certinho. Qual o melhor período para a atendente te chamar: manhã ou tarde?\"\n4. Lead informa o período: chame request_handoff, depois mande mensagem final.\n   Exemplo: \"Combinado. Deixei registrado para a equipe te chamar amanhã de manhã pelo WhatsApp e continuar seu atendimento.\"\n\nCondicionais conversacionais:\n- Lead pergunta preço: você pode dizer que a equipe confirma as condições vigentes; se houver valor configurado pela política, mencione apenas como referência e redirecione para o callback.\n- Lead pede agendamento direto: confirme que a equipe finaliza horários e pergunte o melhor período para a atendente chamá-lo.\n- Lead pede para falar com humano: avise que vai encaminhar e pergunte o melhor período. Se insistir, chame request_handoff mesmo sem horário (handoff_reason=\"pedido_humano\").\n- Lead envia áudio: trate a transcrição já normalizada como texto comum.\n- Lead envia exame, laudo ou imagem clínica: NÃO interprete. Avise que a equipe precisa analisar diretamente e chame request_handoff com handoff_reason=\"documento_clinico_sensivel\".\n- Lead diz que não quer seguir agora: agradeça curto, deixe o canal aberto, sem pressionar.\n\nTools disponíveis (quando chamar):\n- save_lead_partial: chame TODA VEZ que extrair nome, objetivo_principal, cidade ou callback_period da mensagem do lead. Use external_id = telefone do lead (formato 55DDD9DDDDDDDD) e source = \"inbound_after_hours\". Preencha somente os campos que você identificou.\n- update_conversation_state: reflete progresso. Use state=\"collecting_name\" ao perguntar o nome, \"quick_qualification\" ao perguntar o objetivo, \"collecting_callback_time\" ao perguntar o período, \"handoff_pending\" quando estiver prestes a chamar request_handoff. Mantenha ai_enabled=true e human_locked=false até o handoff. current_flow sempre \"after_hours\".\n- set_label_and_attr: aplica labels operacionais via Chatwoot. Adicione \"qualificacao_rapida\" após coletar nome + objetivo. Adicione \"callback_solicitado\" após coletar callback_period. Em compliance, adicione \"compliance_hold\". Nunca apague labels existentes — só use labels_to_remove para labels que você mesma aplicou.\n- request_handoff: chame APENAS quando tiver nome + objetivo + callback_period coletados, OU imediatamente em compliance (documento clínico, imagem sensível, comprovante de pagamento, pedido explícito de humano). Sempre forneça handoff_reason e summary curto em PT-BR para a atendente.\n\nFormato da resposta ao lead:\n- Responda em PT-BR natural, no estilo WhatsApp.\n- Se precisar mandar várias mensagens em sequência (ex.: saudação, contexto, pergunta), separe cada mensagem com uma linha em branco (parágrafo). O sistema vai disparar uma mensagem por parágrafo, com pausa entre elas. Não use bullets, listas numeradas ou markdown — apenas texto corrido.\n- Mantenha cada parágrafo curto (1-2 frases). Total de no máximo 3 parágrafos por turno.\n- Não inclua nada além do texto que o lead vai ver. Sem prefixos, sem assinaturas, sem \"(resposta:)\".";

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
    position: [0, 0],
  },
  output: [
    {
      phone: '5511900000301',
      msgId: 'IGOR_03_first_message_text_msg',
      chatwoot_conversation_id: '9301',
      chatwoot_contact_id: '8301',
      normalized_text: 'Oi, queria saber sobre consulta com o Dr. Igor',
      safety_flags: { clinical: false, sensitive_image: false, payment_proof: false },
      should_handoff: false,
      handoff_reason: '',
      fragments_count: 1,
      test_run_id: 'IGOR_03_FIXTURE_first_message_text',
    },
  ],
});

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: { mode: 'runOnceForAllItems', jsCode: validatePayloadJsCode },
    position: [220, 0],
  },
  output: [
    {
      phone: '5511900000301',
      msg_id: 'IGOR_03_first_message_text_msg',
      chatwoot_conversation_id: '9301',
      chatwoot_contact_id: '8301',
      normalized_text: 'Oi, queria saber sobre consulta com o Dr. Igor',
      safety_flags: { clinical: false, sensitive_image: false, payment_proof: false },
      should_handoff: false,
      handoff_reason: '',
      fragments_count: 1,
      test_run_id: 'IGOR_03_FIXTURE_first_message_text',
      _is_compliance: false,
      _allow_real_whatsapp_send: false,
      _igor_dry_run: true,
      _should_send_real: false,
      _send_gate_reason: 'igor_dry_run_true',
      session_key: 'after_hours_5511900000301',
      igor05_compliance_payload_json: '{}',
    },
  ],
});

const complianceIf = ifElse({
  version: 2.3,
  config: {
    name: 'Compliance Fast-Path?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [{ id: 'is-compliance-cond', leftValue: expr("={{ $('Validate Payload').first().json._is_compliance }}"), rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [440, 0],
  },
});

const logAgentRoutedToHandoff = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log agent_routed_to_handoff',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES ('agent_routed_to_handoff', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: expr("={{ [\n  $('Validate Payload').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    handoff_reason: $('Validate Payload').first().json.handoff_reason,\n    safety_flags: $('Validate Payload').first().json.safety_flags,\n    should_handoff_input: $('Validate Payload').first().json.should_handoff,\n    msg_id: $('Validate Payload').first().json.msg_id,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id,\n    fragments_count: $('Validate Payload').first().json.fragments_count,\n    test_run_id: $('Validate Payload').first().json.test_run_id,\n    origin_workflow: 'IGOR_03_Agent_AfterHours',\n  })\n] }}") },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    position: [660, -200],
  },
  output: [{ executionStatus: 'success' }],
});

const callIgor05Compliance = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Call IGOR_05 (compliance)',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'N31QcdrNVE5AOZdu', cachedResultName: 'IGOR_05_Finalize_Handoff' },
      mode: 'once',
      workflowInputs: expr("={{ $('Validate Payload').first().json.igor05_compliance_payload_json }}"),
      options: { waitForSubWorkflow: true },
    },
    executeOnce: true,
    position: [880, -200],
  },
  output: [{ ok: true, branch: 'compliance' }],
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
          { id: 'cf-test-run-id', name: 'test_run_id', value: expr("={{ $('Validate Payload').first().json.test_run_id }}"), type: 'string' },
        ],
      },
      options: {},
    },
    executeOnce: true,
    position: [1100, -200],
  },
  output: [{ ok: true, branch: 'compliance', messages_sent: 0, mode: 'compliance' }],
});

const logAfterHoursStarted = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log after_hours_started',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES ('after_hours_started', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: expr("={{ [\n  $('Validate Payload').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    msg_id: $('Validate Payload').first().json.msg_id,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id,\n    fragments_count: $('Validate Payload').first().json.fragments_count,\n    session_key: $('Validate Payload').first().json.session_key,\n    text_preview: ($('Validate Payload').first().json.normalized_text || '').slice(0, 240),\n    test_run_id: $('Validate Payload').first().json.test_run_id,\n    origin_workflow: 'IGOR_03_Agent_AfterHours',\n  })\n] }}") },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    position: [660, 200],
  },
  output: [{ executionStatus: 'success' }],
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
    position: [820, 420],
  },
});

const postgresMemory = memory({
  type: '@n8n/n8n-nodes-langchain.memoryPostgresChat',
  version: 1.4,
  config: {
    name: 'Postgres Chat Memory (after_hours)',
    parameters: { sessionIdType: 'customKey', sessionKey: expr("={{ $('Validate Payload').first().json.session_key }}"), tableName: 'n8n_chat_histories', contextWindowLength: 25 },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1000, 420],
  },
});

const toolSetLabelAndAttr = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'set_label_and_attr',
    parameters: {
      description: 'Aplica labels e custom_attributes na conversa Chatwoot atual via IGOR_04_Tool_Labels_Attributes. Use sempre que precisar marcar transicao operacional do lead. NUNCA apague labels existentes; apenas adicione via labels_to_add.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'AJF7dhGrqJEXMLqz', cachedResultName: 'IGOR_04_Tool_Labels_Attributes' },
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
    position: [1180, 420],
  },
});

const toolSaveLeadPartial = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'save_lead_partial',
    parameters: {
      description: 'Persiste no Supabase informacoes parciais do lead extraidas da conversa: nome, objetivo principal, cidade (opcional), callback_period. Chame TODA VEZ que extrair um desses campos. Use external_id = telefone do lead (55DDD9DDDDDDDD), source = inbound_after_hours.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'hRogDlGsgQxGwnD8', cachedResultName: 'IGOR_AUX_save_lead_partial' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          contact_id: '={{ $fromAI("contact_id", "UUID do contato no Supabase se conhecido. Vazio caso contrario.", "string") }}',
          phone: "={{ $('Validate Payload').first().json.phone }}",
          source: 'inbound_after_hours',
          external_id: "={{ $('Validate Payload').first().json.phone }}",
          objective: '={{ $fromAI("objective", "Objetivo principal: emagrecimento, performance, reposicao_hormonal, estetica, saude_geral. Vazio se nao identificado.", "string") }}',
          city: '={{ $fromAI("city", "Cidade do lead se mencionada naturalmente. Vazio caso contrario.", "string") }}',
          callback_period: '={{ $fromAI("callback_period", "Melhor periodo/horario informado pelo lead. Vazio se ainda nao coletado.", "string") }}',
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
    position: [1340, 420],
  },
});

const toolUpdateConvState = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'update_conversation_state',
    parameters: {
      description: 'Reflete progresso da conversa no banco. Estados validos: collecting_name, quick_qualification, collecting_callback_time, handoff_pending, compliance_hold. Mantenha ai_enabled=true e human_locked=false ate o handoff. current_flow sempre after_hours.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'mFuRPrGGt7yWVqEw', cachedResultName: 'IGOR_AUX_update_conversation_state' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          phone: "={{ $('Validate Payload').first().json.phone }}",
          chatwoot_conversation_id: "={{ Number($('Validate Payload').first().json.chatwoot_conversation_id) }}",
          chatwoot_inbox_id: '={{ $fromAI("chatwoot_inbox_id", "ID numerico do inbox Chatwoot. Use 0 se desconhecido.", "number") }}',
          state: '={{ $fromAI("state", "Novo conversation_state: collecting_name, quick_qualification, collecting_callback_time, handoff_pending, compliance_hold.", "string") }}',
          ai_enabled: '={{ $fromAI("ai_enabled", "Deixe true durante coleta, false em handoff/compliance.", "boolean") }}',
          human_locked: '={{ $fromAI("human_locked", "Deixe false durante coleta, true em handoff/compliance.", "boolean") }}',
          current_flow: 'after_hours',
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
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1500, 420],
  },
});

const toolRequestHandoff = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'request_handoff',
    parameters: {
      description: 'Finaliza atendimento da IA e transfere para a equipe humana via IGOR_05. Chame SOMENTE quando tiver nome+objetivo+callback OU em compliance imediato. Forneca handoff_reason (after_hours_callback, pedido_humano, documento_clinico_sensivel, imagem_sensivel, comprovante_pagamento) e summary curto PT-BR. Apos chamar, envie a mensagem final e NAO continue respondendo.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'N31QcdrNVE5AOZdu', cachedResultName: 'IGOR_05_Finalize_Handoff' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          chatwoot_conversation_id: "={{ $('Validate Payload').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Validate Payload').first().json.chatwoot_contact_id }}",
          lead_id: '={{ $fromAI("lead_id", "UUID do lead no Supabase se conhecido. Vazio caso contrario.", "string") }}',
          handoff_reason: '={{ $fromAI("handoff_reason", "Motivo do handoff.", "string") }}',
          summary: '={{ $fromAI("summary", "Resumo curto PT-BR (1-2 frases) para a atendente.", "string") }}',
          callback_period: '={{ $fromAI("callback_period", "Periodo de retorno informado. Vazio em compliance.", "string") }}',
          owner_flow: 'after_hours',
          test_run_id: "={{ $('Validate Payload').first().json.test_run_id }}",
        },
        matchingColumns: [],
        schema: [
          { id: 'chatwoot_conversation_id', displayName: 'chatwoot_conversation_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'chatwoot_contact_id', displayName: 'chatwoot_contact_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'lead_id', displayName: 'lead_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'handoff_reason', displayName: 'handoff_reason', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'summary', displayName: 'summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'callback_period', displayName: 'callback_period', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'owner_flow', displayName: 'owner_flow', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'test_run_id', displayName: 'test_run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    position: [1660, 420],
  },
});

const aliceAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Alice Agent',
    parameters: {
      promptType: 'define',
      text: expr("={{ $('Validate Payload').first().json.normalized_text }}"),
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
      memory: postgresMemory,
      tools: [toolSetLabelAndAttr, toolSaveLeadPartial, toolUpdateConvState, toolRequestHandoff],
    },
    executeOnce: true,
    position: [880, 200],
  },
  output: [{ output: 'Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.\n\nA equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.\n\nQual seu nome?' }],
});

const logAgentResponse = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log agent_response (aggregated)',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES ('agent_response', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: expr("={{ [\n  $('Validate Payload').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    response_snippet: (String($('Alice Agent').first().json.output || '')).slice(0, 480),\n    response_length: String($('Alice Agent').first().json.output || '').length,\n    msg_id: $('Validate Payload').first().json.msg_id,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id,\n    session_key: $('Validate Payload').first().json.session_key,\n    mode: $('Validate Payload').first().json._should_send_real ? 'real' : 'dry',\n    test_run_id: $('Validate Payload').first().json.test_run_id,\n    origin_workflow: 'IGOR_03_Agent_AfterHours',\n  })\n] }}") },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    executeOnce: true,
    position: [1100, 200],
  },
  output: [{ executionStatus: 'success' }],
});

const formatAiOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format AI Output',
    parameters: { mode: 'runOnceForAllItems', jsCode: formatAiOutputJsCode },
    executeOnce: true,
    position: [1320, 200],
  },
  output: [{ messages: ['Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.', 'A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.', 'Qual seu nome?'], message_count: 3, raw_output: 'Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.\n\nA equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.\n\nQual seu nome?' }],
});

const splitMessages = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Messages', parameters: { fieldToSplitOut: 'messages', include: 'noOtherFields', options: { destinationFieldName: 'message' } }, position: [1540, 200] },
  output: [{ message: 'Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.' }, { message: 'A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.' }, { message: 'Qual seu nome?' }],
});

const loopMessages = splitInBatches({
  version: 3,
  config: { name: 'Loop Messages', parameters: { batchSize: 1, options: {} }, position: [1760, 200] },
});

const presenceComposing = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Presence Composing',
    parameters: {
      method: 'POST',
      url: expr("=https://evo.almaconvert.com.br/chat/sendPresence/convert-teste"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify({ number: $('Validate Payload').first().json.phone, presence: 'composing', delay: Math.max(800, Math.min(3000, String($('Loop Messages').item.json.message || '').length * 30)) }) }}"),
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 10000 },
    },
    onError: 'continueRegularOutput',
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [1980, 200],
  },
  output: [{ ok: true, presence_sent: 'composing' }],
});

const sendGateIf = ifElse({
  version: 2.3,
  config: {
    name: 'Send Real?',
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [{ id: 'send-gate-real-cond', leftValue: expr("={{ $('Validate Payload').first().json._should_send_real }}"), rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      },
    },
    position: [2200, 200],
  },
});

const sendEvolutionText = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Evolution sendText',
    parameters: {
      method: 'POST',
      url: expr("=https://evo.almaconvert.com.br/message/sendText/convert-teste"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify({ number: $('Validate Payload').first().json.phone, text: $('Loop Messages').item.json.message }) }}"),
      options: { response: { response: { neverError: false, responseFormat: 'json' } }, timeout: 20000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_evolution_api') },
    position: [2420, 60],
  },
  output: [{ key: { id: 'msg-id-fake' }, status: 'PENDING' }],
});

const logWhatsappSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log whatsapp_sent',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES ('whatsapp_sent', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: expr("={{ [\n  $('Validate Payload').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    message_snippet: String($('Loop Messages').item.json.message || '').slice(0, 280),\n    message_length: String($('Loop Messages').item.json.message || '').length,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id,\n    allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send,\n    dry_run: $('Validate Payload').first().json._igor_dry_run,\n    mode: 'real',\n    test_run_id: $('Validate Payload').first().json.test_run_id,\n    origin_workflow: 'IGOR_03_Agent_AfterHours',\n  })\n] }}") },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2640, 60],
  },
  output: [{ executionStatus: 'success' }],
});

const logDryRunSend = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log dry_run_send',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES ('dry_run_send', NULLIF($1, ''), NULLIF($2, '')::int, 'IGOR_03_Agent_AfterHours', $3::jsonb);",
      options: { queryReplacement: expr("={{ [\n  $('Validate Payload').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    message_snippet: String($('Loop Messages').item.json.message || '').slice(0, 280),\n    message_length: String($('Loop Messages').item.json.message || '').length,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    chatwoot_contact_id: $('Validate Payload').first().json.chatwoot_contact_id,\n    reason: $('Validate Payload').first().json._send_gate_reason,\n    allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send,\n    dry_run: $('Validate Payload').first().json._igor_dry_run,\n    mode: 'dry',\n    test_run_id: $('Validate Payload').first().json.test_run_id,\n    origin_workflow: 'IGOR_03_Agent_AfterHours',\n  })\n] }}") },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [2420, 340],
  },
  output: [{ executionStatus: 'success' }],
});

const waitBetweenMessagesReal = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 2s (real)', parameters: { resume: 'timeInterval', amount: 2, unit: 'seconds' }, position: [2860, 60] },
  output: [{ continued: true }],
});

const waitBetweenMessagesDry = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait 2s (dry)', parameters: { resume: 'timeInterval', amount: 2, unit: 'seconds' }, position: [2640, 340] },
  output: [{ continued: true }],
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
          { id: 'ag-messages-sent', name: 'messages_sent', value: expr("={{ $('Format AI Output').first().json.message_count }}"), type: 'number' },
          { id: 'ag-mode', name: 'mode', value: expr("={{ $('Validate Payload').first().json._should_send_real ? 'real' : 'dry' }}"), type: 'string' },
          { id: 'ag-test-run-id', name: 'test_run_id', value: expr("={{ $('Validate Payload').first().json.test_run_id }}"), type: 'string' },
        ],
      },
      options: {},
    },
    executeOnce: true,
    position: [3080, 200],
  },
  output: [{ ok: true, branch: 'agent', messages_sent: 3, mode: 'dry' }],
});

export default workflow('IGOR_03_Agent_AfterHours', 'IGOR_03_Agent_AfterHours')
  .add(executeTrigger)
  .to(validatePayload)
  .to(
    complianceIf
      .onTrue(logAgentRoutedToHandoff.to(callIgor05Compliance).to(complianceOutput))
      .onFalse(
        logAfterHoursStarted.to(aliceAgent).to(logAgentResponse).to(formatAiOutput).to(splitMessages).to(
          loopMessages
            .onDone(agentOutput)
            .onEachBatch(
              presenceComposing.to(
                sendGateIf
                  .onTrue(sendEvolutionText.to(logWhatsappSent).to(waitBetweenMessagesReal).to(nextBatch(loopMessages)))
                  .onFalse(logDryRunSend.to(waitBetweenMessagesDry).to(nextBatch(loopMessages)))
              )
            )
        )
      )
  );
