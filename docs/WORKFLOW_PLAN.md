# Plano — Fase 4: Workflows IGOR_01..IGOR_13 no n8n

## Contexto

Fase 0 (auditoria) e Fase 2 (Supabase) estão concluídas. O usuário aplicou as 6 migrations (10 tabelas), o importador rodou (137 leads em `contacts`/`leads`/`campaign_contacts`), o Chatwoot tem 34 labels + 15 custom attributes + team `Atendimento Humano` + agent_bot Alice com token próprio.

Falta agora a Fase 4 do `AGENTS.md`: **criar os 13 workflows IGOR_* no n8n**, todos inativos, importáveis via API, sem mexer no webhook real da Evolution. Os contratos funcionais e DDL já estão fixados em `docs/IMPLEMENTATION_PLAN.md` (§2, §3, §4, §5). A referência técnica de stack é `docs/referencias/workflows-asx/07-FB-Leads-Inbound.json` (e os 10 callables/auxiliares ASX) — o stack é idêntico (Evolution → n8n → LangChain agent → Supabase + Redis + Chatwoot).

### Decisões já confirmadas
- Modelo conversacional: `gpt-5.4-mini` (validado em `api.openai.com/v1/models`).
- Modelo de transcrição: `gpt-4o-transcribe`.
- Template da campanha: texto fixo aprovado, sem LLM em `IGOR_11`.
- Mídia: URL no MinIO S3 da Evolution (não copiar para Storage).
- Feriado = comportamento de fora-de-expediente.
- Threshold opt-out: 3 em 20 envios → auto-pausa.
- Handoff copies: 4 textos prontos no `IMPLEMENTATION_PLAN.md §13.9`.

### Restrições críticas
- Cada workflow IGOR_* nasce **inativo**.
- `settings.workflows_enabled.IGOR_XX = false` no seed (já aplicado) — IFs de proteção respeitam essa flag.
- Webhook real da Evolution **não é tocado nesta fase** — apenas registrado nos JSONs com `path` canônico. O bind Evolution↔Chatwoot e o set do webhook ficam para a Fase 5.
- `ALLOW_REAL_WHATSAPP_SEND=false` continua valendo: nodes de `sendText` envolvidos em IF que checa essa flag.
- Credentials n8n são criadas pelo usuário no painel n8n com os nomes canônicos do `IMPLEMENTATION_PLAN.md §7`. Os JSONs referenciam por nome — n8n liga automaticamente.

### Como construo

- **Skills do n8n** (já carregados nesta sessão) são os manuais de referência: `n8n-workflow-patterns` (arquitetura), `n8n-expression-syntax` (`{{$json.body.X}}`, `$node["X"].json.Y`), `n8n-code-javascript` (`$input.all()`, return `[{json:...}]`), `n8n-node-configuration` (displayOptions, operation-aware), `n8n-mcp-tools-expert` (formatos de nodeType, padrões). E o `ai_agent_workflow.md` da pasta do skill cobre Agent + Model + Memory + Tools.
- **Padrão técnico**: dissecação node-by-node do ASX `07-FB-Leads-Inbound.json` (42 nodes) já feita — replico mecânicas (webhook → set → switch → batching Redis → agent + memory + tools → format → split → send), sem copiar regras de negócio.
- **Execução**: `N8N_API_KEY` + `N8N_BASE_URL` do `.env`. Chamadas REST via curl/script: `POST /api/v1/workflows` cria, `PUT /api/v1/workflows/{id}` atualiza, `POST /api/v1/workflows/{id}/activate` ativa. Mesma abordagem que usei para Chatwoot na Fase 3.
- **Validação**: a própria API n8n recusa JSON malformado no `POST` com erro descritivo. Iteração: import → erro → fix → reimport. Após import, execução manual com fixture via `POST /api/v1/workflows/{id}/execute` confirma comportamento end-to-end.

---

## Sequenciamento — 4 blocos com checkpoints

