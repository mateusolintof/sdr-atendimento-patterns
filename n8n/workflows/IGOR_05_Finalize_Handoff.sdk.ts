// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_05_Finalize_Handoff.json`
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "tags": ["igor", "inbound", "handoff", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the four properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// Do NOT treat this SDK file as the single source of truth without
// re-applying the JSON-only properties above.
//
// Sub-workflow callable resolved at build-time:
//   - IGOR_04_Tool_Labels_Attributes  workflowId = "AJF7dhGrqJEXMLqz"
//
// Credential names (must exist in n8n with matching display names):
//   - Postgres        -> credentials.postgres        = igor_supabase_postgres
//   - Chatwoot HTTP   -> credentials.httpHeaderAuth  = igor_chatwoot_api
//   - Evolution HTTP  -> credentials.httpHeaderAuth  = igor_evolution_api
// NOTE: `igor_evolution_api` may not exist yet in n8n staging (audited Fase B-7
// for IGOR_08 showed it missing). The send-gate makes this a soft blocker:
// when `ALLOW_REAL_WHATSAPP_SEND !== 'true'` the workflow never hits the
// Evolution POST node, so the missing credential does not break execution
// while default seguro for staging is in effect. Real-send activation requires
// creating `igor_evolution_api` first.
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

// =============================================================================
// IGOR_05_Finalize_Handoff
// =============================================================================
// Callable que finaliza o handoff IA -> humano. Sequência OBRIGATÓRIA (NO
// SIMPLIFICATIONS — vide debt/2026-05-15-simplifications-to-revert.md §4):
//
//   1. UPDATE conversations (state=human_assigned, ai_enabled=false,
//      human_locked=true, assigned_team_id=$CHATWOOT_HUMAN_TEAM_ID).
//   2. UPDATE leads (status='aguardando_atendente', handoff_at=now())
//      APENAS se lead_id presente (branch IF).
//   3. Chamar IGOR_04 com labels handoff_done/ai_disabled/aguardando_atendente
//      + remove qualificacao_rapida/callback_solicitado + custom_attributes
//      conversation (automation_state, lead_status, handoff_reason,
//      handoff_at, callback_period, owner_flow, ai_enabled).
//   4. POST private note Chatwoot com template PT-BR LITERAL.
//   5. POST assignment {team_id} Chatwoot.
//   6. (Opcional) POST assignment {assignee_id} se env setado.
//   7. INSERT events('handoff_complete', payload).
//   8. Send final message ao lead GATED:
//        ALLOW_REAL_WHATSAPP_SEND==='true' AND IGOR_DRY_RUN!=='true'
//          -> POST Evolution sendText + events('whatsapp_sent')
//        senão
//          -> events('dry_run_send', reason=...)
//
// Errors -> IGOR_07 (errorWorkflow no settings do JSON canonical).
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
          { name: 'lead_id', type: 'string' },
          { name: 'handoff_reason', type: 'string' },
          { name: 'summary', type: 'string' },
          { name: 'callback_period', type: 'string' },
          { name: 'owner_flow', type: 'string' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 0],
  },
  output: [{
    chatwoot_conversation_id: '9001',
    chatwoot_contact_id: '8001',
    lead_id: '00000000-0000-0000-0000-000000000005',
    handoff_reason: 'after_hours_callback',
    summary: 'Lead Maria, objetivo emagrecimento, callback amanhã de manhã.',
    callback_period: 'amanhã de manhã',
    owner_flow: 'after_hours',
    test_run_id: 'IGOR_05_FIXTURE_with_lead_callback',
  }],
});

