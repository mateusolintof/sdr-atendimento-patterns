# Dívida técnica — simplificações unilaterais a reverter

**Data**: 2026-05-15
**Decisão do usuário**: resetar Wave 2/3/4 e refazer todos os workflows simplificados com regra `NO SIMPLIFICATIONS` (vide `~/.claude/projects/.../memory/feedback_nunca_simplificar_e_asx_e_referencia.md`).

## Causa raiz

Em briefs de subagentes (T3b, T3c, T4a, T5, T6a, T6b), eu (agente orquestrador) introduzi linguagem de "simplificação pragmática para v1" / "stub e refator depois" **sem autorização do usuário** e **sem base no plano funcional** (`docs/logica-fluxo-igor-receptivo-fora-expediente.md`, `docs/logica-fluxo-igor-agente-ativo-promocao.md`) nem no `docs/IMPLEMENTATION_PLAN.md`. Resultado: 6 workflows commitados em main com gaps funcionais que quebram a lógica desenhada.

## Inventário de simplificações

### 1. IGOR_01_Inbound_AfterHours — commit `3a17bbc`

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_01` + spec):
- Matriz de bloqueio determinístico (12 condições em ordem).
- Lookup `contacts.do_not_contact = true` → bloqueia + label `optout`.
- Lookup `conversations.human_locked OR ai_enabled=false` → bloqueia.
- Lookup `campaign_contacts.status IN ('sent','delivered','replied','interested')` → roteia para IGOR_12.
- Verificar feriado via `settings.holidays`.
- **Redis lock** `igor:lock:inbound:{phone}` com `SET NX EX 30`. Falha → **RPUSH `igor:batch:{phone}`** e sair (mensagens chegam em sequência, mas só a última processa).
- Chamar IGOR_02 quando `messageType ≠ text`.
- Chamar IGOR_03 quando passar todos os bloqueios.
- Check `settings.workflows_enabled.IGOR_01`.

**O que foi entregue (simplificado)**:
- Matriz determinística parcial: só fromMe, ai_enabled_global, invalid_phone, within_hours, conversation_locked.
- ❌ Sem Redis lock + batching (consequência: agente trata cada fragmento de mensagem como interação nova → robô burro).
- ❌ Sem call IGOR_02 (mídia não é normalizada antes do agente).
- ❌ Sem call IGOR_03 (apenas grava `inbound_routed` sem invocar agente).
- ❌ Sem lookup `contacts.do_not_contact`.
- ❌ Sem lookup `campaign_contacts` (roteamento para campanha não acontece).
- ❌ Sem check `workflows_enabled.IGOR_01` (workflow roda mesmo se flag false).
- ❌ Sem check feriado.

**Onde foi declarado como TODO**:
- `docs/workflows/IGOR_01_Inbound_AfterHours.md` seção "TODOs v2".

**Impacto funcional**: workflow não cumpre a função de orquestração de entrada. Praticamente um passthrough com bloqueios mínimos.

### 2. IGOR_02_Media_Normalizer — commit `a2eddfa`

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_02`):
- Branch audio: baixar mídia → transcrever via **`gpt-4o-transcribe`** (OpenAI) → `normalized_text = transcrição`, `audio_transcribed = true`.
- Branch image: descrever via **`gpt-4o-mini` visão** com prompt PT-BR restritivo; classificar `clinical`/`sensitive_image`; `should_handoff=true` se clínica detectada.
- Branch document: heurística regex + análise de conteúdo.
- Branch text: passthrough.
- Branch unknown: `should_handoff='midia_desconhecida'`.

**O que foi entregue**:
- ✅ Branch document: heurística regex completa.
- ✅ Branch text: passthrough.
- ✅ Branch unknown: correto.
- ❌ Branch audio: **stub** retornando `'[transcricao simulada]'` sob `_skip_llm_calls=true`. Sem chamada real OpenAI.
- ❌ Branch image: **stub** retornando caption ou `'[descricao simulada]'`. Sem visão OpenAI.

**Impacto**: lead manda áudio/imagem → IGOR_03 recebe stub, não conteúdo real. Lead pensa que IA está ignorando ou não entendendo. Quebra UX.

