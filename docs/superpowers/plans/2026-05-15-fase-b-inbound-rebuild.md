# Fase B — Inbound Rebuild (NO SIMPLIFICATIONS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan one task per fresh subagent in isolated git worktrees. Steps use checkbox (`- [ ]`) syntax for tracking. After each task, run two-stage review (build review + design review) before merging back to main.

**Goal:** Reconstruir os 7 workflows do receptivo fora-de-expediente (`IGOR_04`, `IGOR_02`, `IGOR_08`, `IGOR_06`, `IGOR_05`, `IGOR_01`, `IGOR_03`) sob regra absoluta **NO SIMPLIFICATIONS**, com contratos literais de `docs/IMPLEMENTATION_PLAN.md §2` e `docs/logica-fluxo-igor-receptivo-fora-expediente.md`, usando `mcp__n8n-mcp__create_workflow_from_code` + validação MCP em cada workflow.

**Architecture:** Harness Engineering — regras determinísticas em Code/IF/Switch/SQL/Redis-locks/callables; LLM apenas para resposta conversacional, transcrição, descrição de imagem, classificação de documento. Cada workflow é criado **inativo** no n8n via MCP, JSON canônico exportado para `n8n/workflows/`, fixtures + asserts.sql + expected.md commitados juntos. Smoke tests e flow-review **só** rodam em Fase C (depois dos 7 workflows construídos).

**Tech Stack:**
- n8n self-hosted (Portainer) com nodes `n8n-nodes-base.*` (webhook, code, postgres, httpRequest, redis, set, switch, if, splitInBatches, wait, executeWorkflow), `@n8n/n8n-nodes-langchain.*` (agent, lmChatOpenAi, memoryPostgresChat, toolWorkflow).
- Supabase Cloud (Postgres) via credential `igor_supabase_postgres`.
- Chatwoot self-hosted via credential `igor_chatwoot_api` (header `api_access_token`).
- Evolution API via credential `igor_evolution_api` (header `apikey`).
- Redis interno do n8n via credential `igor_redis`.
- OpenAI via credential `igor_openai` (gpt-5.4-mini para agente, gpt-4o-transcribe para áudio, gpt-4o-mini para visão).
- Git local (sem remote), commits granulares por workflow.

---

## Regras absolutas (NO SIMPLIFICATIONS)

Antes de cada subagente abrir o trabalho, ler e respeitar:

1. **`feedback_nunca_simplificar_e_asx_e_referencia.md`** em `~/.claude/projects/.../memory/`. NUNCA inventar "v1 simplificado", "stub e refator depois", "TODO v2", "pular X para velocidade". Se um componente exige credencial ou decisão não clara, **parar e perguntar ao usuário** — não simplificar.
2. **`docs/superpowers/debt/2026-05-15-simplifications-to-revert.md`** — registry de exatamente o que foi simplificado anteriormente. Esta reconstrução elimina cada item desse registry.
3. **Contrato é o que está em `docs/IMPLEMENTATION_PLAN.md §2 IGOR_XX` + spec correspondente em `docs/logica-fluxo-igor-receptivo-fora-expediente.md`**. Copie literal. Não invente decisões.
4. **Gates de segurança** (todos os workflows que mutariam serviços ou enviariam mensagem):
   - `IGOR_DRY_RUN=true` → bloqueia **apenas** `sendText` da Evolution. Writes em Supabase e Chatwoot ocorrem normalmente.
   - `ALLOW_REAL_WHATSAPP_SEND=true` E `IGOR_DRY_RUN=false` → envia via Evolution. Senão, INSERT events('dry_run_send', payload) e segue.
   - `ALLOW_PRODUCTION_MUTATIONS=true` E aprovação explícita → mutações destrutivas. Senão, log-only.
   - Workflow inativo no n8n por padrão. Ativação é decisão manual do usuário no UI após Fase C.
5. **`settings.workflows_enabled.IGOR_XX === false`** → workflow faz NoOp + log e termina. Check OBRIGATÓRIO no início de cada workflow que tem trigger externo (webhook ou schedule).
6. **`errorWorkflow: 'IGOR_07_Error_Logger'`** em todos os workflows construídos.

## Princípios de TDD para n8n workflows

Adaptação da skill `superpowers:test-driven-development` para o domínio n8n:

- **RED**: subagente escreve fixture (input determinístico) + asserts.sql (estado DB esperado após execução) + expected.md (comportamento esperado por branch). Asserts.sql é o "test"; sem o workflow rodar, asserts falhariam.
- **GREEN estático**: subagente roda `mcp__n8n-mcp__validate_workflow` no código SDK e corrige erros até validação verde.
- **GREEN dinâmico**: deferido para Fase C (executar workflow via `execute_workflow` MCP com fixture e rodar asserts.sql).
- **Refactor**: aplicar quando 3+ workflows repetirem padrão (e.g., header `X-N8N-API-KEY`, normalização de phone, INSERT events). Extrair para `IGOR_AUX_*` callable. Não antes.

## Pipeline operacional (worktree + subagente)

Cada workflow segue:

1. Orquestrador chama `superpowers:using-git-worktrees` → cria worktree `worktrees/fase-b/igor-XX/` em branch `fase-b/igor-XX`.
2. Orquestrador dispatcha subagente (Agent tool, subagent_type=general-purpose, isolation=worktree) com brief literal contendo:
   - Reference a esta seção do plano.
   - Reference a IMPLEMENTATION_PLAN.md §2 IGOR_XX e spec.
   - Reference a `feedback_nunca_simplificar*` (memory).
   - Files a criar.
   - Steps TDD (Red → Green estático → commit).
   - Critério de "done" (validate_workflow passa + create_workflow_from_code retorna id + JSON exportado + arquivos commitados).
3. Subagente reporta `{workflow_id, validation_result, commits}`.
4. Orquestrador roda **two-stage review** (skill `superpowers:requesting-code-review` se aplicável, ou subagent `feature-dev:code-reviewer`):
   - Stage 1 — build review: erros de schema/JSON/SDK.
   - Stage 2 — design review: cobertura do contrato de IMPLEMENTATION_PLAN.md §2 IGOR_XX vs implementação.
5. Aprovado → merge worktree para main + cleanup.
6. Rejeitado → orquestrador devolve ao subagente original (SendMessage) com feedback estruturado.
7. Atualiza `.remember/orchestrator-state.json` (`workflow.status: pending_rebuild → done_pending_smoke`).

## File Structure (por workflow)

Para cada `IGOR_XX`, o subagente cria/edita:

```text
n8n/workflows/IGOR_XX_<Name>.json          # JSON exportado canônico via MCP
n8n/workflows/IGOR_XX_<Name>.sdk.ts        # Source TS SDK (para regenerar JSON)
fixtures/IGOR_XX_<scenario>.json           # 1+ fixture por branch coberta
tests/asserts-IGOR_XX_<Name>.sql            # Asserts SQL (Fase C executa)
tests/expected-IGOR_XX_<Name>.md            # Comportamento esperado por branch + cobertura
docs/workflows/IGOR_XX_<Name>.md            # Audit doc: contrato, design de nodes, decisões, gates
```

**Arquivos compartilhados** (não duplicar entre subagentes):

```text
.env / .env.example       # vars novas só com aprovação explícita
scripts/                  # editar somente se contrato exigir
supabase/migrations/      # NÃO criar nesta fase (schema já existe)
```

---

## Wave decomposition

| Wave | Workflows (paralelo) | Deps externas | Por que paralelo |
|------|---------------------|---------------|------------------|
| 1 | `IGOR_04`, `IGOR_02`, `IGOR_08` | Nenhuma entre si | Zero callable interno cruzado |
| 2 | `IGOR_06`, `IGOR_05` | `IGOR_04` (wave 1) | Ambos chamam IGOR_04 |
| 3 | `IGOR_01` | `IGOR_02`, `IGOR_04` | Único: roteador inbound |
| 4 | `IGOR_03` | `IGOR_04`, `IGOR_05`, AUX | Único: agente conversacional |

Cada wave: orquestrador dispatcha N subagentes em paralelo (single message com N `Agent` tool calls). Próxima wave só inicia quando todos os subagentes da wave anterior reportam `done_pending_smoke`.

---

## Task 1: IGOR_04_Tool_Labels_Attributes

**Wave**: 1 (paralelo com IGOR_02, IGOR_08).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:144-154):

