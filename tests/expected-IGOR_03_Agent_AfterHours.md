# Expected — IGOR_03_Agent_AfterHours

Mapeamento fixture → branch → tools chamadas → output esperado. Fonte de verdade: `docs/IMPLEMENTATION_PLAN.md §IGOR_03_Agent_AfterHours` + `docs/logica-fluxo-igor-receptivo-fora-expediente.md §§5, 6, 11, 12`.

Send-gate em todos os fixtures abaixo: ambiente padrão seguro
`ALLOW_REAL_WHATSAPP_SEND=false` + `IGOR_DRY_RUN=true` (default em
`docs/ENVIRONMENT.md`). Reply path resolve para `events('dry_run_send')` em vez
de POST Evolution `/message/sendText`. Para validar envio real, exportar
`ALLOW_REAL_WHATSAPP_SEND=true` e `IGOR_DRY_RUN=false` e re-executar.

LangChain agent é não-determinístico. Onde o assert depende do modelo decidir
chamar uma tool (ex.: `save_lead_partial`), o teste cobre o efeito colateral
mais robusto (`events('lead_saved_partial')` do AUX) em vez de prescrever o
texto exato da resposta.

---

## 1. `IGOR_03_first_message_text.json`

- **Entrada**: payload normalizado de IGOR_01, `normalized_text = "Oi, queria saber sobre consulta com o Dr. Igor"`, todas as `safety_flags` false, `should_handoff=false`.
- **Branch**: `agent` (normal conversational).
- **Tools potencialmente chamadas pela LLM**: `update_conversation_state` (collecting_name), `save_lead_partial` (com phone só, name a coletar).
- **Output do agent**: saudação Alice + apresentação + aviso de fora-de-expediente + pergunta de nome (vide spec §12.1).
- **Reply path**: Format AI Output gera N parágrafos → SplitOut → SplitInBatches → Presence composing → send-gate cai em dry → events('dry_run_send') por mensagem → Wait 2s → events('agent_response').
- **events emitidos**: `after_hours_started` (1), `agent_response` (>= 1), `dry_run_send` (>= 1).
- **events ausentes**: `agent_routed_to_handoff`, `whatsapp_sent` (default dry).
- **Asserts cobrindo**: presença de `after_hours_started`, `agent_response`, `dry_run_send`; ausência de `agent_routed_to_handoff`.

## 2. `IGOR_03_compliance_fast_path.json`

- **Entrada**: `should_handoff=true`, `safety_flags.clinical=true`, `safety_flags.sensitive_image=true`, `handoff_reason='documento_clinico_sensivel'`.
- **Branch**: `compliance` (fast-path pré-LLM).
- **Tools chamadas**: nenhuma (agent SKIPPED).
- **Sub-workflow chamado direto**: `IGOR_05_Finalize_Handoff` com `{chatwoot_conversation_id: '9302', chatwoot_contact_id: '8302', handoff_reason: 'documento_clinico_sensivel', summary: 'Mídia/conteúdo sensível detectado pelo normalizer.', owner_flow: 'after_hours', test_run_id}`.
- **Output**: `{ok: true, branch: 'compliance', messages_sent: 0, mode: 'compliance'}`.
- **events emitidos**: `agent_routed_to_handoff` (1, com `handoff_reason` e `safety_flags` preservados); `handoff_complete` (1, via IGOR_05 down-call); `dry_run_send` ou `whatsapp_sent` da IGOR_05 (mensagem final ao lead, no escopo do IGOR_05 logger).
- **events ausentes**: `after_hours_started`, `agent_response` (agent foi pulado).

## 3. `IGOR_03_collecting_name_response.json`

- **Entrada**: `normalized_text = "Meu nome é Ana Carolina"`.
- **Branch**: `agent`.
- **Tools esperadas**: `save_lead_partial` ({phone, source='inbound_after_hours', external_id=phone, kommo_data:{name:'Ana Carolina'}}), `update_conversation_state` (collecting_name → quick_qualification).
- **Output do agent**: confirma o nome + transição para pergunta de objetivo (spec §12.2).
- **Reply path**: dry-run → events('dry_run_send').
- **events emitidos**: `after_hours_started`, `agent_response`, `dry_run_send`, `lead_saved_partial` (do AUX).

