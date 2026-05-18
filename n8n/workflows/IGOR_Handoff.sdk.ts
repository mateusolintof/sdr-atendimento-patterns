import {
  workflow,
  node,
  trigger,
  newCredential,
} from '@n8n/workflow-sdk';

// IGOR_Handoff — callable workflow para finalizar atendimento e transferir lead para equipe humana
// Chamado por Alice via tool request_handoff(outcome, lead_name, lead_phone, handoff_reason, summary, callback_period)
// Substitui IGOR_05_Finalize_Handoff_v2 no mesmo ID (mfB7MGpCYSPQvRSx) via update_workflow

const IGOR_LABELS_ID = 'AJF7dhGrqJEXMLqz';

const startTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Start',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'chatwoot_conversation_id', type: 'number' },
          { name: 'chatwoot_contact_id', type: 'string' },
          { name: 'outcome', type: 'string' },
          { name: 'lead_name', type: 'string' },
          { name: 'lead_phone', type: 'string' },
          { name: 'handoff_reason', type: 'string' },
          { name: 'summary', type: 'string' },
          { name: 'callback_period', type: 'string' },
        ],
      },
    },
    position: [0, 400],
  },
  output: [{ chatwoot_conversation_id: 0, chatwoot_contact_id: '', outcome: '', lead_name: '', lead_phone: '', handoff_reason: '', summary: '', callback_period: '' }],
});

const loadSettingsQuery =
  "SELECT json_object_agg(key, value) AS settings_json FROM public.settings WHERE key IN ('ai_team_id','human_daytime_team_id','handoff_queue_team_id');";

const loadSettings = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Team IDs',
    parameters: {
      operation: 'executeQuery',
      query: loadSettingsQuery,
      options: {},
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [200, 400],
    alwaysOutputData: true,
  },
  output: [{ settings_json: {} }],
});

const computeBranchJs =
  "const inp = $('Start').first().json;\n" +
  "const sj = ($('Load Team IDs').first().json || {}).settings_json || {};\n" +
  'function asNum(v, fb) { if (v === null || v === undefined) return fb; const n = Number(v); return isFinite(n) ? n : fb; }\n' +
  "const aiTeamId = asNum(sj.ai_team_id, 3);\n" +
  "const humanTeamId = asNum(sj.human_daytime_team_id, 1);\n" +
  "const handoffTeamId = asNum(sj.handoff_queue_team_id, 4);\n" +
  "const outcomeRaw = String(inp.outcome || '').toLowerCase().trim();\n" +
  "const outcome = ['qualified','unqualified','compliance'].indexOf(outcomeRaw) !== -1 ? outcomeRaw : 'unqualified';\n" +
  "let ownerFlow, teamId, labels, noteHeader;\n" +
  "if (outcome === 'qualified') {\n" +
  "  ownerFlow = 'handoff_queue';\n" +
  "  teamId = handoffTeamId;\n" +
  "  labels = ['handoff_done','lead_qualificado','aguardando_humano_proximo_expediente'];\n" +
  "  noteHeader = '✅ Lead QUALIFICADO pela Alice (fora do expediente)';\n" +
  "} else if (outcome === 'compliance') {\n" +
  "  ownerFlow = 'compliance_hold';\n" +
  "  teamId = humanTeamId;\n" +
  "  labels = ['handoff_done','compliance_humano','ai_disabled'];\n" +
  "  noteHeader = '⚠️ COMPLIANCE: conteúdo clínico/sensível detectado';\n" +
  "} else {\n" +
  "  ownerFlow = 'ai_unqualified';\n" +
  "  teamId = handoffTeamId;\n" +
  "  labels = ['handoff_done','nao_qualificado_ia','ai_disabled'];\n" +
  "  noteHeader = 'ℹ️ Lead NÃO QUALIFICADO (Alice encerrou)';\n" +
  "}\n" +
  "const noteBody = noteHeader + '\\n\\n' +\n" +
  "  'Nome: ' + (inp.lead_name || '(não coletado)') + '\\n' +\n" +
  "  'Telefone: ' + (inp.lead_phone || '') + '\\n' +\n" +
  "  'Período para retorno: ' + (inp.callback_period || '(não coletado)') + '\\n' +\n" +
  "  'Motivo do handoff: ' + (inp.handoff_reason || '(não informado)') + '\\n\\n' +\n" +
  "  'Resumo: ' + (inp.summary || '(sem resumo)');\n" +
  "return [{ json: { outcome: outcome, owner_flow: ownerFlow, team_id: teamId, labels_to_add: labels, note_body: noteBody, chatwoot_conversation_id: inp.chatwoot_conversation_id, chatwoot_contact_id: inp.chatwoot_contact_id || '', lead_name: inp.lead_name || '', lead_phone: inp.lead_phone || '', handoff_reason: inp.handoff_reason || '', summary: inp.summary || '', callback_period: inp.callback_period || '' } }];";

