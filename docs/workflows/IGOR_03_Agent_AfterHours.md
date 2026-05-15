# IGOR_03_Agent_AfterHours

Agente conversacional Alice — fluxo receptivo fora de expediente. Workflow callable invocado pelo IGOR_01 quando a matriz determinística autoriza interação com o lead.

## Identidade

- **Workflow ID (n8n)**: `iQCVbe1P8dC0vhay`
- **URL**: `https://n8n.almaconvert.com.br/workflow/iQCVbe1P8dC0vhay`
- **Trigger**: `executeWorkflowTrigger` (callable). 10 inputs.
- **Settings**: `active: false`, `executionOrder: v1`, `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
- **Tags**: `igor`, `inbound`, `agent`, `langchain`, `fase-b-rebuild`.

## Contrato (de `docs/IMPLEMENTATION_PLAN.md §IGOR_03_Agent_AfterHours` + `docs/logica-fluxo-igor-receptivo-fora-expediente.md §§5, 6, 11, 12`)

- Entrada: payload normalizado de IGOR_01.
- Decisão pré-LLM: `should_handoff || safety_flags.{clinical|sensitive_image|payment_proof}` → COMPLIANCE FAST-PATH (pula agente, chama IGOR_05 direto).
- Comportamento conversacional Alice: saudação na primeira interação, coleta nome/objetivo_principal/callback_period, memória Postgres Chat (ctx 25), 4 tools wired.
- Saída: mensagem(ns) ao lead via Evolution sendText quando `ALLOW_REAL_WHATSAPP_SEND=true && IGOR_DRY_RUN=false`. Default seguro → `events('dry_run_send')`.
- Observabilidade: `after_hours_started`, `agent_response`, `agent_routed_to_handoff`, `whatsapp_sent`/`dry_run_send`.

## Sequência de nodes (26 no total)

1. `Execute Workflow Trigger` — callable, 10 campos: phone, msgId, chatwoot_conversation_id, chatwoot_contact_id, normalized_text, safety_flags, should_handoff, handoff_reason, fragments_count, test_run_id.
2. `Validate Payload` (code, runOnceForAllItems) — coerção + derivações:
   - `_is_compliance = shouldHandoff || clinical || sensitive_image || payment_proof`
   - `_allow_real_whatsapp_send` / `_igor_dry_run` / `_should_send_real` / `_send_gate_reason`
   - `session_key = after_hours_{phone}` (memory)
   - `igor05_compliance_payload_json` (pre-stringified para call IGOR_05 do compliance branch)
   - `handoff_reason` resolvido se ausente (default por tipo de safety_flag)
3. `Compliance Fast-Path?` (IF) — decide pelo `_is_compliance`.

### 3a. Compliance branch (onTrue)

4. `Log agent_routed_to_handoff` (postgres) — events('agent_routed_to_handoff') com handoff_reason, safety_flags, test_run_id.
5. `Call IGOR_05 (compliance)` (executeWorkflow `N31QcdrNVE5AOZdu`) — passa `{chatwoot_conversation_id, chatwoot_contact_id, handoff_reason, summary: 'Midia/conteudo sensivel detectado pelo normalizer.', owner_flow: 'after_hours', test_run_id}`. IGOR_05 cuida da private note + assignment + sendText final ao lead (gated).
6. `Compliance Output` (set) — `{ok:true, branch:'compliance', messages_sent:0, mode:'compliance', test_run_id}`.

### 3b. Agent branch (onFalse)

7. `Log after_hours_started` (postgres) — events('after_hours_started') com text_preview, fragments_count, session_key, test_run_id.
8. `Alice Agent` (`@n8n/n8n-nodes-langchain.agent` v3.1):
   - Model subnode: `@n8n/n8n-nodes-langchain.lmChatOpenAi` v1.3, model `gpt-5.4-mini`, temperature 0.4, reasoningEffort low, responseFormat text. Credencial: `igor_openai` (auto-wired).
   - Memory subnode: `@n8n/n8n-nodes-langchain.memoryPostgresChat` v1.4, sessionKey `={{ $('Validate Payload').first().json.session_key }}` (= `after_hours_{phone}`), tableName `n8n_chat_histories`, contextWindowLength 25. Credencial: `igor_supabase_postgres` (auto-wired).
   - Tools (4 `@n8n/n8n-nodes-langchain.toolWorkflow` v2.2):
     - **set_label_and_attr** → IGOR_04 (`AJF7dhGrqJEXMLqz`). Inputs: chatwoot_conversation_id, chatwoot_contact_id, labels_to_add (`$fromAI`), labels_to_remove (`$fromAI`), custom_attributes (`$fromAI`), test_run_id.
     - **save_lead_partial** → IGOR_AUX_save_lead_partial (`hRogDlGsgQxGwnD8`). Inputs: contact_id (`$fromAI`), phone, source=`inbound_after_hours`, external_id=phone, objective/city/callback_period/kommo_data (`$fromAI`), test_run_id.
     - **update_conversation_state** → IGOR_AUX_update_conversation_state (`mFuRPrGGt7yWVqEw`). Inputs: phone, chatwoot_conversation_id (Number), chatwoot_inbox_id (`$fromAI`), state (`$fromAI`), ai_enabled (`$fromAI`), human_locked (`$fromAI`), current_flow=`after_hours`, test_run_id.
     - **request_handoff** → IGOR_05 (`N31QcdrNVE5AOZdu`). Inputs: chatwoot_conversation_id, chatwoot_contact_id, lead_id (`$fromAI`), handoff_reason (`$fromAI`), summary (`$fromAI`), callback_period (`$fromAI`), owner_flow=`after_hours`, test_run_id.
   - System message: PT-BR literal (vide sub-seção abaixo).
   - User input: `={{ $('Validate Payload').first().json.normalized_text }}`.
   - maxIterations 6, enableStreaming false.
9. `Log agent_response (aggregated)` (postgres) — events('agent_response') com response_snippet, response_length, mode (real/dry), test_run_id.

### Reply path estruturado (steps 10-17)

10. `Format AI Output` (code) — split por `\n\n` ou `||` → array `messages` (máx 4 itens), `message_count`, `raw_output`.
11. `Split Messages` (splitOut) — `fieldToSplitOut: messages`, destinationFieldName: `message`. Resultado: N items cada com `{message}`.
12. `Loop Messages` (splitInBatches v3) — batchSize 1.
13. `Presence Composing` (HTTP POST Evolution `/chat/sendPresence/{instance}`) — body `{number, presence: 'composing', delay: clamp(800..3000, msg_length * 30)}`. `onError: continueRegularOutput` (best-effort, ignora se Evolution offline). Credencial httpHeaderAuth `igor_evolution_api` (a wirear manualmente — vide pendências abaixo).
14. `Send Real?` (IF) — gate em `_should_send_real`. true=real, false=dry.
15a. (real branch) `Evolution sendText` (HTTP POST Evolution `/message/sendText/{instance}`) → `Log whatsapp_sent` (postgres events) → `Wait 2s (real)` → `nextBatch(Loop Messages)`.
15b. (dry branch) `Log dry_run_send` (postgres events) → `Wait 2s (dry)` → `nextBatch(Loop Messages)`.
16. (onDone do Loop Messages) `Agent Output` (set) — `{ok:true, branch:'agent', messages_sent: N, mode: 'real'|'dry', test_run_id}`.

## System prompt Alice (LITERAL, PT-BR com acentos preservados — copie como está no node)

```
Você é Alice, assistente virtual do Instituto Dr. Igor. Atua no fluxo receptivo fora do expediente humano: acolhe o lead, adianta a qualificação mínima e transfere para a equipe humana retornar.