Não vou entregar os 13 workflows de uma vez. Cada bloco tem teste mínimo e aprovação antes do próximo.

### Bloco 1 — Esqueleto operacional (5 workflows, sem agente)

Objetivo: pipeline completo recebe webhook → loga → bloqueia/roteia → sem responder. Permite testar Supabase/Chatwoot/Redis sem o custo de LLM.

| # | Workflow | Tipo | Função mínima |
|---|---|---|---|
| 07 | `IGOR_07_Error_Logger` | errorTrigger | INSERT events('infra_error', payload) — usado por todos os outros via `errorWorkflow` |
| 04 | `IGOR_04_Tool_Labels_Attributes` | executeWorkflowTrigger (callable) | GET labels atuais → merge → PATCH; também patch de custom_attributes |
| 06 | `IGOR_06_Chatwoot_Message_Logger` | webhook | Recebe `message_created` do Chatwoot → se `sender.type='user'` (humano), trava IA; espelha em `messages` |
| 02 | `IGOR_02_Media_Normalizer` | executeWorkflowTrigger (callable) | Recebe payload Evolution → switch por messageType → audio/image/document/text → retorna `normalized_text` + `safety_flags` |
| 01 | `IGOR_01_Inbound_AfterHours` | webhook | Recebe Evolution → normaliza payload → matriz de bloqueio determinístico → chama IGOR_02 → log `inbound_routed` — **sem chamar agente ainda (IGOR_03 entra no Bloco 2)** |

**Teste de aceitação do Bloco 1** (sem IA, sem WhatsApp real):
- Disparar webhook com `fixtures/evolution-fromme.json` → workflow deve sair com NoOp e gravar `events('inbound_blocked', from_me)`.
- Disparar com `evolution-text.json` em conversa marcada `human_locked=true` → bloqueio.
- Disparar com `evolution-audio.json` → IGOR_02 transcreve, grava em `messages.normalized_text`.
- Disparar com `evolution-document.json` clínico → `safety_flags.clinical=true`, `should_handoff=true`.

### Bloco 2 — Receptivo conversacional (3 workflows com agente)

Objetivo: Alice responde de fato após hora.

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 05 | `IGOR_05_Finalize_Handoff` | executeWorkflowTrigger (callable) | UPDATE conversations/leads → labels via IGOR_04 → private note Chatwoot → assignment → INSERT events('handoff_complete') |
| 03 | `IGOR_03_Agent_AfterHours` | executeWorkflowTrigger (callable) | LangChain Agent com `gpt-5.4-mini` + Postgres Chat Memory + 4 tools (toolWorkflow apontando para callables) |
| 01 | `IGOR_01` (update) | webhook | Agora roteia para IGOR_03 após IGOR_02 quando passar bloqueios |

**Estrutura interna do IGOR_03** (igual padrão ASX 07, adaptado):
- `@n8n/n8n-nodes-langchain.agent` (Conversational Agent)
- Model: `@n8n/n8n-nodes-langchain.lmChatOpenAi` com `model=gpt-5.4-mini`, temperature 0.3
- Memory: `@n8n/n8n-nodes-langchain.memoryPostgresChat` com credential `igor_supabase_postgres`, sessionKey = `after_hours_{{ phone }}`, contextWindow 15
- Tools (todos `@n8n/n8n-nodes-langchain.toolWorkflow`):
  - `set_label_and_attr` → IGOR_04
  - `save_lead_partial` → mini callable que faz UPSERT em leads (parte do Bloco 2)
  - `update_conversation_state` → outro mini callable
  - `trigger_handoff` → IGOR_05
- System prompt: template PT-BR derivado do que está no `IMPLEMENTATION_PLAN.md §2 IGOR_03`, com guardrails (não diagnosticar, não prometer agenda, não comentar mídia clínica).