```text
- Trigger: callable (executeWorkflowTrigger).
- Entrada: { chatwoot_conversation_id, chatwoot_contact_id?, labels_to_add: [], labels_to_remove: [], custom_attributes: { conversation: {}, contact: {} } }
- Decisões:
  - GET labels atuais da conversa e do contato.
  - Mesclar `add` com lista atual (não sobrescrever), remover apenas o explicitado.
  - PATCH custom_attributes (não DELETE).
- LLM: não.
- Sub-workflows: nenhum.
- Mutações: labels e custom_attributes no Chatwoot.
- Observabilidade: events('label_added'), events('attribute_set').
```

**Files:**
- Create: `n8n/workflows/IGOR_04_Tool_Labels_Attributes.json`
- Create: `n8n/workflows/IGOR_04_Tool_Labels_Attributes.sdk.ts`
- Create: `fixtures/IGOR_04_labels_only.json`
- Create: `fixtures/IGOR_04_attrs_conversation_only.json`
- Create: `fixtures/IGOR_04_attrs_contact_and_labels.json`
- Create: `fixtures/IGOR_04_empty_payload.json`
- Create: `tests/asserts-IGOR_04_Tool_Labels_Attributes.sql`
- Create: `tests/expected-IGOR_04_Tool_Labels_Attributes.md`
- Create: `docs/workflows/IGOR_04_Tool_Labels_Attributes.md`

**Node design (high-level)**:

1. `executeWorkflowTrigger` with `workflowInputs`: `chatwoot_conversation_id` (string, required), `chatwoot_contact_id` (string, optional), `labels_to_add` (array), `labels_to_remove` (array), `custom_attributes` (object with optional keys `conversation` and `contact`).
2. `code` "Validate Payload": coerce types, default `labels_to_add=[]`, `labels_to_remove=[]`, `custom_attributes.conversation={}`, `custom_attributes.contact={}`. Emit `_skip_labels` if both arrays empty, `_skip_attrs_conversation` if empty, `_skip_attrs_contact` if `chatwoot_contact_id` empty or `custom_attributes.contact` empty.
3. `if` "Skip Labels?" → branch A: labels merge; branch B: passthrough to attrs.
4. **Labels merge branch**:
   - `httpRequest` GET `/api/v1/accounts/{{account_id}}/conversations/{{chatwoot_conversation_id}}` → parse `labels` array.
   - `code` "Merge Labels": set merged = (current ∪ labels_to_add) \ labels_to_remove. Compute `added=[]`, `removed=[]` deltas for events.
   - `httpRequest` POST `/api/v1/accounts/{{account_id}}/conversations/{{chatwoot_conversation_id}}/labels` body `{labels: merged}` (Chatwoot API uses POST not PUT for label-set; verify in docs).
   - `postgres` INSERT events: one per added (`type='label_added'`), one per removed (`type='label_removed'`).
5. `if` "Skip Attrs Conversation?" → branch A: attrs conversation PATCH; branch B: skip.
6. **Attrs conversation branch**:
   - `httpRequest` POST `/api/v1/accounts/{{account_id}}/conversations/{{chatwoot_conversation_id}}/custom_attributes` body `{custom_attributes: {{$json.custom_attributes.conversation}}}`.
   - `postgres` INSERT events `attribute_set` with payload `{scope: 'conversation', keys: Object.keys(attrs.conversation)}`.
7. `if` "Skip Attrs Contact?" → branch A: attrs contact PUT; branch B: skip.
8. **Attrs contact branch**:
   - `httpRequest` PUT `/api/v1/accounts/{{account_id}}/contacts/{{chatwoot_contact_id}}` body `{custom_attributes: {{$json.custom_attributes.contact}}}`.
   - `postgres` INSERT events `attribute_set` with payload `{scope: 'contact', keys: Object.keys(attrs.contact)}`.
9. Merge final → emit `{ok: true, labels_added, labels_removed, attrs_conversation_keys, attrs_contact_keys}`.
10. Workflow settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Steps:**

- [ ] **S1: Write fixture `IGOR_04_labels_only.json`** com `{chatwoot_conversation_id: 'test-conv-1', labels_to_add: ['handoff_done', 'ai_disabled'], labels_to_remove: ['qualificacao_rapida'], custom_attributes: {conversation: {}, contact: {}}}`.
- [ ] **S2: Write fixture `IGOR_04_attrs_conversation_only.json`** com `{chatwoot_conversation_id: 'test-conv-2', labels_to_add: [], labels_to_remove: [], custom_attributes: {conversation: {automation_state: 'collecting_callback_time', lead_status: 'qualificacao_rapida'}, contact: {}}}`.
- [ ] **S3: Write fixture `IGOR_04_attrs_contact_and_labels.json`** com `{chatwoot_conversation_id: 'test-conv-3', chatwoot_contact_id: 'test-contact-3', labels_to_add: ['atendimento_humano'], labels_to_remove: [], custom_attributes: {conversation: {automation_state: 'human_assigned'}, contact: {city: 'São Paulo', objetivo_principal: 'emagrecimento'}}}`.
- [ ] **S4: Write fixture `IGOR_04_empty_payload.json`** com `{chatwoot_conversation_id: 'test-conv-4', labels_to_add: [], labels_to_remove: [], custom_attributes: {conversation: {}, contact: {}}}` (must NoOp gracefully).
- [ ] **S5: Write `tests/asserts-IGOR_04_Tool_Labels_Attributes.sql`** covering: 2 events `label_added` from S1, 1 event `label_removed` from S1, 1 event `attribute_set` scope=conversation from S2, 2 events `attribute_set` (conversation + contact) from S3, ZERO events from S4. Use `{{test_run_id}}` placeholder in fixtures + asserts.
- [ ] **S6: Write `tests/expected-IGOR_04_Tool_Labels_Attributes.md`** documenting each fixture's branch + asserts mapping.
- [ ] **S7: Get n8n SDK reference**: call `mcp__n8n-mcp__get_sdk_reference` (sections: patterns, expressions, functions, guidelines).
- [ ] **S8: Get node types**: call `mcp__n8n-mcp__get_node_types` for `n8n-nodes-base.executeWorkflowTrigger`, `n8n-nodes-base.code`, `n8n-nodes-base.if`, `n8n-nodes-base.httpRequest`, `n8n-nodes-base.postgres`, `n8n-nodes-base.merge`.
- [ ] **S9: Write `n8n/workflows/IGOR_04_Tool_Labels_Attributes.sdk.ts`** implementing the node design above. Use credential names `igor_chatwoot_api` (httpRequest) and `igor_supabase_postgres` (postgres). Use `$json.chatwoot_conversation_id` etc. via n8n expressions. Set `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`, `tags: ['igor', 'inbound', 'tool', 'fase-b-rebuild']`.
- [ ] **S10: Validate workflow code**: call `mcp__n8n-mcp__validate_workflow` with the SDK code. Fix errors and re-validate until clean.
- [ ] **S11: Create workflow on n8n**: call `mcp__n8n-mcp__create_workflow_from_code` with validated code + description "IGOR_04: callable que mescla labels (GET current + add - remove) e PATCH custom_attributes em conversation/contact no Chatwoot. Sem LLM. Errors → IGOR_07.".
- [ ] **S12: Export canonical JSON**: capture the workflow JSON from MCP response or call `mcp__n8n-mcp__get_workflow_details` with returned id, save to `n8n/workflows/IGOR_04_Tool_Labels_Attributes.json`.
- [ ] **S13: Write `docs/workflows/IGOR_04_Tool_Labels_Attributes.md`** audit doc: contrato, n8n_id, gates ativados, node-by-node summary, riscos conhecidos (Chatwoot API rate limits, race em labels concorrentes), comparação com debt doc (custom_attributes branch ausente antes → presente agora).
- [ ] **S14: Commit** `git add n8n/workflows/IGOR_04_* fixtures/IGOR_04_* tests/asserts-IGOR_04_* tests/expected-IGOR_04_* docs/workflows/IGOR_04_*` e `git commit -m "feat(IGOR_04): tool labels + custom_attributes branch (NO SIMPLIFICATIONS rebuild)"`.

---

## Task 2: IGOR_02_Media_Normalizer

**Wave**: 1 (paralelo com IGOR_04, IGOR_08).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:114-127 + spec §10):