Personalidade obrigatória:
- Natural e conversacional, frases curtas em estilo WhatsApp.
- Uma pergunta por vez. Nunca mais de uma pergunta por mensagem.
- Tom acolhedor, seguro e profissional. Sem emoji. Sem caixa alta.
- Nunca usa termos internos: não diga "workflow", "lead", "lead_status", "label", "handoff", "IA", "automação", "prompt", "tool", "integração", "sistema".
- Não força venda. Não promete resultado clínico.

Conduta obrigatória:
- Informe, quando fizer sentido, que a equipe já encerrou o expediente e que você está adiantando o atendimento por aqui.
- Ajude de forma breve e direta.
- Se ainda não souber o nome do lead, pergunte o nome.
- Entenda o objetivo principal do lead (emagrecimento, performance, reposição hormonal, estética, saúde geral). Aceite o que ele disser; não force categoria.
- Solicite o melhor horário/período para a atendente retornar.
- Assim que tiver nome + objetivo + callback_period coletados, chame a tool request_handoff ANTES de mandar a mensagem final ao lead.
- Após chamar request_handoff, envie UMA mensagem curta avisando que a equipe assume e encerre sua atuação. Não continue conversando.

Conduta proibida:
- Não diagnostique. Não prescreva. Não interprete exames, laudos, prescrições, imagens do corpo ou documentos clínicos.
- Não solicite dados sensíveis desnecessários (CPF, RG, plano de saúde, histórico médico extenso, comprovantes financeiros).
- Não faça anamnese extensa. Apenas o necessário para a atendente continuar.
- Não simule disponibilidade real de agenda. Não diga que "marcou" consulta. Não confirme horário específico de atendimento.
- Não siga respondendo se a conversa estiver com ai_enabled=false ou se você já chamou request_handoff.
- Não invente preço, condição comercial, política ou disponibilidade que não esteja explicitamente configurada.