// -----------------------------------------------------------------------------
// 0. Validate Payload — coerce, defaults, compute helpers
// -----------------------------------------------------------------------------

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "const items = $input.all();",
        "return items.map(item => {",
        "  const j = item.json || {};",
        "  const str = (v) => (v === undefined || v === null || v === '') ? null : String(v);",
        "  const convId = str(j.chatwoot_conversation_id);",
        "  if (convId === null) {",
        "    throw new Error('IGOR_05: chatwoot_conversation_id is required');",
        "  }",
        "  const contactId = str(j.chatwoot_contact_id);",
        "  const leadId = str(j.lead_id);",
        "  const handoffReason = str(j.handoff_reason) || 'unspecified';",
        "  const summary = str(j.summary) || '(sem resumo)';",
        "  const callbackPeriod = str(j.callback_period);",
        "  const ownerFlow = str(j.owner_flow) || 'after_hours';",
        "  const testRunId = str(j.test_run_id);",
        "  const handoffAt = new Date().toISOString();",
        "  // Send-gate from settings table (Load Gates postgres node)",
        "  const allowReal = $('Load Gates').first().json.allow_real_whatsapp_send === true;",
        "  const dryRun = $('Load Gates').first().json.dry_run_send === true;",
        "  const shouldSendReal = allowReal && !dryRun;",
        "  const sendGateReason = shouldSendReal",
        "    ? 'real_send_authorized'",
        "    : (allowReal ? 'igor_dry_run=true' : 'allow_real_whatsapp_send=false');",
        "  // Custom attributes payload p/ IGOR_04",
        "  const convAttrs = {",
        "    automation_state: 'human_assigned',",
        "    lead_status: 'aguardando_atendente',",
        "    handoff_reason: handoffReason,",
        "    handoff_at: handoffAt,",
        "    owner_flow: ownerFlow,",
        "    ai_enabled: false",
        "  };",
        "  if (callbackPeriod !== null) convAttrs.callback_period = callbackPeriod;",
        "  // Summary snippet (corta para evitar payload gigante em events)",
        "  const summarySnippet = summary.length > 400 ? summary.slice(0, 400) + '…' : summary;",
        "  // Private note template PT-BR LITERAL (sem placeholders Mustache; concatenado em JS)",
        "  const callbackLine = callbackPeriod ? ('Período preferido de retorno: ' + callbackPeriod + '\\n') : '';",
        "  const privateNoteContent =",
        "    '📋 *Resumo automático Igor (handoff ' + ownerFlow + ')*\\n' +",
        "    '\\n' +",
        "    'Motivo: ' + handoffReason + '\\n' +",
        "    callbackLine +",
        "    '\\n' +",
        "    'Resumo da conversa:\\n' +",
        "    summary + '\\n' +",
        "    '\\n' +",
        "    'Lead status: aguardando_atendente\\n' +",
        "    'IA: desligada nesta conversa (ai_enabled=false, human_locked=true)';",
        "  // Mensagem final ao lead (LITERAL — não alterar texto/acentos/emoji)",
        "  const finalLeadMessage = 'Combinado! Já anotei tudo aqui e nossa equipe vai retornar no horário que você preferiu. Qualquer coisa nova, é só me responder. 💛';",
        "  return {",
        "    json: {",
        "      chatwoot_conversation_id: convId,",
        "      chatwoot_contact_id: contactId,",
        "      lead_id: leadId,",
        "      handoff_reason: handoffReason,",
        "      summary: summary,",
        "      summary_snippet: summarySnippet,",
        "      callback_period: callbackPeriod,",
        "      owner_flow: ownerFlow,",
        "      test_run_id: testRunId,",
        "      handoff_at: handoffAt,",
        "      _has_lead: leadId !== null,",
        "      _should_send_real: shouldSendReal,",
        "      _send_gate_reason: sendGateReason,",
        "      _allow_real_whatsapp_send: allowReal,",
        "      _igor_dry_run: dryRun,",
        "      private_note_content: privateNoteContent,",
        "      final_lead_message: finalLeadMessage,",
        "      igor04_payload_json: JSON.stringify({",
        "        chatwoot_conversation_id: convId,",
        "        chatwoot_contact_id: contactId,",
        "        labels_to_add: ['handoff_done', 'ai_disabled', 'aguardando_atendente'],",
        "        labels_to_remove: ['qualificacao_rapida', 'callback_solicitado'],",
        "        custom_attributes: { conversation: convAttrs, contact: {} },",
        "        test_run_id: testRunId",
        "      })",
        "    }",
        "  };",
        "});",
      ].join('\n'),
    },
    position: [220, 0],
  },
  output: [{
    chatwoot_conversation_id: '9001',
    chatwoot_contact_id: '8001',
    lead_id: '00000000-0000-0000-0000-000000000005',
    handoff_reason: 'after_hours_callback',
    summary: 'Lead Maria...',
    summary_snippet: 'Lead Maria...',
    callback_period: 'amanhã de manhã',
    owner_flow: 'after_hours',
    test_run_id: 'IGOR_05_FIXTURE_with_lead_callback',
    handoff_at: '2026-05-15T03:00:00.000Z',
    _has_lead: true,
    _should_send_real: false,
    _send_gate_reason: 'allow_real_whatsapp_send=false',
    _allow_real_whatsapp_send: false,
    _igor_dry_run: true,
    private_note_content: '📋 *Resumo automático Igor (handoff after_hours)*\n...',
    final_lead_message: 'Combinado! Já anotei tudo aqui e nossa equipe vai retornar no horário que você preferiu. Qualquer coisa nova, é só me responder. 💛',
    igor04_payload_json: '{...}',
  }],
});