const computeBranch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Branch',
    parameters: { mode: 'runOnceForAllItems', jsCode: computeBranchJs },
    position: [400, 400],
  },
  output: [{ outcome: '', owner_flow: '', team_id: 0, labels_to_add: [], note_body: '', chatwoot_conversation_id: 0, chatwoot_contact_id: '', lead_name: '', lead_phone: '', handoff_reason: '', summary: '', callback_period: '' }],
});

const updateConvQuery =
  "UPDATE public.conversations\n" +
  "SET ai_enabled = false,\n" +
  "    human_locked = true,\n" +
  "    state = 'handoff',\n" +
  "    owner_flow = $1::text,\n" +
  "    assigned_team_id = $2::int,\n" +
  "    updated_at = now()\n" +
  "WHERE chatwoot_conversation_id = $3::int\n" +
  "RETURNING id::text AS conversation_uuid, owner_flow, assigned_team_id;";

const updateConv = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE conversation handoff',
    parameters: {
      operation: 'executeQuery',
      query: updateConvQuery,
      options: {
        queryReplacement:
          "={{ (function(){ const b = $('Compute Branch').first().json; return [b.owner_flow, String(b.team_id), String(b.chatwoot_conversation_id)]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [600, 400],
  },
  output: [{ conversation_uuid: '', owner_flow: '', assigned_team_id: 0 }],
});

const postAssignTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Team',
    parameters: {
      method: 'POST',
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Compute Branch').first().json.chatwoot_conversation_id }}/assignments",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ team_id: Number($('Compute Branch').first().json.team_id) }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 15000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [800, 400],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const callLabels = node({
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
          chatwoot_conversation_id: "={{ $('Compute Branch').first().json.chatwoot_conversation_id }}",
          chatwoot_contact_id: "={{ $('Compute Branch').first().json.chatwoot_contact_id }}",
          labels_to_add: "={{ $('Compute Branch').first().json.labels_to_add }}",
          labels_to_remove: "={{ ['lead_novo','ai_after_hours'] }}",
          custom_attributes: "={{ ({ conversation: { automation_state: 'handoff_completed', owner_flow: $('Compute Branch').first().json.owner_flow, handoff_outcome: $('Compute Branch').first().json.outcome, lead_status: 'aguardando_humano', callback_period: $('Compute Branch').first().json.callback_period }, contact: { lead_name_collected: $('Compute Branch').first().json.lead_name } }) }}",
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
    position: [1000, 400],
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
      url: "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Compute Branch').first().json.chatwoot_conversation_id }}/messages",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ content: $('Compute Branch').first().json.note_body, message_type: 'outgoing', private: true, content_type: 'text' }) }}",
      options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 15000 },
    },
    credentials: { httpHeaderAuth: newCredential('igor_chatwoot_api') },
    position: [1200, 400],
    executeOnce: true,
  },
  output: [{ ok: true }],
});

const insertHandoffEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT handoff_complete',
    parameters: {
      operation: 'executeQuery',
      query:
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload) VALUES ('handoff_complete', NULLIF($1::text,''), NULLIF($2::text,'')::int, 'IGOR_Handoff', $3::jsonb);",
      options: {
        queryReplacement:
          "={{ (function(){ const b = $('Compute Branch').first().json; return [b.lead_phone, String(b.chatwoot_conversation_id||''), JSON.stringify({ outcome: b.outcome, owner_flow: b.owner_flow, team_id: b.team_id, lead_name: b.lead_name, handoff_reason: b.handoff_reason, callback_period: b.callback_period, summary: b.summary }) ]; })() }}",
      },
    },
    credentials: { postgres: newCredential('igor_supabase_postgres') },
    position: [1400, 400],
    executeOnce: true,
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
          { id: 'sr-ok', name: 'ok', value: true, type: 'boolean' },
          { id: 'sr-outcome', name: 'outcome', value: "={{ $('Compute Branch').first().json.outcome }}", type: 'string' },
          { id: 'sr-owner', name: 'owner_flow', value: "={{ $('Compute Branch').first().json.owner_flow }}", type: 'string' },
          { id: 'sr-team', name: 'team_id', value: "={{ $('Compute Branch').first().json.team_id }}", type: 'number' },
          { id: 'sr-msg', name: 'message_for_alice', value: "={{ 'Handoff registrado (' + $('Compute Branch').first().json.outcome + '). Envie a mensagem final ao lead e encerre.' }}", type: 'string' },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [1600, 400],
    executeOnce: true,
  },
  output: [{ ok: true, outcome: '', owner_flow: '', team_id: 0, message_for_alice: '' }],
});

export default workflow('igor-handoff', 'IGOR_Handoff')
  .add(startTrigger)
  .to(loadSettings)
  .to(computeBranch)
  .to(updateConv)
  .to(postAssignTeam)
  .to(callLabels)
  .to(postPrivateNote)
  .to(insertHandoffEvent)
  .to(successResponse);