**Teste de aceitação do Bloco 2**:
- Mensagem fora do horário → Alice saúda, pergunta nome, coleta objetivo, coleta callback_period, chama `trigger_handoff`.
- Em qualquer momento se houver `safety_flags.clinical=true` → handoff imediato com texto §9.2.
- Após handoff, nova mensagem do mesmo phone → IGOR_01 detecta `human_locked=true` e bloqueia.

### Bloco 3 — Health check e auxiliares (1 workflow + 2 mini-callables)

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 08 | `IGOR_08_Health_Check` | scheduleTrigger (10 min) | Ping Evolution, Chatwoot, Supabase. SQL snapshot. INSERT events('health_check'). |
| — | `IGOR_AUX_save_lead_partial` | callable | Tool usado por IGOR_03/IGOR_13. UPSERT em leads com campos parciais. |
| — | `IGOR_AUX_update_conversation_state` | callable | Tool. UPDATE conversations.state + ai_enabled. |

**Teste de aceitação**: rodar IGOR_08 manualmente, ver `events('health_check')` com payload de status.

### Bloco 4 — Campanha (4 workflows)

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 11 | `IGOR_11_Campaign_Message_Generator` | callable | Carrega `campaign_runs.message_template`, substitui `{nome}`, retorna `sent_message`. **Sem LLM.** |
| 10 | `IGOR_10_Campaign_Dispatcher` | scheduleTrigger (1 min, seg-sex) | Janela + rate limit + revalidação → chama IGOR_11 → envia via Evolution (gated por `ALLOW_REAL_WHATSAPP_SEND`) |
| 12 | `IGOR_12_Campaign_Inbound_Handler` | callable (chamado por IGOR_01) | Roteia resposta de lead em campanha. Classifica intent. Chama IGOR_13 ou aplica opt-out. |
| 13 | `IGOR_13_Agent_Campaign` | callable | Mesmo padrão do IGOR_03 mas system prompt diferente: oferta, valor, coleta callback. |

`IGOR_09_Campaign_Importer` **não vira workflow n8n** — o script Python `scripts/import-kommo-csv.py` já cumpre essa função (decisão de 2026-05-14 — usuário aprovou implicitamente ao rodar `--apply` com sucesso).

**Teste de aceitação do Bloco 4**:
- `IGOR_10` em modo dry-run (`IGOR_DRY_RUN=true`) → gera mensagem, loga `events('dry_run_send')`, marca `campaign_contacts.status='sent'`, **não chama Evolution**.
- Reply do lead com "tenho interesse" → IGOR_01 detecta campanha ativa → roteia para IGOR_12 → IGOR_12 classifica como `interested` → chama IGOR_13 → Alice coleta callback → handoff.
- Reply "para" → IGOR_12 detecta opt-out → `contacts.do_not_contact=true`, mensagem §9.4 enviada (ou logada em DRY_RUN), label `optout` aplicada.

---

## Padrão técnico replicado do ASX (sem copiar regras)

Para cada workflow, replico **mecânicas** do ASX 07 e callables:

| Mecânica ASX | Aplicação no Igor |
|---|---|
| Webhook path canônico (`asx-sdr`) | `igor/inbound`, `igor/chatwoot`, `igor/campaign-reply` |
| Set node para extrair campos do payload Evolution | Mesmo padrão em IGOR_01 e IGOR_12 |
| Switch por messageType | IGOR_02 |
| Base64 → File → `@n8n/n8n-nodes-langchain.openAi` audio.transcribe | IGOR_02 audio branch (mas modelo `gpt-4o-transcribe` em vez de Whisper-1) |
| Base64 → File → `@n8n/n8n-nodes-langchain.openAi` image.analyze | IGOR_02 image branch (modelo `gpt-4o-mini` para visão, prompt restritivo: tipo clínico → flag, sem opinião) |
| Redis Push (key=phone) → Wait 10s → Redis Get → Code "Parse Batch" → IF Last Message | IGOR_01 batching (chave: `igor:batch:{phone}`, TTL 60s via SET EX) |
| `IF last_match_key === current_match_key` para detectar última msg | Mesmo Code node em IGOR_01 |
| Postgres SQL com CTEs para lookup de estado | IGOR_01 lookup_state (contacts + conversations + active_campaigns) |
| Switch para roteamento (already_qualified / etc) | IGOR_01 Switch Routing (block / after_hours / campaign / unknown) |
| `@n8n/n8n-nodes-langchain.agent` + Model + Memory + toolWorkflow | IGOR_03, IGOR_13 |
| Postgres Chat Memory com sessionKey = `{role}_{{ phone }}` | IGOR_03 sessionKey = `after_hours_{{ phone }}`, IGOR_13 = `campaign_{{ phone }}` |
| Format AI Output → SplitOut → SplitInBatches → Presence Composing → Send WhatsApp → Wait 2s | IGOR_03 e IGOR_13 reply path, mas Send WhatsApp gated por IF `ALLOW_REAL_WHATSAPP_SEND=true AND IGOR_DRY_RUN=false` |
| `errorWorkflow` setting em todos os workflows | Todos apontam para `IGOR_07_Error_Logger` |
| Log duplo (ia_messages + events) | Igor usa só `messages` (unificada) + `events`, conforme `IMPLEMENTATION_PLAN §5` |

---

## Arquivos a criar/modificar

**Criar em `n8n/workflows/` (13 + 2 mini-callables = 15 JSONs):**
```
IGOR_01_Inbound_AfterHours.json
IGOR_02_Media_Normalizer.json
IGOR_03_Agent_AfterHours.json
IGOR_04_Tool_Labels_Attributes.json
IGOR_05_Finalize_Handoff.json
IGOR_06_Chatwoot_Message_Logger.json
IGOR_07_Error_Logger.json
IGOR_08_Health_Check.json
IGOR_10_Campaign_Dispatcher.json
IGOR_11_Campaign_Message_Generator.json
IGOR_12_Campaign_Inbound_Handler.json
IGOR_13_Agent_Campaign.json
IGOR_AUX_save_lead_partial.json
IGOR_AUX_update_conversation_state.json
```
(IGOR_09 fica como script Python já existente.)

**Criar em `scripts/`:**
```
import-workflows.sh        # POST /api/v1/workflows com cada JSON
export-workflows.sh        # GET /api/v1/workflows e salva em n8n/backups/
test-workflow.sh           # POST /api/v1/workflows/{id}/execute com fixture
```

**Criar em `fixtures/` (já listado no IMPLEMENTATION_PLAN §8):**
```
evolution-text.json
evolution-audio.json
evolution-image.json
evolution-document.json
evolution-fromme.json
evolution-group.json
chatwoot-message-created-incoming.json
chatwoot-message-created-outgoing-bot.json
chatwoot-message-created-outgoing-human.json
campaign-reply-text.json
campaign-reply-optout.json
campaign-reply-price.json
campaign-reply-sensitive.json
```

**Criar em `docs/workflows/` (1 .md por workflow):**
Documento curto com: trigger, contrato de entrada, lista de nodes em ordem, propósito de cada Code node crítico, observabilidade esperada. Não duplica o IMPLEMENTATION_PLAN — complementa.

---

## Credentials n8n que o usuário precisa criar antes da importação

Já listadas em `IMPLEMENTATION_PLAN.md §7`. Recapitulando, com nomes EXATOS que os JSONs vão referenciar:

| Nome | Tipo | Valor |
|---|---|---|
| `igor_supabase_service` | HTTP Header Auth | header `apikey` + `Authorization: Bearer` = `SUPABASE_SERVICE_ROLE_KEY` |
| `igor_supabase_postgres` | Postgres | session pooler do Supabase (porta 5432, NÃO o pooler default que não funciona) |
| `igor_chatwoot_api` | HTTP Header Auth | header `api_access_token` = `CHATWOOT_API_TOKEN` (admin) |
| `igor_chatwoot_bot` | HTTP Header Auth | header `api_access_token` = `CHATWOOT_BOT_ACCESS_TOKEN` (Alice) |
| `igor_evolution_api` | HTTP Header Auth | header `apikey` = `EVOLUTION_API_KEY` |
| `igor_openai` | OpenAI API | `OPENAI_API_KEY` |
| `igor_redis_embedded` | Redis | credencial Redis interna do n8n via Portainer (nome a confirmar) |