```text
- Trigger: callable (executeWorkflowTrigger).
- Entrada: { phone, msgId, messageType, media_url|media_base64, caption?, mimeType?, chatwoot_conversation_id }
- Decisões:
  - audio → baixar + transcrever via gpt-4o-transcribe (OpenAI).
  - image → se sem caption: descrever + classificar sensibilidade via gpt-4o-mini vision com prompt PT-BR restritivo. Se safety_flags.clinical = true → forçar should_handoff = true.
  - document (pdf): heurística regex + análise de conteúdo. Match em ("exame", "laudo", "prescrição", "receita", "CRM", "diagnóstico") → should_handoff = true, handoff_reason = documento_clinico_sensivel.
  - text → passa direto.
  - unknown → should_handoff = true, handoff_reason = mídia_desconhecida.
- Saída: { normalized_text, media_summary?, safety_flags{ clinical, sensitive_image, payment_proof, financial }, should_handoff, handoff_reason? }
- LLM: SIM — transcrição (áudio), descrição/classificação (imagem), classificação de documento.
- Mutações: messages (insere versão normalizada com transcript, summary, safety_flags).
- Observabilidade: events('media_normalized') com messageType e safety_flags.
```

**Files:**
- Create: `n8n/workflows/IGOR_02_Media_Normalizer.json`
- Create: `n8n/workflows/IGOR_02_Media_Normalizer.sdk.ts`
- Create: `fixtures/IGOR_02_audio_url.json`
- Create: `fixtures/IGOR_02_audio_base64.json`
- Create: `fixtures/IGOR_02_image_no_caption.json`
- Create: `fixtures/IGOR_02_image_with_caption.json`
- Create: `fixtures/IGOR_02_image_clinical_sensitive.json` (cenário simulado — sem imagem real, asserts validam path)
- Create: `fixtures/IGOR_02_document_clinical.json`
- Create: `fixtures/IGOR_02_document_generic.json`
- Create: `fixtures/IGOR_02_text_passthrough.json`
- Create: `fixtures/IGOR_02_unknown_type.json`
- Create: `tests/asserts-IGOR_02_Media_Normalizer.sql`
- Create: `tests/expected-IGOR_02_Media_Normalizer.md`
- Create: `docs/workflows/IGOR_02_Media_Normalizer.md`

**Node design (high-level)**:

1. `executeWorkflowTrigger` with `workflowInputs`: `phone` (string), `msgId` (string), `messageType` (string ∈ audio|image|document|text|unknown), `media_url` (string, opt), `media_base64` (string, opt), `caption` (string, opt), `mimeType` (string, opt), `chatwoot_conversation_id` (string).
2. `code` "Validate Payload": coerce, default missing, emit `_branch` ∈ `{audio, image_no_caption, image_with_caption, document, text, unknown}`. Para `image`, `_branch = image_with_caption` se `caption` não-vazio.
3. `switch` 6 branches por `_branch`.
4. **Branch `audio`**:
   - `if` "Has media_url?" → branch A: `httpRequest` GET `media_url` (response type: binary, property: `data`). Branch B: `code` decode `media_base64` (atob).
   - Merge → binary in `data`.
   - `httpRequest` POST `https://api.openai.com/v1/audio/transcriptions` (multipart: `file=binary`, `model=gpt-4o-transcribe`, `language=pt`) using credential `igor_openai` (header `Authorization: Bearer`).
   - `code` "Format Audio": set `normalized_text = response.text`, `media_summary = "[áudio transcrito] " + response.text.slice(0,200)`, `safety_flags = {clinical:false, sensitive_image:false, payment_proof:false, financial:false}`, `should_handoff = false`.
5. **Branch `image_with_caption`**:
   - `code` "Format Image w/ Caption": `normalized_text = caption`, `media_summary = "[imagem com caption] " + caption.slice(0,200)`, `safety_flags = default false`, `should_handoff = false`.
6. **Branch `image_no_caption`**:
   - `if` "Has media_url?" → fetch (same pattern as audio). Branch B: pass media_base64 direct.
   - `httpRequest` POST `https://api.openai.com/v1/chat/completions` body:
     ```json
     {
       "model": "gpt-4o-mini",
       "messages": [{"role": "user", "content": [
         {"type": "text", "text": "<PROMPT PT-BR RESTRITIVO — ver abaixo>"},
         {"type": "image_url", "image_url": {"url": "data:{{mimeType}};base64,{{base64}}"}}
       ]}],
       "response_format": {"type": "json_object"}
     }
     ```
     **Prompt PT-BR restritivo** (subagente cola literal no node):
     ```text
     Você descreve imagens enviadas por leads de uma clínica médica. NÃO interpreta clinicamente. NÃO dá orientação médica. NÃO diagnostica.
     Responda APENAS em JSON com este schema:
     {
       "descricao": "string — breve descrição neutra do que aparece (max 200 chars)",
       "tipo": "selfie_rosto" | "selfie_corpo" | "documento" | "exame_imagem" | "prescricao" | "comprovante_pagamento" | "captura_de_tela" | "outro",
       "safety_flags": {
         "clinical": boolean — true se for exame, laudo, imagem médica, prescrição, raio-X, ultrassom, ressonância, tomografia, etc.,
         "sensitive_image": boolean — true se for nudez, ferida exposta, antes/depois corporal, partes íntimas,
         "payment_proof": boolean — true se for comprovante PIX, transferência ou recibo,
         "financial": boolean — true se for boleto, fatura ou documento financeiro
       }
     }
     ```
   - `code` "Parse Image Response": parse JSON, set `normalized_text = "[imagem] " + descricao`, `media_summary = descricao`, `safety_flags = response.safety_flags`, `should_handoff = safety_flags.clinical || safety_flags.sensitive_image`, `handoff_reason = clinical ? 'imagem_clinica_sensivel' : (sensitive_image ? 'imagem_sensivel' : null)`.
7. **Branch `document`**:
   - `if` "Has media_url?" → fetch as binary. Else decode base64.
   - `code` "Extract PDF Text": para PDFs, usar lib nativa do n8n se disponível (`pdf-parse` ou similar). Se não disponível no n8n, usar `httpRequest` para Apache Tika ou enviar para OpenAI Files. Subagente decide com `get_node_types` para extractFromFile (se existir node `n8n-nodes-base.extractFromFile`).
   - `code` "Heurística Clínica": regex `/(exame|laudo|prescri[cç][ãa]o|receita|CRM[\-\s]?\d|diagn[oó]stico|hemograma|raio[\s-]?x|ressonancia|tomografia)/i`. Match → `should_handoff = true`, `handoff_reason = 'documento_clinico_sensivel'`, `safety_flags.clinical = true`.
   - Else: `should_handoff = false`, `safety_flags = default`. `normalized_text = "[documento] " + filename + " (" + textLength + " chars)"`, `media_summary = textSnippet.slice(0,300)`.
8. **Branch `text`**: passthrough → `normalized_text = caption || ''` (se for chamado com text). Não tem mídia.
9. **Branch `unknown`**: `should_handoff = true`, `handoff_reason = 'midia_desconhecida'`, `normalized_text = "[mídia desconhecida tipo=" + messageType + "]"`, `safety_flags = default`.
10. **Merge final**: combine output → emit `{normalized_text, media_summary, safety_flags, should_handoff, handoff_reason}`.
11. **INSERT messages**: `postgres` UPSERT em `messages` (key: `msgId`, fields: `transcript=normalized_text`, `summary=media_summary`, `safety_flags=safety_flags::jsonb`, `chatwoot_conversation_id`, `phone`).
12. **INSERT events**: `postgres` INSERT `events('media_normalized', payload={messageType, safety_flags, should_handoff})`.
13. Output: full output object para o caller.
14. Workflow settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Gates importantes**:
- Subagente verifica se `igor_openai` credential existe no n8n via `mcp__n8n-mcp__search_credentials` (ou similar) ANTES de criar o workflow. Se ausente, registra no relatório final e bloqueia tarefa (parar e perguntar usuário).
- Não usar variável `_skip_llm_calls` — sem stubs. Se credencial ausente, parar.

**Steps:**