### 3. IGOR_04_Tool_Labels_Attributes — commit `880e32c`

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_04`):
- Merge labels (já implementado ✅).
- **Branch custom_attributes**:
  - `custom_attributes.conversation` → `POST /api/v1/accounts/{id}/conversations/{c}/custom_attributes` body `{custom_attributes: {...}}`.
  - `custom_attributes.contact` (se `chatwoot_contact_id` presente) → `PUT /api/v1/accounts/{id}/contacts/{cid}` body `{custom_attributes: {...}}`.

**O que foi entregue**:
- ✅ Merge labels.
- ❌ Custom_attributes branch totalmente ausente.

**Impacto**: IGOR_03 e IGOR_05 não conseguem persistir estados ricos no Chatwoot (`automation_state`, `lead_status`, `callback_period`, `handoff_reason`, etc.). Atendentes humanas perdem contexto.

### 4. IGOR_05_Finalize_Handoff — commit `54af750`

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_05`):
1. UPDATE conversations (state=human_assigned, ai_enabled=false, human_locked=true) ✅
2. **UPDATE leads (status='aguardando_atendente', handoff_at=now())** ❌
3. **Chamar IGOR_04 com labels ['handoff_done', 'ai_disabled', 'aguardando_atendente']** ❌
4. POST private note Chatwoot ✅ (quando não em skip mode)
5. POST assignment Chatwoot ✅
6. INSERT events('handoff_complete') ✅
7. **Send final message ao lead via Evolution sendText (gated por `ALLOW_REAL_WHATSAPP_SEND`)** — só `dry_run_send` hardcoded, sem checar env.

**O que foi entregue**:
- ✅ UPDATE conversations.
- ❌ Sem UPDATE leads.
- ❌ Sem call IGOR_04 (labels não aplicadas).
- ✅ Private note + assignment (em modo non-skip).
- ✅ events('handoff_complete').
- ⚠️ Sempre `dry_run_send` hardcoded, sem caminho de envio real condicional.

**Impacto**: tabela `leads.status` não reflete handoff; relatórios comerciais incorretos; labels críticas (handoff_done, ai_disabled) não chegam no Chatwoot; impossível ativar envio real sem mexer no workflow.