**Aviso**: o `import-workflows.sh` falha se uma credential com o nome canônico não existir — o erro vai ser claro, basta criar e reimportar.

---

## Verificação end-to-end (após Bloco 4)

1. `bash scripts/import-workflows.sh` → 15 workflows criados via API n8n, todos inativos.
2. `curl GET /api/v1/workflows` → conferir 15 + 0 ASX (zero conflito).
3. `bash scripts/test-workflow.sh IGOR_01 fixtures/evolution-fromme.json` → execução manual mostra NoOp + event `inbound_blocked`.
4. Mesmo para os outros 9 smoke tests do `IMPLEMENTATION_PLAN §10`.
5. SQL no Supabase Studio (após cada teste): `SELECT event_type, count(*) FROM events GROUP BY 1` → contagens batem com asserts.
6. Chatwoot UI: verificar labels e attrs aplicados nas conversas de teste.
7. Aprovação manual → flip `settings.workflows_enabled.IGOR_XX = true` workflow por workflow.
8. Aprovação manual final → flip `ALLOW_REAL_WHATSAPP_SEND=true` e ativar webhook na Evolution (Fase 5).

---

## Pontos de atenção

1. **Modelo `gpt-5.4-mini` é novo**: ele existe na conta (validado), mas comportamento PT-BR pode variar. Esperar ajuste fino do system prompt depois das primeiras execuções.
2. **Postgres Chat Memory** depende da credential `igor_supabase_postgres` funcionar. Como o pooler default não funciona, preciso da session pooler — porta e formato exatos. Você valida no painel n8n criando a credential e clicando "Test connection". Se falhar, a memory não persiste e o agente esquece o que foi dito entre mensagens.
3. **Redis embarcado**: a credential `igor_redis_embedded` precisa estar configurada antes do Bloco 1 — o batching de IGOR_01 depende dela. Você confirma o nome no n8n UI.
4. **`{{ }}` em campos n8n vs JavaScript em Code nodes**: vou seguir religiosamente a regra (expressions em parameters, JS puro em Code). Erros comuns são pegos pela importação ou pela primeira execução.

---

## Riscos novos (não cobertos no IMPLEMENTATION_PLAN)

1. **Tool description ruim no IGOR_03/IGOR_13**: se a descrição da tool no `toolWorkflow` for vaga, a LLM não chama. Vou usar descrições específicas (ex: "Use esta tool quando o usuário confirmou nome E objetivo E período de retorno. Não chame antes."). Risco de o agente travar.
2. **Race condition no Redis batching**: 2 mensagens em <500ms ainda podem disparar 2 execuções paralelas mesmo com `SET NX EX`. Mitigação: lock em IGOR_01 ANTES de chamar IGOR_02. Se ainda assim houver duplicata, IGOR_06 detecta via `messages.msg_id UNIQUE` e descarta.
3. **agent_bot Alice token expira ou é rotado**: workflows que usam `igor_chatwoot_bot` quebram. Mitigação: documentar no RUNBOOK como rotar.
4. **Memory PostgresChat acumula linhas**: cada sessão grava em tabela própria. Sem cleanup, cresce indefinidamente. Mitigação: scheduled job que apaga sessões inativas há >30 dias.

---

## ExitPlanMode e próximo passo

Depois de aprovar:

1. Bloco 1 entregue (5 JSONs + `scripts/import-workflows.sh` + 5 fixtures + 5 docs/workflows/*.md). Testes manuais.
2. Espero seu sinal para Bloco 2.
3. Idem para 3 e 4.

Cada bloco é commitado separadamente. Você pode pausar a qualquer momento.