Campos mínimos da qualificação rápida (coletar e persistir via tools):
- nome (obrigatório se ausente; pode ser extraído da mensagem ou perguntado).
- objetivo_principal (obrigatório; aceitar fala natural do lead).
- callback_period (obrigatório; ex.: "amanhã pela manhã", "hoje à tarde", "qualquer horário após 18h").
- cidade (opcional, só se surgir naturalmente).

Sequência conversacional esperada (referência — adapte ao que o lead mandar):
1. Primeira mensagem do lead, sem nome conhecido: saudação curta + apresentação como Alice + aviso de fora do expediente + pergunta de nome.
   Exemplo: "Oi, tudo bem? Sou a Alice, assistente do Dr. Igor. A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui. Qual seu nome?"
2. Lead informa o nome: confirme curto e pergunte objetivo.
   Exemplo: "Perfeito, Ana. Pra eu deixar tudo certinho para a equipe, o que você está buscando hoje com o Dr. Igor?"
3. Lead informa o objetivo: acolha sem prometer resultado, pergunte período de retorno.
   Exemplo: "Entendi. O Dr. Igor trabalha com acompanhamento individualizado e a equipe consegue te explicar os próximos passos certinho. Qual o melhor período para a atendente te chamar: manhã ou tarde?"
4. Lead informa o período: chame request_handoff, depois mande mensagem final.
   Exemplo: "Combinado. Deixei registrado para a equipe te chamar amanhã de manhã pelo WhatsApp e continuar seu atendimento."

Condicionais conversacionais:
- Lead pergunta preço: você pode dizer que a equipe confirma as condições vigentes; se houver valor configurado pela política, mencione apenas como referência e redirecione para o callback.
- Lead pede agendamento direto: confirme que a equipe finaliza horários e pergunte o melhor período para a atendente chamá-lo.
- Lead pede para falar com humano: avise que vai encaminhar e pergunte o melhor período. Se insistir, chame request_handoff mesmo sem horário (handoff_reason="pedido_humano").
- Lead envia áudio: trate a transcrição já normalizada como texto comum.
- Lead envia exame, laudo ou imagem clínica: NÃO interprete. Avise que a equipe precisa analisar diretamente e chame request_handoff com handoff_reason="documento_clinico_sensivel".
- Lead diz que não quer seguir agora: agradeça curto, deixe o canal aberto, sem pressionar.

Tools disponíveis (quando chamar):
- save_lead_partial: chame TODA VEZ que extrair nome, objetivo_principal, cidade ou callback_period da mensagem do lead. Use external_id = telefone do lead (formato 55DDD9DDDDDDDD) e source = "inbound_after_hours". Preencha somente os campos que você identificou.
- update_conversation_state: reflete progresso. Use state="collecting_name" ao perguntar o nome, "quick_qualification" ao perguntar o objetivo, "collecting_callback_time" ao perguntar o período, "handoff_pending" quando estiver prestes a chamar request_handoff. Mantenha ai_enabled=true e human_locked=false até o handoff. current_flow sempre "after_hours".
- set_label_and_attr: aplica labels operacionais via Chatwoot. Adicione "qualificacao_rapida" após coletar nome + objetivo. Adicione "callback_solicitado" após coletar callback_period. Em compliance, adicione "compliance_hold". Nunca apague labels existentes — só use labels_to_remove para labels que você mesma aplicou.
- request_handoff: chame APENAS quando tiver nome + objetivo + callback_period coletados, OU imediatamente em compliance (documento clínico, imagem sensível, comprovante de pagamento, pedido explícito de humano). Sempre forneça handoff_reason e summary curto em PT-BR para a atendente.