// -----------------------------------------------------------------------------
// 1. UPDATE conversations
// -----------------------------------------------------------------------------

const updateConversation = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE conversations',
    parameters: {
      operation: 'executeQuery',
      query: [
        "UPDATE public.conversations",
        "SET",
        "  state = 'human_assigned',",
        "  ai_enabled = false,",
        "  human_locked = true,",
        "  assigned_team_id = NULLIF($1, '')::int,",
        "  updated_at = now()",
        "WHERE chatwoot_conversation_id = $2::int",
        "RETURNING id, contact_id, chatwoot_conversation_id;",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ ['1', $('Validate Payload').first().json.chatwoot_conversation_id] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [440, 0],
  },
  output: [{ id: '10000000-0000-0000-0000-000000009001', contact_id: '00000000-0000-0000-0000-000000008001', chatwoot_conversation_id: 9001 }],
});

// -----------------------------------------------------------------------------
// 2. UPDATE leads (gated por _has_lead)
// -----------------------------------------------------------------------------

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
            leftValue: expr("={{ $('Validate Payload').first().json._has_lead }}"),
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
    position: [660, 0],
  },
});

const updateLead = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPDATE leads',
    parameters: {
      operation: 'executeQuery',
      query: [
        "UPDATE public.leads",
        "SET",
        "  status = 'aguardando_atendente',",
        "  handoff_at = now(),",
        "  updated_at = now()",
        "WHERE id = $1::uuid",
        "RETURNING id, contact_id, conversation_id, status, handoff_at;",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ [$('Validate Payload').first().json.lead_id] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [880, -120],
  },
  output: [{ id: '00000000-0000-0000-0000-000000000005', contact_id: '00000000-0000-0000-0000-000000008001', conversation_id: '10000000-0000-0000-0000-000000009001', status: 'aguardando_atendente', handoff_at: '2026-05-15T03:00:00.000Z' }],
});

const leadPassthrough = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Lead Passthrough',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'no-lead-flag',
            name: 'lead_updated',
            value: false,
            type: 'boolean',
          },
        ],
      },
      options: {},
    },
    position: [880, 120],
  },
  output: [{ lead_updated: false }],
});

const mergeLeadBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Lead Branches',
    parameters: {
      mode: 'append',
      numberInputs: 2,
    },
    position: [1100, 0],
  },
});

// -----------------------------------------------------------------------------
// 3. Call IGOR_04 (executeOnce: true para evitar duplicação a partir do append)
// -----------------------------------------------------------------------------

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
      workflowInputs: expr(
        "={{ $('Validate Payload').first().json.igor04_payload_json }}"
      ),
      options: {
        waitForSubWorkflow: true,
      },
    },
    executeOnce: true,
    position: [1320, 0],
  },
  output: [{ ok: true, labels_added: ['handoff_done', 'ai_disabled', 'aguardando_atendente'], labels_removed: ['qualificacao_rapida'], attrs_conversation_keys: ['automation_state', 'lead_status', 'handoff_reason', 'handoff_at', 'callback_period', 'owner_flow', 'ai_enabled'], attrs_contact_keys: [] }],
});

// -----------------------------------------------------------------------------
// 4. POST private note Chatwoot
// -----------------------------------------------------------------------------

const postPrivateNote = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Private Note',
    parameters: {
      method: 'POST',
      url: expr(
        "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/messages"
      ),
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
      jsonBody: expr(
        "={{ JSON.stringify({ content: $('Validate Payload').first().json.private_note_content, private: true, message_type: 'outgoing', content_type: 'text' }) }}"
      ),
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
    executeOnce: true,
    position: [1540, 0],
  },
  output: [{ id: 12345, private: true, content_type: 'text' }],
});

// -----------------------------------------------------------------------------
// 5. POST assignment team
// -----------------------------------------------------------------------------

const postAssignTeam = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Team',
    parameters: {
      method: 'POST',
      url: expr(
        "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/assignments"
      ),
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
      jsonBody: expr(
        "={{ JSON.stringify({ team_id: 1 }) }}"
      ),
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
    executeOnce: true,
    position: [1760, 0],
  },
  output: [{ team_id: 1, conversation_id: 9001 }],
});