- [ ] **S1: Write 9 fixtures** cobrindo audio_url, audio_base64, image_no_caption, image_with_caption, image_clinical_sensitive (caption sinalizando exame), document_clinical, document_generic, text, unknown.
- [ ] **S2: Write `tests/asserts-IGOR_02_Media_Normalizer.sql`** com asserts por fixture: counts em `events('media_normalized')` por safety_flags state; `messages` com transcript não-vazio (audio), summary não-vazio (image), `safety_flags->>'clinical'='true'` (document clínico).
- [ ] **S3: Write `tests/expected-IGOR_02_Media_Normalizer.md`** documentando cada fixture, branch tomada, output esperado.
- [ ] **S4: Verify `igor_openai` credential exists**: call MCP credential search. Se ausente, STOP e reporte ao orquestrador.
- [ ] **S5: Get SDK reference + node types** (executeWorkflowTrigger, code, switch, httpRequest, postgres, if, extractFromFile if available).
- [ ] **S6: Write `n8n/workflows/IGOR_02_Media_Normalizer.sdk.ts`** com todos os branches reais (sem stubs). Use credentials `igor_openai` (Bearer), `igor_supabase_postgres`. Prompt PT-BR restritivo colado literal.
- [ ] **S7: Validate workflow code** (`mcp__n8n-mcp__validate_workflow`). Fix and re-validate até clean.
- [ ] **S8: Create workflow** (`mcp__n8n-mcp__create_workflow_from_code`) com description "IGOR_02: normalizer de mídia. Áudio → gpt-4o-transcribe. Imagem → gpt-4o-mini vision com prompt restritivo + safety_flags. Documento → regex clínica + pdf text. Text → passthrough. Unknown → handoff. Errors → IGOR_07.".
- [ ] **S9: Export canonical JSON** para `n8n/workflows/IGOR_02_Media_Normalizer.json`.
- [ ] **S10: Write `docs/workflows/IGOR_02_Media_Normalizer.md`** audit doc completo (contrato, prompt PT-BR copiado literal, gates, riscos: rate limit OpenAI, custos por imagem, fallback se PDF parsing falhar).
- [ ] **S11: Commit** `feat(IGOR_02): media normalizer real (audio gpt-4o-transcribe + image gpt-4o-mini vision + doc regex) — NO SIMPLIFICATIONS rebuild`.

---

## Task 3: IGOR_08_Health_Check

**Wave**: 1 (paralelo com IGOR_04, IGOR_02).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:192-201):

```text
- Trigger: schedule (a cada 10 min — */10 * * * *).
- Decisões/Checks:
  - Ping Evolution /instance/connectionState/{instance} → status open?
  - Ping Chatwoot /api/v1/accounts/{id} → 200?
  - SELECT contagens últimas 24h em events, messages, leads, campaign_contacts.
  - Detectar: conversas com ai_enabled=true recebendo mensagem do agent humano (race), batches Redis órfãos (KEYS igor:batch:* com TTL alto), infra_error > threshold, opt-out > threshold.
- LLM: não.
- Mutações: INSERT events('health_check').
- Observabilidade: o evento health_check é a fonte do dashboard operacional.
```

**Adições obrigatórias** (não está no contrato mas implícito por "fonte do dashboard"):
- Ping OpenAI `https://api.openai.com/v1/models` (Bearer auth) → expect 200.
- Ping Supabase `SELECT 1` → expect ok.
- Ping n8n self `GET {{N8N_BASE_URL}}/healthz` → expect 200.

**Files:**
- Create: `n8n/workflows/IGOR_08_Health_Check.json`
- Create: `n8n/workflows/IGOR_08_Health_Check.sdk.ts`
- Create: `tests/asserts-IGOR_08_Health_Check.sql` (events('health_check') com payload estruturado)
- Create: `tests/expected-IGOR_08_Health_Check.md`
- Create: `docs/workflows/IGOR_08_Health_Check.md`

**Node design**:

1. `cron` trigger `*/10 * * * *`.
2. `code` "Init Snapshot": set `started_at = now()`, `health_id = randomUUID()`.
3. Parallel pings (via merge):
   - `httpRequest` GET `{{N8N_BASE_URL}}/healthz` (timeout 5s).
   - `httpRequest` GET `{{CHATWOOT_BASE_URL}}/api/v1/accounts/{{CHATWOOT_ACCOUNT_ID}}` with `api_access_token`.
   - `httpRequest` GET `{{EVOLUTION_BASE_URL}}/instance/connectionState/{{EVOLUTION_INSTANCE_NAME}}` with apikey.
   - `httpRequest` GET `https://api.openai.com/v1/models` with Bearer.
   - `postgres` `SELECT 1 as supabase_ok`.
   - Each followed by `code` capturing `{service, status, http_code, latency_ms, error?}`.
4. `postgres` "Counts 24h":
   ```sql
   SELECT
     (SELECT count(*) FROM events WHERE created_at > now() - interval '24 hours') as events_24h,
     (SELECT count(*) FROM events WHERE type='infra_error' AND created_at > now() - interval '24 hours') as infra_errors_24h,
     (SELECT count(*) FROM events WHERE type='opt_out' AND created_at > now() - interval '24 hours') as opt_outs_24h,
     (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours') as messages_24h,
     (SELECT count(*) FROM leads WHERE created_at > now() - interval '24 hours') as leads_24h,
     (SELECT count(*) FROM campaign_contacts WHERE updated_at > now() - interval '24 hours') as campaign_24h
   ```
5. `postgres` "Race Detection":
   ```sql
   SELECT count(*) as race_count FROM conversations c
   JOIN messages m ON m.chatwoot_conversation_id = c.chatwoot_conversation_id
   WHERE c.ai_enabled = true AND m.sender_type = 'agent_human' AND m.created_at > now() - interval '10 minutes'
   ```
6. `redis` "Orphan Batches": `KEYS igor:batch:*` → length + TTL check (>60s = órfão).
7. `code` "Aggregate": build payload `{health_id, started_at, ended_at, services: [...], counts: {...}, race_count, orphan_batches, threshold_breaches: [...], overall_status: 'healthy'|'degraded'|'critical'}`.
8. `postgres` INSERT `events('health_check', payload)`.
9. (Opcional, sem ação destrutiva) IF `overall_status='critical'` → INSERT `events('health_alert', payload)` adicional.
10. Settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false` (ativação manual após Fase C).

**Thresholds (configuráveis via settings, com defaults)**:
- `infra_errors_24h > 50` → degraded.
- `opt_outs_24h > 20` → degraded.
- Qualquer service ping fail → degraded.
- 2+ services fail OR race_count > 0 OR orphan_batches > 5 → critical.

**Steps:**

- [ ] **S1: Write `tests/expected-IGOR_08_Health_Check.md`** descrevendo schedule, services checados, payload shape, thresholds, race detection logic.
- [ ] **S2: Write `tests/asserts-IGOR_08_Health_Check.sql`** validando que após uma execução manual há 1 `events('health_check')` com payload contendo services array, counts, overall_status.
- [ ] **S3: Get SDK reference + node types** (cron, httpRequest, postgres, redis, code, merge, if).
- [ ] **S4: Write `n8n/workflows/IGOR_08_Health_Check.sdk.ts`**. Use credentials `igor_chatwoot_api`, `igor_evolution_api`, `igor_openai`, `igor_supabase_postgres`, `igor_redis`.
- [ ] **S5: Validate** (`mcp__n8n-mcp__validate_workflow`).
- [ ] **S6: Create workflow** com description "IGOR_08: health check every 10min. Pings n8n/Chatwoot/Evolution/OpenAI/Supabase + 24h counts + race detection + orphan batches → events('health_check'). Inactive by default.".
- [ ] **S7: Export JSON** para `n8n/workflows/IGOR_08_Health_Check.json`.
- [ ] **S8: Write audit doc** `docs/workflows/IGOR_08_Health_Check.md`.
- [ ] **S9: Commit** `feat(IGOR_08): health check schedule + 5 service pings + race/orphan detection — first build`.

---

## Task 4: IGOR_06_Chatwoot_Message_Logger

**Wave**: 2 (paralelo com IGOR_05). Dep: IGOR_04 (wave 1).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:173-183 + debt registry):

```text
- Trigger: webhook (POST /webhook/igor/chatwoot)
- Entrada: payload message_created do Chatwoot
- Decisões:
  - body.event === 'message_created' (filtra outros eventos)
  - Se message_type === 'outgoing' e sender.type === 'user' (agente humano):
    → SET conversations.human_locked=true, ai_enabled=false
    → Aplicar label 'atendimento_humano' VIA IGOR_04
    → Insert events('human_assumed')
  - Se sender.type === 'agent_bot' → não trava (é o próprio Igor)
  - Sempre insere `messages` (espelhamento)