Formato da resposta ao lead:
- Responda em PT-BR natural, no estilo WhatsApp.
- Se precisar mandar várias mensagens em sequência (ex.: saudação, contexto, pergunta), separe cada mensagem com uma linha em branco (parágrafo). O sistema vai disparar uma mensagem por parágrafo, com pausa entre elas. Não use bullets, listas numeradas ou markdown — apenas texto corrido.
- Mantenha cada parágrafo curto (1-2 frases). Total de no máximo 3 parágrafos por turno.
- Não inclua nada além do texto que o lead vai ver. Sem prefixos, sem assinaturas, sem "(resposta:)".
```

Tamanho do prompt: ~4500 caracteres (PT-BR com acentos). Está armazenado literal em `n8n/workflows/IGOR_03_Agent_AfterHours.json → nodes[name='Alice Agent'].parameters.options.systemMessage` e replicado em `n8n/workflows/IGOR_03_Agent_AfterHours.sdk.ts` (constante `aliceSystemPrompt`). Qualquer alteração precisa ser feita primeiro no spec (`docs/logica-fluxo-igor-receptivo-fora-expediente.md §§5, 6, 11, 12`) e depois sincronizada nos três lugares.

## Credenciais

| Cred name | Tipo n8n | Status | Nodes |
|---|---|---|---|
| `igor_supabase_postgres` | `postgres` | wired (auto) | Log agent_routed_to_handoff, Log after_hours_started, Postgres Chat Memory, Log agent_response, Log whatsapp_sent, Log dry_run_send |
| `igor_openai` | `openAiApi` | wired (auto) | OpenAI Chat Model (Alice) |
| `igor_evolution_api` | `httpHeaderAuth` | **NÃO wired** | Presence Composing, Evolution sendText |

`igor_evolution_api` está ausente no n8n staging — confirmado via inspeção das demais workflows (IGOR_05). Os dois HTTP nodes Evolution ficam "soft-blocker": quando `_should_send_real=false` (default seguro), eles não são invocados:

- `Presence Composing` tem `onError: continueRegularOutput` — falha silenciosa não bloqueia.
- `Evolution sendText` só roda na branch `Send Real?` true. Em dry, a branch false (`Log dry_run_send`) executa.

Para ativar envio real: criar credencial httpHeaderAuth `igor_evolution_api` com header `apikey: <EVOLUTION_API_KEY>` no n8n, vincular aos dois nodes via UI, exportar `ALLOW_REAL_WHATSAPP_SEND=true` + `IGOR_DRY_RUN=false`.

## Sub-workflows callable

| Workflow | ID | Chamada por | Tipo |
|---|---|---|---|
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | tool `set_label_and_attr` | langchain tool |
| `IGOR_05_Finalize_Handoff` | `N31QcdrNVE5AOZdu` | Compliance fast-path (executeWorkflow) + tool `request_handoff` | direct + tool |
| `IGOR_AUX_save_lead_partial` | `hRogDlGsgQxGwnD8` | tool `save_lead_partial` | langchain tool |
| `IGOR_AUX_update_conversation_state` | `mFuRPrGGt7yWVqEw` | tool `update_conversation_state` | langchain tool |
| `IGOR_07_Error_Logger` | `ZrsbaSTlW5bqMEaS` | `settings.errorWorkflow` | error handler |

## Send-gate semantics

- `ALLOW_REAL_WHATSAPP_SEND=false` (qualquer caso) → dry_run.
- `IGOR_DRY_RUN=true` (qualquer caso) → dry_run.
- Real só executa quando `ALLOW_REAL_WHATSAPP_SEND=true` E `IGOR_DRY_RUN=false`.
- `_send_gate_reason` registrado em todos os events para auditoria: `'allow_real_true_and_dry_run_false' | 'allow_real_whatsapp_send_not_true' | 'igor_dry_run_true'`.

## events emitidos

| event_type | Quando | Payload |
|---|---|---|
| `after_hours_started` | Início do agent branch | msg_id, fragments_count, session_key, text_preview, test_run_id, origin_workflow |
| `agent_response` | Após Alice retornar | response_snippet (até 480 chars), response_length, mode, session_key, test_run_id |
| `agent_routed_to_handoff` | Compliance branch | handoff_reason, safety_flags, fragments_count, test_run_id |
| `whatsapp_sent` | Por mensagem enviada real | message_snippet, message_length, allow_real, dry_run, mode='real', test_run_id |
| `dry_run_send` | Por mensagem em dry | message_snippet, message_length, reason, allow_real, dry_run, mode='dry', test_run_id |
| `handoff_complete` | Via IGOR_05 down-call (compliance ou tool request_handoff) | (vide IGOR_05 doc) |

Tools AUX emitem seus próprios events (`lead_saved_partial`, `conversation_state_updated`) — vide docs respectivas.

## Riscos / concerns

- **LangChain agent não-determinístico**: os asserts validam efeitos colaterais robustos (events emitidos, branch percorrida) em vez do texto exato. Em smoke tests, o modelo pode escolher caminhos diferentes (ex.: chamar handoff cedo demais). Mitigação: system prompt explícito + ferramentas com descriptions claras.
- **Tool call failure**: se uma tool retornar erro, o agent pode tentar de novo (maxIterations=6) e eventualmente responder mesmo sem persistir. Logs em events permitem reconciliação.
- **Message split heuristic**: `Format AI Output` divide por `\n\n` ou `||` e limita a 4 mensagens. Se Alice mandar tudo em parágrafo único, sai como 1 mensagem. Se mandar texto muito longo, é truncado em 4 partes. Prompt orienta a manter no máximo 3 parágrafos.
- **Memória Postgres Chat**: sessionKey é `after_hours_{phone}`. Mesmo lead retornando dias depois mantém histórico (boa para continuidade). Para resetar: DELETE FROM n8n_chat_histories WHERE session_id = 'after_hours_<phone>'.
- **Compliance fast-path pode disparar antes do log de after_hours_started**: por design — compliance pula a conversa inteira. Asserts cobrem ambos os comportamentos.
- **igor_evolution_api não existe em staging**: send_gate default seguro evita falha. Para ativação real, é necessária ação manual.

## Fixtures e asserts

- 7 fixtures: `fixtures/IGOR_03_*.json` (first_message_text, compliance_fast_path, collecting_name_response, collecting_objective, collecting_callback, handoff_ready, dry_run_mode).
- Asserts: `tests/asserts-IGOR_03_Agent_AfterHours.sql` cobrindo events + persistência lead via AUX.
- Expected: `tests/expected-IGOR_03_Agent_AfterHours.md` mapeando fixture → branch → tools → output.

## SOURCE OF TRUTH

- **Canonical**: `n8n/workflows/IGOR_03_Agent_AfterHours.json` (exportado via n8n REST API após PUT settings + PATCH tags).
- **SDK build**: `n8n/workflows/IGOR_03_Agent_AfterHours.sdk.ts` (gera estrutura inicial; perde `active`, `settings.errorWorkflow`, `settings.executionOrder`, `tags` quando regenerado — re-aplicar via REST).
- **Spec funcional**: `docs/logica-fluxo-igor-receptivo-fora-expediente.md §§5-12`.
- **Contrato**: `docs/IMPLEMENTATION_PLAN.md §IGOR_03_Agent_AfterHours`.
- **Debt reverted**: `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md §6` (happy path + reply path agora completos).

## Próximas etapas (Fase C)

1. Smoke test individual: executar IGOR_03 com cada uma das 7 fixtures via MCP `execute_workflow`. Rodar asserts SQL.
2. Smoke test integrado: IGOR_01 → IGOR_03 (verificar handoff payload normalizado completo).
3. Flow review subagent comparando JSON canonical com spec §§5-12.
4. Ativação produção: ativar workflow + criar credencial `igor_evolution_api` + setar `ALLOW_REAL_WHATSAPP_SEND=true` + `IGOR_DRY_RUN=false`.