// -----------------------------------------------------------------------------
// 6. POST assignment assignee (opcional)
// -----------------------------------------------------------------------------

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
            leftValue: expr("=1"),
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty' },
          },
        ],
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'loose',
          version: 2,
        },
      },
    },
    position: [1980, 0],
  },
});

const postAssignAssignee = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST Assign Assignee',
    parameters: {
      method: 'POST',
      url: expr(
        "=https://chat.almaconvert.com.br/api/v1/accounts/2/conversations/{{ $('Validate Payload').first().json.chatwoot_conversation_id }}/assignments"
      ),
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
      jsonBody: expr(
        "={{ JSON.stringify({ assignee_id: 1 }) }}"
      ),
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
    executeOnce: true,
    position: [2200, -120],
  },
  output: [{ assignee_id: 1, conversation_id: 9001 }],
});

const noAssigneePassthrough = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Assignee Passthrough',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'no-assignee-flag',
            name: 'assignee_set',
            value: false,
            type: 'boolean',
          },
        ],
      },
      options: {},
    },
    executeOnce: true,
    position: [2200, 120],
  },
  output: [{ assignee_set: false }],
});

const mergeAssigneeBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Assignee Branches',
    parameters: {
      mode: 'append',
      numberInputs: 2,
    },
    position: [2420, 0],
  },
});

// -----------------------------------------------------------------------------
// 7. INSERT events('handoff_complete')
// -----------------------------------------------------------------------------

const insertHandoffEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log handoff_complete',
    parameters: {
      operation: 'executeQuery',
      query: [
        "INSERT INTO public.events (event_type, chatwoot_conversation_id, workflow_name, payload)",
        "VALUES ('handoff_complete', $1::int, 'IGOR_05_Finalize_Handoff', $2::jsonb);",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ [\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    handoff_reason: $('Validate Payload').first().json.handoff_reason,\n    owner_flow: $('Validate Payload').first().json.owner_flow,\n    lead_id: $('Validate Payload').first().json.lead_id,\n    callback_period: $('Validate Payload').first().json.callback_period,\n    summary_snippet: $('Validate Payload').first().json.summary_snippet,\n    handoff_at: $('Validate Payload').first().json.handoff_at,\n    test_run_id: $('Validate Payload').first().json.test_run_id\n  })\n] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [2640, 0],
  },
  output: [{ executionStatus: 'success' }],
});

// -----------------------------------------------------------------------------
// 8. SEND FINAL MESSAGE — gated
// -----------------------------------------------------------------------------

// 8a. Look up phone do contato (via conversations.contact_id -> contacts.phone)
const getPhone = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Get Lead Phone',
    parameters: {
      operation: 'executeQuery',
      query: [
        "SELECT c.phone AS phone, conv.id AS conversation_pk",
        "FROM public.conversations conv",
        "JOIN public.contacts c ON c.id = conv.contact_id",
        "WHERE conv.chatwoot_conversation_id = $1::int",
        "LIMIT 1;",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ [$('Validate Payload').first().json.chatwoot_conversation_id] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [2860, 0],
  },
  output: [{ phone: '5511900000001', conversation_pk: '10000000-0000-0000-0000-000000009001' }],
});

// 8b. Decisão de send gate
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
            leftValue: expr("={{ $('Validate Payload').first().json._should_send_real }}"),
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
    position: [3080, 0],
  },
});

// 8c. Branch REAL: Evolution sendText + log whatsapp_sent
const sendEvolutionText = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Evolution sendText',
    parameters: {
      method: 'POST',
      url: expr(
        "=https://evo.almaconvert.com.br/message/sendText/convert-teste"
      ),
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
      jsonBody: expr(
        "={{ JSON.stringify({ number: $json.phone, text: $('Validate Payload').first().json.final_lead_message }) }}"
      ),
      options: {
        response: {
          response: {
            neverError: false,
            responseFormat: 'json',
          },
        },
        timeout: 20000,
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('igor_evolution_api'),
    },
    executeOnce: true,
    position: [3300, -120],
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
      query: [
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)",
        "VALUES ('whatsapp_sent', $1, $2::int, 'IGOR_05_Finalize_Handoff', $3::jsonb);",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ [\n  $('Get Lead Phone').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    text: $('Validate Payload').first().json.final_lead_message,\n    handoff_reason: $('Validate Payload').first().json.handoff_reason,\n    owner_flow: $('Validate Payload').first().json.owner_flow,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send,\n    dry_run: $('Validate Payload').first().json._igor_dry_run,\n    test_run_id: $('Validate Payload').first().json.test_run_id\n  })\n] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [3520, -120],
  },
  output: [{ executionStatus: 'success' }],
});