- LLM: não
- Mutações: conversations, messages, events; Chatwoot label via IGOR_04
- Observabilidade: events('human_assumed'), events('message_mirrored')
```

**Debt fix**: chamada IGOR_04 com label `atendimento_humano` era ausente. Esta reconstrução adiciona.

**Files:**
- Create: `n8n/workflows/IGOR_06_Chatwoot_Message_Logger.json`
- Create: `n8n/workflows/IGOR_06_Chatwoot_Message_Logger.sdk.ts`
- Create: `fixtures/IGOR_06_message_created_incoming.json`
- Create: `fixtures/IGOR_06_message_created_outgoing_human.json`
- Create: `fixtures/IGOR_06_message_created_outgoing_bot.json`
- Create: `fixtures/IGOR_06_event_other.json` (must NoOp filter)
- Create: `tests/asserts-IGOR_06_Chatwoot_Message_Logger.sql`
- Create: `tests/expected-IGOR_06_Chatwoot_Message_Logger.md`
- Create: `docs/workflows/IGOR_06_Chatwoot_Message_Logger.md`

**Node design**:

1. `webhook` POST `/webhook/igor/chatwoot` (path: `igor/chatwoot`, response: `lastNode`).
2. `if` "event === 'message_created'" → branch A: continue. Branch B: NoOp + log + 200.
3. `code` "Normalize": extract `account_id, conversation_id, contact_id, message_id, message_type, sender_type, content, created_at`.
4. `postgres` "INSERT messages" (UPSERT em msgId).
5. `postgres` INSERT `events('message_mirrored', payload)`.
6. `switch` por `(message_type, sender_type)`:
   - `outgoing` + `user` → HUMAN_TAKEOVER branch.
   - `outgoing` + `agent_bot` → BOT branch (no-op extra).
   - `incoming` → INBOUND branch (no-op extra, mensagem do lead).
7. **HUMAN_TAKEOVER branch**:
   - `postgres` UPDATE `conversations SET human_locked=true, ai_enabled=false, state='human_assigned', updated_at=now() WHERE chatwoot_conversation_id=$1`.
   - `executeWorkflow` chamando `IGOR_04` com `{chatwoot_conversation_id, labels_to_add: ['atendimento_humano', 'ai_disabled'], labels_to_remove: [], custom_attributes: {conversation: {automation_state: 'human_assigned', lead_status: 'humano_em_atendimento'}, contact: {}}}`.
   - `postgres` INSERT `events('human_assumed', payload={conversation_id, agent_user_id, taken_at})`.
8. Merge → response 200 `{ok: true, branch}`.
9. Settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Steps:**

- [ ] **S1-4: Write 4 fixtures** (incoming, outgoing_human, outgoing_bot, event_other).
- [ ] **S5: Write asserts SQL**: 4 entries em `messages` (1 por fixture válida), 1 `human_assumed` event (apenas do outgoing_human), 0 `human_assumed` dos outros, conversations row para outgoing_human com human_locked=true.
- [ ] **S6: Write expected.md** com matriz fixture × branch × output.
- [ ] **S7: Get SDK reference + node types**.
- [ ] **S8: Write SDK code**.
- [ ] **S9: Validate**.
- [ ] **S10: Create workflow** com description "IGOR_06: webhook Chatwoot. INSERT messages espelhamento, IF human takeover → UPDATE conv + CALL IGOR_04 (atendimento_humano) + events. Errors → IGOR_07.".
- [ ] **S11: Export JSON + write audit doc**.
- [ ] **S12: Commit** `feat(IGOR_06): chatwoot logger + IGOR_04 call (atendimento_humano label) — NO SIMPLIFICATIONS rebuild`.

---

## Task 5: IGOR_05_Finalize_Handoff

**Wave**: 2 (paralelo com IGOR_06). Dep: IGOR_04 (wave 1).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:156-171):

```text
- Trigger: callable
- Entrada: { chatwoot_conversation_id, chatwoot_contact_id, lead_id?, handoff_reason, summary, callback_period?, owner_flow }
- Decisões (sequência obrigatória):
  1. UPDATE conversations SET state='human_assigned', ai_enabled=false, human_locked=true, assigned_team_id=...
  2. UPDATE leads SET status='aguardando_atendente', handoff_at=now()
  3. Chamar IGOR_04 com labels_to_add: ['handoff_done','ai_disabled','aguardando_atendente']
  4. Criar private note em Chatwoot via POST /messages com private:true e template padrão
  5. Assign team via POST /api/v1/accounts/{id}/conversations/{c}/assignments body {team_id}
  6. (Opcional) Assignee específico se CHATWOOT_HUMAN_ASSIGNEE_ID setado
  7. INSERT events('handoff_complete', payload)
  8. Enviar mensagem final ao lead (texto fixo). Se DRY_RUN → log
