# Expected behavior — IGOR_03_Agent_AfterHours

## Papel no fluxo

Callable LangChain Agent que conversa com o lead fora do expediente. Recebe payload normalizado do IGOR_01 (ou trampoline em teste). Acolhe, qualifica em 3 perguntas (nome, objetivo principal, callback_period) e dispara `trigger_handoff` quando completo. Não envia WhatsApp diretamente — IGOR_05 cuida da mensagem final.

## Trigger e entrada

- `executeWorkflowTrigger` com `workflowInputs`:
  - `phone` (string)
  - `normalized_text` (string)
  - `chatwoot_conversation_id` (number)
  - `chatwoot_inbox_id` (number)
  - `chatwoot_contact_id` (number, nullable)
  - `safety_flags` (object: clinical, sensitive_image, unknown_media)
  - `should_handoff` (boolean)
  - `handoff_reason` (string, nullable)
  - `test_run_id` (string)

## Topologia

1. **Execute Workflow Trigger**
2. **Validate Payload** (Code) — coerce defaults; padroniza tipos.
3. **IF Should Handoff Compliance** — `should_handoff===true || safety_flags.clinical===true || safety_flags.sensitive_image===true || safety_flags.unknown_media===true`.
   - **true → fast-path compliance** (sem LLM):
     - **Log Routed to Handoff** → `events('agent_routed_to_handoff', workflow_name='IGOR_03_Agent_AfterHours')`.
     - **Call IGOR_05** (executeWorkflow id `xHorZFRZYAaklR1F`) com `_skip_chatwoot_calls=true`, `owner_flow='after_hours'`, `summary='Compliance handoff via IGOR_03'`, `handoff_reason` propagado (default `documento_clinico_sensivel`).
     - **Return Success**.
   - **false → branch agente**:
     - **AI Agent** (`@n8n/n8n-nodes-langchain.agent`) com system prompt PT-BR (Alice, atendente IA do Dr. Igor).
     - **OpenAI Model** (`@n8n/n8n-nodes-langchain.lmChatOpenAi`) modelo `gpt-5.4-mini`, temperature 0.3, credential `igor_openai`.
     - **Postgres Chat Memory** (`@n8n/n8n-nodes-langchain.memoryPostgresChat`) credential `igor_supabase_postgres`, sessionKey `after_hours_<phone>`, contextWindowLength 25.
     - 4 tools (toolWorkflow, conectadas via `ai_tool`):
       1. `set_label_and_attr` → IGOR_04 (`srZRMaFljJIKzyuQ`).
       2. `save_lead_partial` → IGOR_AUX_save_lead_partial (`hRogDlGsgQxGwnD8`).
       3. `update_conversation_state` → IGOR_AUX_update_conversation_state (`mFuRPrGGt7yWVqEw`).
       4. `trigger_handoff` → IGOR_05 (`xHorZFRZYAaklR1F`).
     - **Log Agent Response** → `events('agent_response')` com texto da resposta.
     - **Return Response**.

## System prompt (resumo)

Persona Alice, atendente IA do Instituto Dr. Igor, respondendo fora do horário comercial. Acolhe, coleta nome + objetivo + callback_period. Tom cordial PT-BR, 1-3 linhas. Sem diagnóstico, sem comentar exames/laudos/fotos do corpo (handoff direto), sem prometer resultado clínico. Chamar `trigger_handoff` apenas quando: a) 3 infos coletadas; b) compliance; c) lead pede humano.

## Guardrails determinísticos (Harness Engineering)

- A decisão de "responder ou não" não está com a LLM. O IF determinístico antes do agente decide.
- `safety_flags.clinical/sensitive_image/unknown_media === true` força handoff sem invocar LLM (zero custo, idempotente).
- O agente nunca envia WhatsApp diretamente — sempre via IGOR_05.
- Cada decisão importante é registrada em `events`.

## Smoke test (canônico)

`bash scripts/test-workflow.sh IGOR_03_Agent_AfterHours fixtures/agent-after-hours-compliance.json`

Fixture com `safety_flags.clinical=true` força o fast-path. Nenhuma chamada LLM. Asserts validados:

1. `events.event_type='agent_routed_to_handoff'` (IGOR_03 registrou a rota).
2. `events.event_type='handoff_complete'` com `handoff_reason='documento_clinico_sensivel'` (IGOR_05 finalizou).
3. `events.event_type='handoff_complete'` com `owner_flow='after_hours'` (origem correta).

## Happy path conversacional (manual, não automatizado no smoke)

Não rodado automaticamente para evitar custo e flakiness LLM. Para validar manualmente:
- Dispara fixture `evolution-text-after-hours.json` no IGOR_01 (que invoca IGOR_03 com `should_handoff=false`).
- LLM saúda, coleta nome → save_lead_partial, coleta objetivo → save_lead_partial + set_label_and_attr (qualificacao_rapida), coleta callback → save_lead_partial + set_label_and_attr (callback_solicitado) + trigger_handoff.
- IGOR_05 envia mensagem final (dry-run no log).

## Estado inicial

Workflow nasce **inativo** no JSON (`active: false`). Ativação requer aprovação `ALLOW_PRODUCTION_MUTATIONS=true`.

## errorWorkflow

`ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