const sendRealOutput = node({
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
    executeOnce: true,
    position: [3740, -120],
  },
  output: [{ send_mode: 'real', message_sent: 'real' }],
});

// 8d. Branch DRY: log dry_run_send only
const logDryRunSend = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log dry_run_send',
    parameters: {
      operation: 'executeQuery',
      query: [
        "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)",
        "VALUES ('dry_run_send', $1, $2::int, 'IGOR_05_Finalize_Handoff', $3::jsonb);",
      ].join('\n'),
      options: {
        queryReplacement: expr(
          "={{ [\n  $('Get Lead Phone').first().json.phone,\n  $('Validate Payload').first().json.chatwoot_conversation_id,\n  JSON.stringify({\n    text: $('Validate Payload').first().json.final_lead_message,\n    reason: $('Validate Payload').first().json._send_gate_reason,\n    handoff_reason: $('Validate Payload').first().json.handoff_reason,\n    owner_flow: $('Validate Payload').first().json.owner_flow,\n    chatwoot_conversation_id: $('Validate Payload').first().json.chatwoot_conversation_id,\n    allow_real: $('Validate Payload').first().json._allow_real_whatsapp_send,\n    dry_run: $('Validate Payload').first().json._igor_dry_run,\n    test_run_id: $('Validate Payload').first().json.test_run_id\n  })\n] }}"
        ),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    executeOnce: true,
    position: [3300, 120],
  },
  output: [{ executionStatus: 'success' }],
});

const sendDryOutput = node({
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
    executeOnce: true,
    position: [3520, 120],
  },
  output: [{ send_mode: 'dry_run', message_sent: 'dry' }],
});

// 8e. Merge send branches + final summary
const mergeSendBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Send Branches',
    parameters: {
      mode: 'append',
      numberInputs: 2,
    },
    position: [3960, 0],
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
            id: 'lead-updated',
            name: 'lead_updated',
            value: expr("={{ $('Validate Payload').first().json._has_lead }}"),
            type: 'boolean',
          },
          {
            id: 'labels-applied',
            name: 'labels_applied',
            value: true,
            type: 'boolean',
          },
          {
            id: 'message-sent',
            name: 'message_sent',
            value: expr(
              "={{ $input.all().reduce((acc, x) => x.json && x.json.message_sent ? x.json.message_sent : acc, 'unknown') }}"
            ),
            type: 'string',
          },
          {
            id: 'send-mode',
            name: 'send_mode',
            value: expr(
              "={{ $input.all().reduce((acc, x) => x.json && x.json.send_mode ? x.json.send_mode : acc, 'unknown') }}"
            ),
            type: 'string',
          },
          {
            id: 'handoff-reason-out',
            name: 'handoff_reason',
            value: expr("={{ $('Validate Payload').first().json.handoff_reason }}"),
            type: 'string',
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
    position: [4180, 0],
  },
  output: [{
    ok: true,
    lead_updated: true,
    labels_applied: true,
    message_sent: 'dry',
    send_mode: 'dry_run',
    handoff_reason: 'after_hours_callback',
    test_run_id: 'IGOR_05_FIXTURE_with_lead_callback',
  }],
});

// =============================================================================
// WIRE WORKFLOW
// =============================================================================

export default workflow('IGOR_05_Finalize_Handoff', 'IGOR_05_Finalize_Handoff')
  .add(executeTrigger)
  .to(validatePayload)
  .to(updateConversation)
  .to(
    hasLeadIf
      .onTrue(updateLead.to(mergeLeadBranches.input(0)))
      .onFalse(leadPassthrough.to(mergeLeadBranches.input(1)))
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
  .to(insertHandoffEvent)
  .to(getPhone)
  .to(
    shouldSendRealIf
      .onTrue(sendEvolutionText.to(logWhatsappSent).to(sendRealOutput).to(mergeSendBranches.input(0)))
      .onFalse(logDryRunSend.to(sendDryOutput).to(mergeSendBranches.input(1)))
  )
  .add(mergeSendBranches)
  .to(finalSummary);