## 4. `IGOR_03_collecting_objective.json`

- **Entrada**: `normalized_text = "Quero emagrecer e entender se ele acompanha com exames de rotina"`.
- **Branch**: `agent`.
- **Tools esperadas**: `save_lead_partial` ({objective:'emagrecimento'}), `update_conversation_state` (quick_qualification → collecting_callback_time).
- **Output do agent**: reconhece o objetivo, sem prometer resultado, pergunta período de retorno (spec §12.3).
- **events emitidos**: `after_hours_started`, `agent_response`, `dry_run_send`, `lead_saved_partial` com `lead.objective` populado.

## 5. `IGOR_03_collecting_callback.json`

- **Entrada**: `normalized_text = "Pode ser amanhã pela manhã"`.
- **Branch**: `agent`.
- **Tools esperadas**: `save_lead_partial` ({callback_period:'amanhã pela manhã'}), `update_conversation_state` (collecting_callback_time → handoff_pending), eventualmente `set_label_and_attr` (callback_solicitado).
- **Output do agent**: confirma o período e pode disparar `request_handoff` (se entender que já tem name + objective + callback).
- **events emitidos**: `after_hours_started`, `agent_response`, `dry_run_send`, `lead_saved_partial` com `lead.callback_period` populado.

## 6. `IGOR_03_handoff_ready.json`

- **Entrada**: `normalized_text = "Sou a Ana, quero emagrecer com acompanhamento e prefiro falar amanhã de manhã"` — TRÊS campos juntos.
- **Branch**: `agent`.
- **Tools esperadas**: `save_lead_partial` (com name+objective+callback_period), `update_conversation_state` (handoff_pending), `request_handoff` (chama IGOR_05).
- **Output do agent**: mensagem final ao lead anunciando que a equipe assume (spec §12.4).
- **events emitidos**: `after_hours_started`, `agent_response`, `dry_run_send`, `lead_saved_partial`, `handoff_complete` (via IGOR_05 down-call). Em ambiente real, `whatsapp_sent` em vez de `dry_run_send`.

## 7. `IGOR_03_dry_run_mode.json`

- **Entrada**: payload comum + bloco `_env_overrides_for_documentation_only` reforçando default seguro.
- **Branch**: `agent`.
- **Reply path**: send-gate verifica `_should_send_real` (`$env.ALLOW_REAL_WHATSAPP_SEND === 'true' AND $env.IGOR_DRY_RUN !== 'true'`). Default seguro → branch dry.
- **events emitidos**: `dry_run_send` (>= 1, com `mode='dry'`, `reason` preservado, `origin_workflow='IGOR_03_Agent_AfterHours'`).
- **events ausentes**: `whatsapp_sent` no escopo de IGOR_03.

---

## Branch-comportamento — resumo

| Fixture | Branch | Agent ran? | IGOR_05 called? | events emitidos no escopo IGOR_03 |
|---|---|---|---|---|
| first_message_text | agent | sim | não | after_hours_started + agent_response + dry_run_send |
| compliance_fast_path | compliance | NÃO | sim direto (pré-LLM) | agent_routed_to_handoff + handoff_complete (de IGOR_05) |
| collecting_name_response | agent | sim | (tool opcional) | after_hours_started + agent_response + dry_run_send + lead_saved_partial |
| collecting_objective | agent | sim | (tool opcional) | + lead_saved_partial (objective set) |
| collecting_callback | agent | sim | (tool opcional) | + lead_saved_partial (callback_period set) |
| handoff_ready | agent | sim | via tool request_handoff | + handoff_complete (de IGOR_05) |
| dry_run_mode | agent | sim | não | dry_run_send com mode='dry' |