```

**Debt fix**: UPDATE leads ausente, CALL IGOR_04 ausente, sendText gate hardcoded `dry_run_send` sem checar env. Esta reconstrução implementa todos.

**Files:**
- Create: `n8n/workflows/IGOR_05_Finalize_Handoff.json`
- Create: `n8n/workflows/IGOR_05_Finalize_Handoff.sdk.ts`
- Create: `fixtures/IGOR_05_handoff_with_lead.json`
- Create: `fixtures/IGOR_05_handoff_no_lead.json`
- Create: `fixtures/IGOR_05_handoff_compliance.json` (handoff_reason='documento_clinico_sensivel')
- Create: `fixtures/IGOR_05_handoff_dry_run.json` (variável env DRY_RUN=true)
- Create: `tests/asserts-IGOR_05_Finalize_Handoff.sql`
- Create: `tests/expected-IGOR_05_Finalize_Handoff.md`
- Create: `docs/workflows/IGOR_05_Finalize_Handoff.md`

**Node design**:

1. `executeWorkflowTrigger` workflowInputs: `chatwoot_conversation_id` (string), `chatwoot_contact_id` (string), `lead_id` (string opt), `handoff_reason` (string), `summary` (string), `callback_period` (string opt), `owner_flow` (string ∈ after_hours|campaign).
2. `code` "Validate Payload": coerce, defaults.
3. `postgres` "UPDATE conversations":
   ```sql
   UPDATE conversations SET state='human_assigned', ai_enabled=false, human_locked=true, assigned_team_id=$1, updated_at=now()
   WHERE chatwoot_conversation_id=$2
   RETURNING id
   ```
4. `if` "Has lead_id?" → branch A: `postgres` "UPDATE leads":
   ```sql
   UPDATE leads SET status='aguardando_atendente', handoff_at=now(), updated_at=now()
   WHERE id=$1
   RETURNING id, contact_id
   ```
   Branch B: skip.
5. `executeWorkflow` "Call IGOR_04" com `{chatwoot_conversation_id, chatwoot_contact_id, labels_to_add: ['handoff_done','ai_disabled','aguardando_atendente'], labels_to_remove: ['qualificacao_rapida','callback_solicitado'], custom_attributes: {conversation: {automation_state: 'human_assigned', lead_status: 'aguardando_atendente', handoff_reason, handoff_at: timestamp, callback_period}, contact: {}}}`.
6. `httpRequest` "Private Note": POST `/api/v1/accounts/{{CHATWOOT_ACCOUNT_ID}}/conversations/{{chatwoot_conversation_id}}/messages` body:
   ```json
   {
     "content": "<TEMPLATE PT-BR>",
     "private": true,
     "message_type": "outgoing",
     "content_type": "text"
   }
   ```
   **Template PT-BR** (literal no node):
   ```text
   📋 *Resumo automático Igor (handoff {{owner_flow}})*

   Motivo: {{handoff_reason}}
   {{#callback_period}}Período preferido de retorno: {{callback_period}}{{/callback_period}}

   Resumo da conversa:
   {{summary}}

   Lead status: aguardando_atendente
   IA: desligada nesta conversa (ai_enabled=false, human_locked=true)
   ```
7. `httpRequest` "Assign Team": POST `/api/v1/accounts/{{CHATWOOT_ACCOUNT_ID}}/conversations/{{chatwoot_conversation_id}}/assignments` body `{team_id: {{CHATWOOT_HUMAN_TEAM_ID}}}`.
8. `if` "Has assignee?" (`CHATWOOT_HUMAN_ASSIGNEE_ID` not empty) → `httpRequest` POST same endpoint body `{assignee_id}`.
9. `postgres` INSERT `events('handoff_complete', payload={handoff_reason, owner_flow, lead_id, callback_period, summary_snippet})`.
10. **Send final message gated**:
    - `code` "Check send gate": read env `ALLOW_REAL_WHATSAPP_SEND` and `IGOR_DRY_RUN`. Compute `should_send_real = ALLOW_REAL_WHATSAPP_SEND==='true' && IGOR_DRY_RUN!=='true'`.
    - `if` "should_send_real?" → branch A: `httpRequest` POST `{{EVOLUTION_BASE_URL}}/message/sendText/{{EVOLUTION_INSTANCE_NAME}}` body `{number: phone, text: "<MENSAGEM FINAL>"}`. Branch B: `postgres` INSERT `events('dry_run_send', payload={text, reason: 'allow_real_whatsapp_send=false or dry_run=true'})`.
    **Mensagem final** (literal):
    ```text
    Combinado! Já anotei tudo aqui e nossa equipe vai retornar no horário que você preferiu. Qualquer coisa nova, é só me responder. 💛
    ```
11. Merge → output `{ok: true, lead_updated, labels_applied, message_sent, send_mode: 'real'|'dry_run'}`.
12. Settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Steps:**

- [ ] **S1-4: Write 4 fixtures** cobrindo with_lead, no_lead, compliance, dry_run.
- [ ] **S5: Write asserts SQL**: conversations.state='human_assigned' por fixture, leads.status='aguardando_atendente' (apenas with_lead/compliance), 1 events('handoff_complete') por fixture, events('dry_run_send') vs nenhum events('whatsapp_sent') no dry_run path.
- [ ] **S6: Write expected.md**.
- [ ] **S7: Get SDK ref + node types** (executeWorkflowTrigger, code, postgres, executeWorkflow, httpRequest, if).
- [ ] **S8: Write SDK code**.
- [ ] **S9: Validate**.
- [ ] **S10: Create workflow** description "IGOR_05: handoff orquestrado (UPDATE conv + UPDATE leads + IGOR_04 + private note + assign + events + Evolution sendText gated por ALLOW_REAL_WHATSAPP_SEND+IGOR_DRY_RUN). Errors → IGOR_07.".
- [ ] **S11: Export JSON + audit doc**.
- [ ] **S12: Commit** `feat(IGOR_05): finalize handoff completo (UPDATE leads + IGOR_04 call + send gated) — NO SIMPLIFICATIONS rebuild`.

---

## Task 6: IGOR_01_Inbound_AfterHours

**Wave**: 3 (single). Deps: IGOR_02, IGOR_04 (waves 1).

**Contrato literal** (de IMPLEMENTATION_PLAN.md:93-112):

```text
- Trigger: webhook (POST /webhook/igor/inbound)
- Entrada: payload Evolution MESSAGES_UPSERT
- Decisões determinísticas (ORDEM EXATA — 12 condições):
  1. payload.data.key.fromMe === true → NoOp
  2. settings.ai_enabled_global === false → NoOp + log
  3. settings.workflows_enabled.IGOR_01 === false → NoOp
  4. Normalizar phone (5511XXXXXXXXX). Inválido → INSERT events('invalid_phone') + NoOp
  5. Lookup contacts por phone. Se do_not_contact=true → NoOp + label 'optout'
  6. Lookup conversations. Se human_locked=true OR ai_enabled=false → NoOp
  7. Se contato em campaign_contacts com status IN ('sent','delivered','replied','interested') → roteia para IGOR_12 e sai
  8. Verificar janela: hora atual ∈ [AFTER_HOURS_END, AFTER_HOURS_START) em TIMEZONE → NoOp (dentro do expediente)
  9. Verificar feriado/fim-de-semana via settings.holidays. Se feriado → settings.holiday_policy (P1)
  10. Adquirir Redis lock igor:lock:inbound:{phone} com SET NX EX 30. Falha → RPUSH igor:batch:{phone} e sair
  11. Chamar IGOR_02_Media_Normalizer se messageType ≠ text
  12. Chamar IGOR_03_Agent_AfterHours com payload normalizado
- LLM: não (router puro)
- Mutações: events, messages, conversations.state='ai_after_hours', label 'fora_expediente', Redis lock
- Observabilidade: log inbound_received, inbound_blocked (motivo), inbound_routed
```

**Debt fix**: TUDO simplificado antes. Esta reconstrução implementa as 12 condições + Redis batching ASX-style (nodes 16-23) + label fora_expediente via IGOR_04.

**Redis batching pattern (ASX 07 nodes 16-23 — leitura mandatória):**
Subagente deve ler `docs/referencias/workflows-asx/07_*` e replicar o padrão:
1. `redis` SET `igor:lock:inbound:{phone}` value `{msgId}` NX EX 30 → returnsValue: `'OK'` or null.
2. `if` "Got lock?" → branch A (continue), branch B (didn't get lock):
   - `redis` RPUSH `igor:batch:{phone}` value `{msgId, text, timestamp}` (serialized JSON).
   - `redis` EXPIRE `igor:batch:{phone}` 60 (renew TTL).
   - Output `{batched: true, reason: 'lock_held'}` → NoOp end.
3. **Got lock branch (continuation)**:
   - `wait` 3 seconds (let other fragments arrive).
   - `redis` LRANGE `igor:batch:{phone}` 0 -1 → fragments array.
   - `redis` DEL `igor:batch:{phone}`.
   - `code` "Merge fragments": current message + LRANGE results → consolidated text.
   - Proceed to step 11 (IGOR_02) or step 12 (IGOR_03).
4. After done, `redis` DEL `igor:lock:inbound:{phone}` (release).

**Files:**
- Create: `n8n/workflows/IGOR_01_Inbound_AfterHours.json`
- Create: `n8n/workflows/IGOR_01_Inbound_AfterHours.sdk.ts`
- Create: `fixtures/IGOR_01_evolution_text_afterhours.json`
- Create: `fixtures/IGOR_01_evolution_text_inside_hours.json`
- Create: `fixtures/IGOR_01_evolution_fromme.json`
- Create: `fixtures/IGOR_01_evolution_invalid_phone.json`
- Create: `fixtures/IGOR_01_evolution_optout.json` (do_not_contact=true preset)
- Create: `fixtures/IGOR_01_evolution_human_locked.json`
- Create: `fixtures/IGOR_01_evolution_campaign_active.json`
- Create: `fixtures/IGOR_01_evolution_audio_afterhours.json` (deve chamar IGOR_02 → IGOR_03)
- Create: `fixtures/IGOR_01_evolution_holiday.json`
- Create: `fixtures/IGOR_01_evolution_batch_lock_held.json` (2 fragmentos)
- Create: `tests/asserts-IGOR_01_Inbound_AfterHours.sql`
- Create: `tests/expected-IGOR_01_Inbound_AfterHours.md`
- Create: `docs/workflows/IGOR_01_Inbound_AfterHours.md`

**Node design (high-level — 12 condições em ordem)**:

1. `webhook` POST `/webhook/igor/inbound`.
2. `code` "Normalize Payload": extract `phone (raw), msgId, fromMe, messageType, text, caption, mimeType, media_url, media_base64, chatwoot_conversation_id, chatwoot_contact_id, instance, timestamp`.
3. `postgres` INSERT `events('inbound_received', payload)`.
4. **Condition 1**: `if` "fromMe?" → true: events('inbound_blocked', reason='fromMe') + NoOp 200.
5. `postgres` "Read settings":
   ```sql
   SELECT
     (SELECT value FROM settings WHERE key='ai_enabled_global') as ai_enabled_global,
     (SELECT value FROM settings WHERE key='workflows_enabled') as workflows_enabled,
     (SELECT value FROM settings WHERE key='holidays') as holidays,
     (SELECT value FROM settings WHERE key='holiday_policy') as holiday_policy,
     (SELECT value FROM settings WHERE key='after_hours_start') as after_hours_start,
     (SELECT value FROM settings WHERE key='after_hours_end') as after_hours_end,
     (SELECT value FROM settings WHERE key='timezone') as timezone
   ```
6. **Condition 2**: `if` "ai_enabled_global=false" → events('inbound_blocked', reason='ai_disabled_global') + NoOp.
7. **Condition 3**: `if` "workflows_enabled.IGOR_01=false" → events('inbound_blocked', reason='workflow_disabled') + NoOp.
8. **Condition 4**: `code` "Normalize Phone" (regex 55+DDD+9 digits). `if` "valid?" → false: events('invalid_phone') + NoOp.
9. **Condition 5**: `postgres` SELECT contacts WHERE phone=$1. `if` "do_not_contact=true" → executeWorkflow IGOR_04 `{labels_to_add: ['optout']}` + events('inbound_blocked', reason='opt_out') + NoOp.
10. **Condition 6**: `postgres` SELECT conversations WHERE chatwoot_conversation_id=$1. `if` "human_locked OR NOT ai_enabled" → events('inbound_blocked', reason='human_locked_or_ai_disabled') + NoOp.
11. **Condition 7**: `postgres` SELECT campaign_contacts WHERE contact_id=$1 AND status IN (...). `if` "found?" → executeWorkflow IGOR_12 com payload + return.
12. **Condition 8**: `code` "Check business hours": parse timezone, current time, compare with after_hours window. `if` "inside business hours?" → events('inbound_blocked', reason='inside_hours') + NoOp.
13. **Condition 9**: `code` "Check holiday": `holidays.includes(YYYY-MM-DD)`. `if` "holiday?" → apply `holiday_policy` (P1: trata como after_hours; document this in note).
14. **Condition 10 — Redis batching** (pattern ASX nodes 16-23 acima):
    - `redis` SET NX EX → `if` got lock? → batch or proceed.
    - Batch branch: RPUSH + EXPIRE + return `{batched:true}`.
    - Proceed branch: wait 3s + LRANGE + DEL → merged text.
15. **Condition 11**: `if` "messageType ≠ text" → `executeWorkflow` IGOR_02 com `{phone, msgId, messageType, media_url, media_base64, caption, mimeType, chatwoot_conversation_id}` → receive `normalized_text, safety_flags, should_handoff, handoff_reason`.
16. UPSERT conversations: `state='ai_after_hours', ai_enabled=true (if null)`. UPSERT messages.
17. executeWorkflow IGOR_04 com `{labels_to_add: ['fora_expediente'], custom_attributes: {conversation: {automation_state: 'ai_after_hours'}}}`.
18. **Condition 12**: `executeWorkflow` IGOR_03 com `{phone, msgId, chatwoot_conversation_id, chatwoot_contact_id, normalized_text, safety_flags, should_handoff, handoff_reason, fragments_count}`.
19. Redis DEL lock.
20. Response 200 `{ok, branch}`.
21. Settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Steps:**

- [ ] **S1: Read `docs/referencias/workflows-asx/07_*`** para Redis batching pattern (nodes 16-23 são referência).
- [ ] **S2-11: Write 10 fixtures** (uma por cenário acima).
- [ ] **S12: Write asserts SQL** abrangendo TODAS as 12 condições — events corretos por fixture, escolha de branch, ausência de calls IGOR_03 nos bloqueados, presença de calls IGOR_03 nos aprovados.
- [ ] **S13: Write expected.md** com matriz fixture × condição × branch × output.
- [ ] **S14: Get SDK reference + node types** (webhook, code, postgres, redis, if, switch, executeWorkflow, wait, set, merge).
- [ ] **S15: Write SDK code** implementando 12 condições em ordem + Redis batching ASX-style.
- [ ] **S16: Validate**.
- [ ] **S17: Create workflow** description "IGOR_01: roteador inbound after-hours. 12 condições determinísticas em ordem + Redis lock+batching (SET NX EX 30 + RPUSH/LRANGE/DEL) + calls IGOR_02 (mídia)/IGOR_03 (agent)/IGOR_04 (labels)/IGOR_12 (campanha). Errors → IGOR_07.".
- [ ] **S18: Export JSON + audit doc**.
- [ ] **S19: Commit** `feat(IGOR_01): roteador inbound after-hours (12 condições + Redis batching + calls IGOR_02/03/04) — NO SIMPLIFICATIONS rebuild`.

---

## Task 7: IGOR_03_Agent_AfterHours

**Wave**: 4 (single). Deps: IGOR_02, IGOR_04, IGOR_05, IGOR_AUX_save_lead_partial, IGOR_AUX_update_conversation_state.

**Contrato literal** (de IMPLEMENTATION_PLAN.md:129-142 + spec §5-§12 — leitura OBRIGATÓRIA):

```text
- Trigger: callable
- Entrada: payload normalizado de IGOR_01 ({phone, msgId, chatwoot_conversation_id, chatwoot_contact_id, normalized_text, safety_flags, should_handoff, handoff_reason, fragments_count})
- Decisões pré-LLM:
  - should_handoff do normalizer → pular conversa e chamar IGOR_05 direto com motivo compliance.
- Comportamento conversacional (Alice):
  - Saudar (apenas primeira interação), coletar nome, objetivo_principal, callback_period.
  - Memória: Postgres Chat Memory ligada ao Supabase, key = chatwoot_conversation_id.
  - Tools (4): get_conversation_state, update_conversation_state, save_lead_partial, request_handoff (= IGOR_05).
- Saída: mensagem em Chatwoot via POST messages. Se DRY_RUN, log events('dry_run_send').
- LLM: SIM gpt-5.4-mini (igor_openai).
- Sub-workflows: IGOR_04, IGOR_05, IGOR_AUX_*.
- Mutações: messages, leads (parcial), conversations.state, labels, custom_attributes.
- Observabilidade: events('after_hours_started','after_hours_name_collected','after_hours_objective_collected','callback_collected','agent_response','agent_routed_to_handoff','agent_error').
```

**Debt fix**: happy path conversacional nunca foi validado, reply path estruturado ausente. Esta reconstrução implementa fluxo completo.

**System prompt PT-BR (literal — usar EXATO no node, expandir do spec §5)**: subagente lê `docs/logica-fluxo-igor-receptivo-fora-expediente.md` §5, §6, §11 e monta system prompt cobrindo: persona Alice, personalidade WhatsApp, conduta obrigatória, conduta proibida, campos a coletar, sequência (saudação→nome→objetivo→callback→handoff), uso de tools (quando chamar cada).

**Reply path estruturado (literal)**:
- `code` "Format AI Output": split AI response by `\n\n` (paragraph) or `||` (explicit split marker) → array de mensagens.
- `splitOut` em items.
- `splitInBatches` size 1.
- `httpRequest` Chatwoot "presence composing" `POST /api/v1/accounts/{id}/conversations/{c}/messages` with `message_type=incoming`? — verificar API correta; alternativa: typing indicator via Evolution `POST /chat/sendPresence/{instance}` com `presence=composing`, `delay=<calculated from msg length>`.
- `code` "Send gate" verificando `ALLOW_REAL_WHATSAPP_SEND` + `IGOR_DRY_RUN`.
- `if` should_send_real?:
  - Branch A real: `httpRequest` Evolution `/message/sendText/{instance}` body `{number, text}`.
  - Branch B dry: `postgres` INSERT events('dry_run_send', payload).
- `wait` 2 segundos.
- `postgres` INSERT events('agent_response', payload={message, msg_index}).
- Continue loop until batches empty.

**Files:**
- Create: `n8n/workflows/IGOR_03_Agent_AfterHours.json`
- Create: `n8n/workflows/IGOR_03_Agent_AfterHours.sdk.ts`
- Create: `fixtures/IGOR_03_first_message_text.json`
- Create: `fixtures/IGOR_03_compliance_fast_path.json` (should_handoff=true from normalizer)
- Create: `fixtures/IGOR_03_collecting_name.json`
- Create: `fixtures/IGOR_03_collecting_objective.json`
- Create: `fixtures/IGOR_03_collecting_callback.json`
- Create: `fixtures/IGOR_03_handoff_ready.json` (todos os 3 campos coletados)
- Create: `fixtures/IGOR_03_dry_run.json`
- Create: `tests/asserts-IGOR_03_Agent_AfterHours.sql`
- Create: `tests/expected-IGOR_03_Agent_AfterHours.md`
- Create: `docs/workflows/IGOR_03_Agent_AfterHours.md`

**Node design (high-level)**:

1. `executeWorkflowTrigger` workflowInputs (10 campos).
2. `code` "Validate Payload": coerce, defaults.
3. `if` "Compliance fast-path?" (`should_handoff || safety_flags.clinical || safety_flags.sensitive_image || safety_flags.payment_proof`) → branch A compliance:
   - `postgres` INSERT events('agent_routed_to_handoff', payload={handoff_reason, safety_flags}).
   - `executeWorkflow` IGOR_05 com `{chatwoot_conversation_id, chatwoot_contact_id, handoff_reason, summary: 'Mídia/conteúdo sensível detectado pelo normalizer.', owner_flow: 'after_hours'}`.
   - Return `{ok, branch: 'compliance'}`.
4. Branch B normal:
   - `langchain.agent` node:
     - Model: `@n8n/n8n-nodes-langchain.lmChatOpenAi` model=`gpt-5.4-mini` (or canonical name returned by `get_node_types`), credential `igor_openai`.
     - Memory: `@n8n/n8n-nodes-langchain.memoryPostgresChat` credential `igor_supabase_postgres`, sessionKey=`after_hours_{{phone}}`, contextWindow=25.
     - Tools (4 via `@n8n/n8n-nodes-langchain.toolWorkflow`):
       - `set_label_and_attr` → IGOR_04 workflowId.
       - `save_lead_partial` → IGOR_AUX_save_lead_partial workflowId `hRogDlGsgQxGwnD8`.
       - `update_conversation_state` → IGOR_AUX_update_conversation_state workflowId `mFuRPrGGt7yWVqEw`.
       - `request_handoff` → IGOR_05 workflowId.
     - System prompt: literal PT-BR (ver acima).
     - User input: `{{normalized_text}}`.
     - Output: text response.
5. `postgres` INSERT events('agent_response', payload={response_snippet}).
6. **Reply path estruturado** (pattern descrito acima): Format → SplitOut → SplitInBatches → Presence composing (Evolution typing) → Send gate IF → Send WhatsApp OR dry_run → Wait 2s → Log Success.
7. Output `{ok, branch: 'agent', messages_sent: N, mode: 'real'|'dry'}`.
8. Settings: `errorWorkflow: 'IGOR_07_Error_Logger'`, `active: false`.

**Steps:**

- [ ] **S1: Read `docs/logica-fluxo-igor-receptivo-fora-expediente.md` §5-§12** — persona Alice, conduta, sequência conversacional, tools, decisões.
- [ ] **S2: Verify credentials**: `igor_openai`, `igor_supabase_postgres`, `igor_chatwoot_api`, `igor_evolution_api` ALL exist. Se faltar, STOP e reporte.
- [ ] **S3: Verify workflow IDs** dos sub-workflows callable: IGOR_04 (será criado na wave 1), IGOR_05 (wave 2), AUX_save_lead_partial `hRogDlGsgQxGwnD8`, AUX_update_conversation_state `mFuRPrGGt7yWVqEw`. Usar IDs canonical do n8n via `mcp__n8n-mcp__search_workflows`.
- [ ] **S4-10: Write 7 fixtures** cobrindo first message, compliance, collecting name, collecting objective, collecting callback, handoff ready, dry run.
- [ ] **S11: Write asserts SQL** validando: events('after_hours_started') no first; events('agent_routed_to_handoff') no compliance; events('agent_response') a cada resposta; leads.objective updated após collecting_objective; leads.callback_period updated após collecting_callback; events('handoff_complete') após handoff_ready; events('dry_run_send') no dry_run path.
- [ ] **S12: Write expected.md** mapeando fixture → branch → tools called → output.
- [ ] **S13: Write system prompt PT-BR completo** baseado no spec §5-§11 (cole literal no SDK code).
- [ ] **S14: Get SDK reference + node types** (executeWorkflowTrigger, code, if, postgres, executeWorkflow, langchain.agent, lmChatOpenAi, memoryPostgresChat, toolWorkflow, splitOut, splitInBatches, wait, httpRequest, merge).
- [ ] **S15: Write SDK code** implementando compliance fast-path + agente + reply path estruturado.
- [ ] **S16: Validate**.
- [ ] **S17: Create workflow** description "IGOR_03: agente Alice (gpt-5.4-mini + Postgres Chat Memory) + compliance fast-path + reply path (Format → SplitOut → SplitInBatches → Presence → Send gated → Wait → Log). 4 tools: IGOR_04/05, AUX_save_lead/update_conv. Errors → IGOR_07.".
- [ ] **S18: Export JSON + audit doc** (incluir prompt literal).
- [ ] **S19: Commit** `feat(IGOR_03): agente conversacional Alice completo + compliance fast-path + reply path estruturado — NO SIMPLIFICATIONS rebuild`.

---

## Fase C — Integrated validation (post-rebuild)

Após Tasks 1-7 todas reportarem `done_pending_smoke` no orchestrator-state.json:

### C.1 — Two-stage build review (orquestrador)

Para cada workflow construído, rodar **2 reviews paralelos**:

1. **`feature-dev:code-reviewer`** sobre `n8n/workflows/IGOR_XX_*.json` + `*.sdk.ts` → schema, ESLint, padrões.
2. **Flow review subagent** (general-purpose) com prompt:
   ```
   Compare `n8n/workflows/IGOR_XX_*.json` (implementação) com `docs/IMPLEMENTATION_PLAN.md §2 IGOR_XX` e `docs/logica-fluxo-igor-receptivo-fora-expediente.md` (contratos).
   Liste TODOS os gaps de cobertura, decisões ausentes, branches faltantes, gates omitidos.
   Não aceitar "TODO v2" ou stubs.
   Resultado: gap_count, gaps[{node_missing, decision_skipped, contract_section}].
   ```

Output esperado: zero gaps por workflow. Gaps detectados → SendMessage ao subagente original com lista de correções.

### C.2 — Smoke tests (orquestrador)

Para cada workflow, na ordem das waves:

1. Carregar fixture(s).
2. `mcp__n8n-mcp__execute_workflow` com fixture.
3. Esperar conclusão (Monitor execution).
4. Rodar asserts.sql via postgres MCP.
5. Pass = todos asserts retornam expected.

10 smoke tests obrigatórios (de IMPLEMENTATION_PLAN.md §10): texto fora expediente, áudio fora expediente, imagem com caption, documento clínico, fromMe, opt-out, human takeover, handoff completo, dry_run send, batch lock held.

### C.3 — Aprovação usuário

Quando C.1 e C.2 verdes:

1. Atualizar `docs/VALIDATION_REPORT.md` com IDs, status, asserts results.
2. Atualizar `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` marcando todos itens como ✅ resolvidos.
3. Apresentar ao usuário para aprovação de ativação em produção (toggle `active: true` no UI do n8n).

---

## Self-Review (pós-escrita do plano)

### Spec coverage check

- IGOR_04 contract (labels merge + custom_attributes branch) → Task 1 ✅
- IGOR_02 contract (audio real + image real + doc heurística + text + unknown) → Task 2 ✅
- IGOR_08 contract (schedule + 5 pings + counts + race + orphans) → Task 3 ✅
- IGOR_06 contract (logger + human takeover + IGOR_04 call) → Task 4 ✅
- IGOR_05 contract (UPDATE conv + UPDATE leads + IGOR_04 + private note + assign + events + sendText gated) → Task 5 ✅
- IGOR_01 contract (12 condições + Redis batching + calls IGOR_02/03/04) → Task 6 ✅
- IGOR_03 contract (compliance fast-path + agente conversacional + reply path estruturado) → Task 7 ✅

### Placeholder scan

- ⚠️ "TODO" no plano: apenas dentro de citações de debt doc (negativas, marcando o que NÃO fazer). OK.
- ✅ Sem "TBD", "fill in later", "implement later".
- ✅ Cada step indica ação concreta + arquivo/comando/critério.
- ⚠️ Prompts literais (PT-BR de imagem, PT-BR de Alice, template private note, mensagem final) — fornecidos literais ou referenciados ao spec onde literal cabe (Alice é longo demais para inline; subagente lê spec §5-§11).

### Type/name consistency

- Workflow IDs: `IGOR_AUX_save_lead_partial=hRogDlGsgQxGwnD8`, `IGOR_AUX_update_conversation_state=mFuRPrGGt7yWVqEw`, `IGOR_07_Error_Logger=ZrsbaSTlW5bqMEaS`. Verificados via `mcp__n8n-mcp__search_workflows` antes do plano (Fase A pós-revert).
- Credentials canonical: `igor_chatwoot_api`, `igor_evolution_api`, `igor_openai`, `igor_supabase_postgres`, `igor_redis`. Subagente verifica existência via MCP antes de criar workflow.
- Settings keys: `ai_enabled_global`, `workflows_enabled` (JSON), `holidays`, `holiday_policy`, `after_hours_start`, `after_hours_end`, `timezone`. Definidos em migration `003_settings_seed.sql` (não criar nesta fase).
- Tags canonical: `igor`, `inbound`, `tool`, `agent`, `fase-b-rebuild`. Por workflow conforme contrato.

### Workflow ID forward references

- IGOR_06, IGOR_05 chamam IGOR_04 → o subagente da wave 2 obtém o ID via `mcp__n8n-mcp__search_workflows` query="IGOR_04_Tool_Labels_Attributes" antes de escrever o SDK.
- IGOR_01 chama IGOR_02/03/04 → subagente da wave 3 obtém todos os 3 IDs.
- IGOR_03 chama IGOR_04/05 + AUX → subagente da wave 4 obtém todos os 4 IDs.
- Não hardcodar IDs em fixtures (usar nomes de workflow nos asserts e MCP resolve).

---

## Execution handoff

Plano completo e salvo em `docs/superpowers/plans/2026-05-15-fase-b-inbound-rebuild.md`.

**Próxima ação**: usar `superpowers:subagent-driven-development` para executar Wave 1 (3 subagentes paralelos: Task 1, Task 2, Task 3) em worktrees isolados via `superpowers:using-git-worktrees`.