### 5. IGOR_06_Chatwoot_Message_Logger — commit `f116f35`

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_06`):
- Webhook + IF event_type ✅
- Normalize message ✅
- INSERT messages ✅
- IF human takeover → UPDATE conversations + INSERT events('human_assumed') ✅
- **Chamar IGOR_04 para aplicar label `atendimento_humano`** ❌

**O que foi entregue**: tudo exceto a chamada IGOR_04.

**Impacto**: humano respondeu na conversa, IA trava (✓), mas label `atendimento_humano` não aparece — atendentes não veem o estado da conversa no painel Chatwoot.

### 6. IGOR_03_Agent_AfterHours — commit `00f117a` — ✅ RESOLVIDO (2026-05-15 Fase B-6, novo workflow `iQCVbe1P8dC0vhay`)

**Contrato esperado** (`IMPLEMENTATION_PLAN.md §2 IGOR_03`):
- LangChain Agent + Postgres Chat Memory + 4 toolWorkflow tools ✅ (estruturalmente)
- System prompt PT-BR completo ✅
- IF compliance fast-path ✅
- Fluxo conversacional completo: saúda → coleta nome → coleta objetivo → coleta callback → chama trigger_handoff ✅
- Reply path: format AI output → split → presence composing → send WhatsApp (gated por `ALLOW_REAL_WHATSAPP_SEND`) → wait 2s → log ✅

**O que foi entregue na reconstrução Fase B-6**:
- ✅ LangChain agent `gpt-5.4-mini` com Postgres Chat Memory (sessionKey=`after_hours_{phone}`, ctx 25) e 4 tools (set_label_and_attr → IGOR_04, save_lead_partial → AUX, update_conversation_state → AUX, request_handoff → IGOR_05).
- ✅ Compliance fast-path: IF `should_handoff || safety_flags.{clinical|sensitive_image|payment_proof}` → log + executeWorkflow IGOR_05 direto.
- ✅ System prompt PT-BR LITERAL (~4500 chars com acentos preservados, cobrindo persona Alice + personalidade + conduta obrigatória/proibida + 4 campos + sequência conversacional + condicionais + quando chamar cada tool + formato de resposta).
- ✅ Reply path estruturado: Format AI Output (split por `\n\n` ou `||` → array de até 4 mensagens) → SplitOut → SplitInBatches (batchSize=1) → Presence Composing (Evolution sendPresence com delay clampado) → IF send-gate → (real) Evolution sendText + events('whatsapp_sent') | (dry) events('dry_run_send') → Wait 2s → loop back.
- ✅ events emitidos: after_hours_started, agent_response, agent_routed_to_handoff, whatsapp_sent, dry_run_send. handoff_complete emitido via IGOR_05 down-call.
- ✅ 7 fixtures + asserts SQL + expected.md cobrindo cada branch.
- ✅ SOURCE OF TRUTH NOTICE no SDK + JSON canonical exportado pós-PATCH (settings.errorWorkflow=IGOR_07, executionOrder=v1, tags=[igor, inbound, agent, langchain, fase-b-rebuild]).
- ⚠️ `igor_evolution_api` credential AINDA AUSENTE em staging — send_gate default seguro (`IGOR_DRY_RUN=true` ou `ALLOW_REAL_WHATSAPP_SEND=false`) evita falha. Documentado em `docs/workflows/IGOR_03_Agent_AfterHours.md §Credenciais`. Não bloqueia a reconstrução; bloqueia ativação real.

**Validação pendente**: smoke tests integrados Fase C com cada uma das 7 fixtures + flow review subagent.

## Workflows que **não** têm dívida (mas precisam auditoria)

- **IGOR_07_Error_Logger** (`2a65b59`) — implementação parece OK contra contrato. Auditar.
- **IGOR_AUX_save_lead_partial** (`1239136`) — não foi simplificado, mas será usado por IGOR_03 refeito. Auditar inputs schema (workflowInputs).
- **IGOR_AUX_update_conversation_state** (`9375b21`) — idem.

## Workflows ainda não construídos

- **IGOR_08_Health_Check** — não simplificado porque não foi construído.

## Workflows fora do escopo desta dívida (Frente Campanha — pausada)

- IGOR_09 (importer script python — não é workflow n8n).
- IGOR_10, IGOR_11, IGOR_12, IGOR_13 (não construídos).

## Problemas operacionais correlatos

1. **`scripts/import-workflow.sh`** quebra em CREATE com erro `"active is read-only"`. Workaround manual em todos os imports até hoje. Já no follow-up #43.
2. **Helpers `IGOR_TEST_Failing_Workflow` e `IGOR_TEST_Trampoline`** com `errorWorkflow` hardcoded para id `ZrsbaSTlW5bqMEaS` (IGOR_07 atual). Se IGOR_07 reimportar, id muda → quebra.
3. **Webhooks helpers sem auth** — invocação arbitrária de workflows possível. Follow-up #43.
4. **Sem worktrees** — sessões paralelas inviabilizadas.

## Plano de reversão e reconstrução

### Fase A — Reverter (cria estado limpo)

`git revert` dos commits na ordem reversa (do mais recente para o mais antigo) para evitar conflitos:

| Ordem | Commit | Workflow |
|---|---|---|
| 1 | `00f117a` | IGOR_03 |
| 2 | `54af750` | IGOR_05 |
| 3 | `3a17bbc` | IGOR_01 |
| 4 | `a2eddfa` | IGOR_02 |
| 5 | `f116f35` | IGOR_06 |
| 6 | `880e32c` | IGOR_04 |

Após cada revert local, DELETE do workflow correspondente no n8n via `DELETE /api/v1/workflows/{id}`. IDs:
- IGOR_03: `VaFBbMyQBJEztKle`
- IGOR_05: `xHorZFRZYAaklR1F`
- IGOR_01: `YxFzT0XaP39tstua`
- IGOR_02: `Mb6QsNPdrWdmoULC`
- IGOR_06: `rKnKL69w4cpy0fPW`
- IGOR_04: `srZRMaFljJIKzyuQ`

(Workflows AUX e helpers — preservar.)

### Fase B — Reconstruir Inbound completo (prioridade máxima: robustez)

**Diretriz reforçada (2026-05-15)**: o foco desta fase é **workflows robustos e completos**. Review e testes integrados ficam para o **final de tudo** (Fase C), não intercalados. Construção em sequência sem checkpoint de review entre cada.

Ordem (respeitando deps):

1. **IGOR_04** — labels + custom_attributes branch completo (conversation + contact).
2. **IGOR_06** — incluindo chamada IGOR_04 com label `atendimento_humano` em human takeover.
3. **IGOR_02** — branches audio (gpt-4o-transcribe real + download de URL/base64) + image (gpt-4o-mini visão real com prompt PT-BR restritivo).
4. **IGOR_05** — UPDATE leads.status + chamar IGOR_04 com labels handoff + gate `ALLOW_REAL_WHATSAPP_SEND` (IF env=true E DRY_RUN=false → Evolution sendText; senão events('dry_run_send')).
5. **IGOR_01** — matriz determinística completa (12 condições), Redis lock + RPUSH/GET batching (padrão ASX 07 nodes 16-23), lookup `do_not_contact` + `campaign_contacts`, check `workflows_enabled.IGOR_01`, chamadas IGOR_02 e IGOR_03.
6. **IGOR_03** — happy path conversacional completo, system prompt completo, 4 tools wired, reply path estruturado (Format AI Output → SplitOut → SplitInBatches → Presence Composing → Send WhatsApp gated → Wait 2s → Log Success).
7. **IGOR_08** — Health Check schedule */10 min com pings + SQL snapshots + INSERT events('health_check').

Cada workflow:
- Brief literal do contrato (sem palavras "simplificação", "v1", "stub", "TODO v2", "_skip_X" gates).
- Fixtures e asserts existem para suportar reconstrução, mas validação verde individual **não** é critério de avançar para o próximo.
- Commit granular por workflow.

### Fase C — Validação integrada (no final)

Depois que TODOS os 7 workflows do Inbound estiverem construídos completos, **então**:

1. Smoke tests obrigatórios (10 do `IMPLEMENTATION_PLAN.md §10`).
2. Reviewer de **qualidade de lógica de fluxo** (subagent que lê `docs/logica-fluxo-igor-receptivo-fora-expediente.md` e compara linha-a-linha com cada workflow implementado, identificando TODOS os gaps).
3. Correções dos gaps identificados.
4. Aprovação do usuário → libera Frente Campanha.

## Critério de "Inbound completo"

- Todos os 7 workflows construídos sem simplificações.
- Reviewer de fluxo aprova (zero gaps detectados).
- Smoke tests passam.
- Operacional: `import-workflow.sh` corrigido OU substituído por `n8n_create_workflow`/`n8n_update_partial_workflow` se MCP n8n ativo.
- Helpers com auth (absorve follow-up #43).
- `settings.workflows_enabled.IGOR_*` checado em cada workflow.

## Mudança operacional: n8n MCP

O usuário criou o `.mcp.json` do n8n. Em nova sessão, ferramentas `search_nodes`, `get_node`, `validate_node`, `n8n_create_workflow`, `n8n_update_partial_workflow`, `n8n_validate_workflow` estarão disponíveis. Isso muda como construo workflows:

- **Antes**: gerava JSON literal + `bash scripts/import-workflow.sh` (com bug do `active`).
- **Daqui em diante**: usar `n8n_create_workflow` (resolve o bug automaticamente) e `n8n_update_partial_workflow` (edits cirúrgicos, em vez de PUT inteiro). Validar com `n8n_validate_workflow` antes de commitar JSON exportado.

JSON commitado em `n8n/workflows/` continua sendo source-of-truth versionável. Mas exportar via `n8n_get_workflow` para garantir formato canônico.

## Comando para retomar em nova sessão

```
Continue de onde paramos. Lê em ordem:
1. ~/.claude/projects/-Users-mateusolintof-Projetos-Convert-Produ--o-Instituto-Igor/MEMORY.md (regras, decisões, feedbacks)
2. docs/superpowers/debt/2026-05-15-simplifications-to-revert.md (este doc — plano de reset+rebuild)
3. .remember/orchestrator-state.json (estado dos 14 workflows)
4. git log --oneline -20 (últimos commits)
5. Confirma se n8n MCP está disponível via ToolSearch "n8n_create_workflow"
6. Retoma na Fase A passo 1 (git revert) se ainda não iniciado, ou no ponto onde parou conforme orchestrator-state.json
7. Regra absoluta: NO SIMPLIFICATIONS. Foco em robustez e completude. Review/test só no final.
```
