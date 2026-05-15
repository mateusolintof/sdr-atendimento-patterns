# ARCHITECTURE — Instituto Dr. Igor (Source of Truth)

> Este arquivo é a **fonte de verdade arquitetural** do projeto Igor. Agentes revisores e novos agentes devem ler ESTE arquivo primeiro antes de tocar em código ou workflows. Discrepâncias entre código atual e este documento → corrigir o código (não o doc), ou abrir débito explícito em `docs/superpowers/debt/`.
>
> Versão: 2026-05-15 (Fase C wiring + Smoke trigger).

---

## 1. Topologia de serviços

```
WhatsApp (lead/atendente)
    ↕
Evolution API (Portainer / VPS — https://evo.almaconvert.com.br)
    ├─ instances: dr.igor (prod) | convert-teste (teste — único ativo agora)
    ├─ Chatwoot Integration nativa: cria/atualiza conv+contact em Chatwoot
    │  E injeta chatwootConversationId + chatwootInboxId nos webhooks
    └─ webhook MESSAGES_UPSERT → n8n /webhook/igor/inbound
    ↕
Chatwoot self-hosted (https://chat.almaconvert.com.br, account_id=2)
    ├─ Inbox "Igor After Hours" (id=1, Channel::Api, identifier=vRrf8MeDTe9DsH11RB3ZRCug)
    │  └─ webhook do inbox → n8n /webhook/igor/chatwoot (eventos message_created)
    ├─ Team "Atendimento Humano" (id=1)
    ├─ 34 labels + 15 custom attributes (seed-chatwoot.sh)
    └─ Agent bot Alice (token próprio)
    ↕
n8n self-hosted (https://n8n.almaconvert.com.br)
    ├─ 7 workflows IGOR_* receptivo + 1 errorTrigger + 1 cron + 2 AUX + 3 TEST
    ├─ Webhook /igor/inbound → IGOR_01 (router 12 condições)
    ├─ Webhook /igor/chatwoot → IGOR_06 (logger + human takeover)
    └─ Schedule */10min → IGOR_08 (health check)
    ↕
Supabase Cloud (https://xivglsefkzxshqoqjfjp.supabase.co)
    ├─ Tabelas: contacts, conversations, leads, messages, events, settings,
    │           conversation_summaries, campaign_runs, campaign_contacts,
    │           assignments
    └─ 12 migrations aplicadas (001-012)
Redis embedded em n8n (credencial igor_redis_embedded id=ayVMY7Njm6ecLLuc)
    └─ chaves: igor:lock:inbound:{phone}, igor:batch:{phone}, igor:batch:marker:{phone}
OpenAI (api.openai.com)
    ├─ gpt-5.4-mini (Alice agent — IGOR_03)
    ├─ gpt-4o-transcribe (audio — IGOR_02)
    └─ gpt-4o-mini (vision — IGOR_02)
```

---

## 2. Categorização dos workflows

| Fluxo | Workflows | Construído? |
|-------|-----------|-------------|
| **Inbound (receptivo fora-expediente)** | `IGOR_01_Inbound_AfterHours`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_06_Chatwoot_Message_Logger` | ✅ Fase B |
| **Disparo (campanha ativa promoção)** | `IGOR_09_Campaign_Importer`, `IGOR_10_Campaign_Dispatcher`, `IGOR_11_Campaign_Message_Generator`, `IGOR_12_Campaign_Inbound_Handler`, `IGOR_13_Agent_Campaign` | ❌ NÃO construídos |
| **Compartilhados (chamados por ambos os fluxos)** | `IGOR_04_Tool_Labels_Attributes`, `IGOR_05_Finalize_Handoff` | ✅ Fase B |
| **Infra global** | `IGOR_07_Error_Logger`, `IGOR_08_Health_Check` | ✅ Fase B |
| **Helpers (callables internos para IGOR_03 como tools)** | `IGOR_AUX_save_lead_partial`, `IGOR_AUX_update_conversation_state` | ✅ pré-Fase B |
| **Test fixtures** | `IGOR_TEST_Failing_Workflow`, `IGOR_TEST_Trampoline` (validar IGOR_07), `IGOR_TEST_Smoke_Trigger` (manual trigger envia WhatsApp pro operador) | ✅ |

### IDs canônicos n8n

| Workflow | n8n ID | Nodes | Active? |
|----------|--------|-------|---------|
| IGOR_01_Inbound_AfterHours | `nC6ZhCVNn1fQiKfB` | 59 | ✅ active (com BYPASS de business hours em código — reverter antes de prod) |
| IGOR_02_Media_Normalizer | `GBmG9WZzW2p8Nn6f` | 27 | ✅ active |
| IGOR_03_Agent_AfterHours | `iQCVbe1P8dC0vhay` | 26 | ✅ active |
| IGOR_04_Tool_Labels_Attributes | `AJF7dhGrqJEXMLqz` | 21 | ✅ active |
| IGOR_05_Finalize_Handoff | `N31QcdrNVE5AOZdu` | 24 | ✅ active |
| IGOR_06_Chatwoot_Message_Logger | `xpXRENR7Hoo2W5p3` | 17 | ✅ active |
| IGOR_07_Error_Logger | `ZrsbaSTlW5bqMEaS` | (preserved) | ✅ active |
| IGOR_08_Health_Check | `cDpDA1QdIH9wHAlN` | 21 | ✅ active |
| IGOR_AUX_save_lead_partial | `hRogDlGsgQxGwnD8` | (preserved) | ✅ active |
| IGOR_AUX_update_conversation_state | `mFuRPrGGt7yWVqEw` | (preserved) | ✅ active |
| IGOR_TEST_Smoke_Trigger | `G8pMteuirc2yZgq5` | 6 | manual-trigger (active flag irrelevante) |

---

## 3. Fluxo INBOUND — detalhe completo

### 3.1 Origem das mensagens

```
1. Lead manda WhatsApp pro número do convert-teste / dr.igor
2. Evolution recebe a mensagem
3. Evolution (via Chatwoot Integration nativa habilitada) cria/atualiza
   conversation + contact na inbox "Igor After Hours" do Chatwoot
4. Evolution dispara webhook MESSAGES_UPSERT pra n8n /webhook/igor/inbound
   COM chatwootConversationId + chatwootInboxId já populados pela integração
```

### 3.2 IGOR_01_Inbound_AfterHours — 12 condições determinísticas EM ORDEM

Pipeline implementado (extraído da live em 2026-05-15):

```
[Webhook /igor/inbound]
    ↓
[Normalize Payload]  (extrai phone, msgId, fromMe, messageType, text/caption/media, IDs Chatwoot)
    ↓
[INSERT events('inbound_received')]
    ↓
[COND1 fromMe?]
    └─ true → INSERT events('inbound_blocked', reason='fromMe') → Resp 200 fim
    └─ false → [Read Settings]  (SELECT ai_enabled_global, workflows_enabled,
                                  holidays, holiday_policy, after_hours_start,
                                  after_hours_end, timezone)
                ↓
[COND2 ai_disabled_global?]
    └─ true → block 'ai_disabled_global' → fim
    └─ false → [COND3 workflow_disabled?]  (workflows_enabled.IGOR_01 === false)
                └─ true → block 'workflow_disabled' → fim
                └─ false → [Normalize Phone]  (regex 55+DDD+9digits, normaliza 8→9)
                            ↓
[COND4 phone invalid?]
    └─ true → INSERT events('invalid_phone') → fim
    └─ false → [Lookup Contact]  (SELECT contacts WHERE phone)
                ↓
[COND5 do_not_contact?]
    └─ true → executeWorkflow IGOR_04 (labels=['optout']) +
              INSERT events('inbound_blocked', reason='opt_out') → fim
    └─ false → [Lookup Conversation]  (SELECT conversations WHERE chatwoot_conversation_id)
                ↓
[COND6 human_locked OR ai_disabled?]
    └─ true → block 'human_locked_or_ai_disabled' → fim
    └─ false → [Lookup Campaign Contacts]  (status IN sent/delivered/replied/interested)
                ↓
[COND7 campaign_active?]
    └─ true → INSERT events('campaign_routed_pending_IGOR_12')  (placeholder Fase D — Igor_12 não existe)
              [substituição futura: executeWorkflow IGOR_12 quando construído]
    └─ false → [COND8 inside business hours?]  (Intl.DateTimeFormat tz-aware)
                └─ true → block 'inside_business_hours' → fim
                └─ false → [Check Holiday]
                            ├─ holiday + holiday_policy='after_hours_force' → continue
                            └─ holiday + 'block_completely' (futuro) → block (não implementado)
                            ↓
[COND10 Redis Lock]  (INCR igor:lock:inbound:{phone} + EXPIRE 30 atomic — n8n redis v1 não tem SET NX EX direto)
    └─ counter > 1 (lock held) → RPUSH igor:batch:{phone} fragment +
                                 INCR marker (EXPIRE proxy) +
                                 INSERT events('inbound_batched') → fim
    └─ counter == 1 (got lock) → [Wait 3s] → [LRANGE batch] → [DEL batch] →
                                 [Merge Fragments]
                                 ↓
[COND11 messageType != text?]
    └─ true → executeWorkflow IGOR_02 (audio/image/document/unknown normalizer)
              Recebe: { normalized_text, media_summary, safety_flags,
                        should_handoff, handoff_reason }
    └─ false → text passthrough
    ↓
[UPSERT conversations]  (state='ai_after_hours', ai_enabled=true)
    ↓
[UPSERT messages]
    ↓
[executeWorkflow IGOR_04]  (labels=['fora_expediente'], custom_attrs={automation_state:'ai_after_hours'})
    ↓
[INSERT events('inbound_routed_to_IGOR_03')]
    ↓
[executeWorkflow IGOR_03]  (Alice agent — passa payload normalizado completo)
    ↓
[Redis DEL lock]  (libera o lock pra próximas mensagens)
    ↓
[Resp 200 {ok, branch}]
```

### 3.3 IGOR_03_Agent_AfterHours — agente conversacional Alice

```
[executeWorkflowTrigger]  (10 inputs: phone, msgId, IDs Chatwoot, normalized_text, safety_flags, should_handoff, handoff_reason, fragments_count, test_run_id)
    ↓
[Load Gates]  (SELECT settings.dry_run_send + allow_real_whatsapp_send + chatwoot_human_assignee_id)
    ↓
[Validate Payload]  (compute _is_compliance, _should_send_real, build sessionKey)
    ↓
[IF Compliance Fast-Path?]  (should_handoff || safety_flags.clinical || sensitive_image || payment_proof)
    └─ true → INSERT events('agent_routed_to_handoff') →
              executeWorkflow IGOR_05 (compliance summary, owner_flow='after_hours') → fim
    └─ false → [langchain.agent: Alice]
                ├─ Model: lmChatOpenAi gpt-5.4-mini (cred: igor_openai)
                ├─ Memory: memoryPostgresChat sessionKey=after_hours_{phone} contextWindow=25
                └─ Tools (4 via toolWorkflow):
                    ├─ set_label_and_attr → IGOR_04
                    ├─ save_lead_partial → IGOR_AUX_save_lead_partial
                    ├─ update_conversation_state → IGOR_AUX_update_conversation_state
                    └─ request_handoff → IGOR_05
                ↓
[INSERT events('agent_response')]  (resposta agregada)
    ↓
[Format AI Output]  (split por '\n\n' ou '||' em array de mensagens)
    ↓
[Split Messages]  (SplitOut)
    ↓
[Loop Messages]  (SplitInBatches batchSize=1)
    ↓
[Presence Composing]  (Evolution /chat/sendPresence delay calc por length)
    ↓
[IF should_send_real?]
    ├─ true → Evolution sendText {number, text} → INSERT events('whatsapp_sent')
    └─ false → INSERT events('dry_run_send')
    ↓
[Wait 2s entre mensagens]
    ↓
[loop back to Split if more messages]
    ↓
[Final Output {messages_sent, mode}]
```

### 3.4 IGOR_06_Chatwoot_Message_Logger — espelhamento + human takeover

```
[Webhook /igor/chatwoot]  (Chatwoot dispara aqui no eventos do inbox)
    ↓
[IF event === 'message_created']  (filtra outros eventos)
    ↓
[Normalize Message]  (extrai account_id, conv_id, contact_id, msg_id, message_type, sender_type, content)
    ↓
[UPSERT messages]  (espelhamento — depende de migration 008 UNIQUE msg_id)
    ↓
[INSERT events('message_mirrored')]
    ↓
[Switch (message_type, sender_type)]
    ├─ outgoing + user (atendente humano) → HUMAN_TAKEOVER:
    │   ├─ UPDATE conversations SET human_locked=true, ai_enabled=false, state='human_assigned'
    │   ├─ executeWorkflow IGOR_04 (labels=['atendimento_humano','ai_disabled'])
    │   └─ INSERT events('human_assumed')
    ├─ outgoing + agent_bot (Alice) → BOT_NOOP (apenas mirror — não trava)
    └─ incoming + contact (lead) → INBOUND_NOOP (mensagem do lead — IGOR_01 lida via Evolution direto)
```

---

## 4. Fluxo DISPARO (campanha ativa promoção) — design (NÃO construído)

Spec em `docs/logica-fluxo-igor-agente-ativo-promocao.md`. Contratos em `docs/IMPLEMENTATION_PLAN.md §2 IGOR_09-IGOR_13`. Status: **somente desenho — zero código em `n8n/workflows/`**.

### 4.1 Por que 5 workflows? (análise honesta de overengineering)

Os 5 workflows da campanha têm responsabilidades distintas:

| Workflow | O que faz | É essencial separar? |
|----------|-----------|----------------------|
| **IGOR_09 Campaign_Importer** | Importa lista de leads do CSV Kommo (dedup, normaliza phone, valida elegibilidade, popula `campaign_contacts.status='queued'`) | ✅ **SIM** — é processo de carga, roda como script Python local (não como workflow n8n; spec confirma: "Não roda em n8n inicialmente"). Separação justificada. |
| **IGOR_10 Campaign_Dispatcher** | Schedule `*/1 * * * 1-5` durante janela útil, pega 1 contato `queued`, aplica throttle + daily limit + revalida elegibilidade, dispara via Evolution, marca `sent` | ✅ **SIM** — é o motor de envio com rate limit, dia útil, janela. Único workflow com cron. |
| **IGOR_11 Campaign_Message_Generator** | Carrega template literal de `campaign_runs.message_template`, substitui `{nome}` se presente, retorna `sent_message`. **Não usa LLM** (decisão 2026-05-14 — zero risco de copy inventado) | ⚠️ **MARGINAL** — sem LLM e sem variantes A/B, é só uma string interpolation. Poderia ser inline em IGOR_10. Separar tem valor SE futuro re-adicionar LLM ou A/B. Hoje é overengineering leve. |
| **IGOR_12 Campaign_Inbound_Handler** | Recebe respostas de leads de campanha (chamado por IGOR_01 cond 7), classifica intenção (`interested`/`price_question`/`scheduling`/`doubt`/`not_interested`/`opt_out`/`human_request`/`sensitive_medical`/`unknown`), bloqueia opt-out, roteia pra IGOR_13 ou IGOR_05 (compliance) | ✅ **SIM** — classifier + roteamento distinto do IGOR_03 (cujo agente é "after-hours acolhedor", não "ativo-promocional"). |
| **IGOR_13 Agent_Campaign** | Agente conversacional dedicado à campanha — sabe da oferta (preço/validade/mídia), responde dúvidas sobre o pacote, coleta callback, chama IGOR_05 quando interesse confirmado | ✅ **SIM** — system prompt e tools diferentes do IGOR_03 (Alice acolhe vs Alice promotora). Memória Postgres ligada à conversa. |

**Veredicto honesto**: 4 dos 5 são justificados. IGOR_11 é candidato a consolidar em IGOR_10 se o template não evoluir para LLM/variantes. Não é blocker — a separação prepara para evolução futura sem alto custo.

### 4.2 Por que tem inbound dentro da campanha?

Quando IGOR_10 dispara a oferta promocional pra um lead, ele entra em `campaign_contacts.status='sent'`. Quando esse lead responder via WhatsApp:

```
Lead responde via WhatsApp
    ↓
Evolution → webhook → IGOR_01 (mesmo entry point do inbound)
    ↓
IGOR_01 COND7: SELECT campaign_contacts WHERE contact_id=$1 AND status IN ('sent','delivered','replied','interested')
    └─ ENCONTRADO → roteia pra IGOR_12 (em vez de IGOR_03)
    └─ NÃO encontrado → segue fluxo after-hours normal (IGOR_03)
```

IGOR_12 entende que a conversa começou pela campanha — usa system prompt diferente, classifica intenção comercial, e roteia pra IGOR_13 (agente promocional) ou IGOR_05 (handoff direto se compliance).

Sem IGOR_12, lead que respondesse "quero saber mais sobre o preço" cairia no IGOR_03 (Alice acolhedora after-hours), que não tem contexto da oferta enviada e da personalização — UX quebrada.

### 4.3 Fluxo de disparo end-to-end (design)

```
[OPERADOR] roda scripts/import-kommo-csv.sh  (= IGOR_09)
    ↓
Supabase: contacts + leads + campaign_contacts (queued)
    ↓
[IGOR_10 cron */1 1-5]
    ├─ Gate: workflows_enabled.IGOR_10 + business hours window + dia útil + não feriado + daily limit + throttle
    ├─ SELECT 1 queued from campaign_contacts ORDER BY created_at
    ├─ Revalidate elegibilidade
    ├─ executeWorkflow IGOR_11 → sent_message
    ├─ IF ALLOW_REAL_WHATSAPP_SEND + !IGOR_DRY_RUN → Evolution sendText  ELSE events('dry_run_send')
    └─ UPDATE campaign_contacts.status='sent', sent_at=now()
    ↓
[Lead recebe WhatsApp + lê + decide responder]
    ↓
[Evolution → webhook → IGOR_01]
    ↓
[IGOR_01 COND7 detect campaign] → [IGOR_12]
    ↓
[IGOR_12 classifica intent]
    ├─ opt_out → set contacts.do_not_contact=true + label promo_optout
    ├─ unknown → Alice pergunta "pode me dizer com outras palavras?" + reclassify
    ├─ sensitive_medical → IGOR_05 (compliance handoff)
    └─ default → executeWorkflow IGOR_13
        ↓
[IGOR_13 Alice promotora]
    ├─ langchain.agent com prompt + tools (IGOR_04, AUX_save_lead, AUX_update_conv, IGOR_05)
    ├─ Responde dúvidas sobre oferta (preço R$600 + validade + T Sculptor)
    ├─ Coleta callback_period
    └─ Quando interesse confirmado → IGOR_05 (handoff)
```

### 4.4 Tabelas Supabase usadas pela campanha

- `campaign_runs` — cabeçalho de cada campanha (template_message, valid_until, status active/paused)
- `campaign_contacts` — 1 linha por (lead, campanha): status queued → sent → delivered → replied → interested → opt_out → skipped, com `personalized_context`, `skip_reason`, `sent_message`, `sent_at`
- Settings keys (Fase D pendente):
  - `campaign_daily_limit` (int)
  - `campaign_per_minute_limit` (int)
  - `campaign_send_window_start/end` (strings HH:MM)
  - `campaign_optout_threshold` (já em settings, `{window_size:20, max_optouts:3}`)

---

## 5. Credenciais canônicas

**TODAS criadas via UI n8n** (Credentials → Add Credential). Workflows referenciam por NOME (n8n liga automaticamente).

| Nome canônico | ID | Tipo n8n | Header / Conn | Uso |
|---------------|----|----|---------------|-----|
| `igor_chatwoot_api` | `x8StLhAFnYjQxUFg` | httpHeaderAuth | `api_access_token` | Chatwoot REST (IGOR_04/05/06/08) |
| `igor_evolution_api` | `DDhbwLsNclqTA18X` | httpHeaderAuth | `apikey` | Evolution send/presence/ping (IGOR_03/05/08/TEST_Smoke_Trigger) |
| `igor_openai` | `LlVkZBRsy5tm6FjJ` | openAiApi | Bearer | OpenAI (IGOR_02/03/08) |
| `igor_supabase_postgres` | `Z7DeBop4nK4JlIXO` | postgres | conn string | Supabase Postgres (todos) |
| `igor_redis_embedded` | `ayVMY7Njm6ecLLuc` | redis | local | Redis lock/batch (IGOR_01/08) |

---

## 6. Configuração externa — onde os valores ficam

### ⚠️ `.env` do repositório é APENAS referência visual

NÃO é importado em containers Portainer. n8n bloqueia `$env` access por `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (default). PROIBIDO `={{ $env.X }}` em nodes. `$vars.X` também NÃO disponível (Enterprise-only).

### Valores canônicos hardcoded em workflows

| Variável (era $env.X) | Valor hardcode |
|-----------------------|----------------|
| `CHATWOOT_BASE_URL` | `https://chat.almaconvert.com.br` |
| `CHATWOOT_ACCOUNT_ID` | `2` |
| `CHATWOOT_INBOX_ID` | `1` |
| `CHATWOOT_INBOX_IDENTIFIER` | `vRrf8MeDTe9DsH11RB3ZRCug` |
| `CHATWOOT_HUMAN_TEAM_ID` | `1` (hardcoded) |
| `EVOLUTION_BASE_URL` | `https://evo.almaconvert.com.br` |
| `EVOLUTION_INSTANCE_NAME` | `convert-teste` (test) ou `dr.igor` (prod — swap por find/replace + re-PUT) |
| `N8N_BASE_URL` | `https://n8n.almaconvert.com.br` |

### Valores em settings table (configuráveis sem re-deploy)

| key | tipo | uso |
|-----|------|-----|
| `ai_enabled_global` | bool | kill switch global (IGOR_01 cond 2) |
| `workflows_enabled` | jsonb obj | flag por workflow IGOR_XX |
| `after_hours_start/end` | string HH:MM | janela após-expediente (IGOR_01 cond 8) |
| `timezone` | string IANA | timezone p/ business hours |
| `holidays` | jsonb array YYYY-MM-DD | feriados |
| `holiday_policy` | string enum | `after_hours_force` |
| `do_not_contact_keywords` | jsonb array | PT-BR opt-out keywords (futuro) |
| `campaign_optout_threshold` | jsonb obj | 3-em-20 auto-pausa |
| `human_team_id` | int | team Chatwoot p/ handoff (= 1) |
| `human_inbox_id` | int | inbox Chatwoot principal (= 1) |
| `human_inbox_identifier` | string | identifier API channel |
| `dry_run_send` | bool | gate Evolution sendText (default true após migration 010) |
| `allow_real_whatsapp_send` | bool | toggle prod/test (default false após migration 010) |
| `chatwoot_human_assignee_id` | int OR null | atendente específico (null = team-only — IGOR_05 IF "Has Assignee?" checa isso) |
| `smoke_test_phone` | string OR null | telefone do operador para IGOR_TEST_Smoke_Trigger |
| `smoke_test_message` | string | mensagem default do smoke |
| `after_hours_window` | jsonb obj | LEGADO da migration 003, redundante (chaves separadas em uso) |
| `human_inbox_id` (legacy) | int | mesmo conteúdo, ambas chaves OK |

---

## 7. Princípios arquiteturais inegociáveis

1. **Harness Engineering**: regras determinísticas em Code/IF/Switch/SQL/Redis-locks. LLM apenas para resposta conversacional + transcrição + visão + classificação semântica.
2. **NO SIMPLIFICATIONS**: spec do `docs/logica-fluxo-igor-*.md` é literal. Se faltar info, perguntar — nunca decidir simplificação sozinho. Vide débito histórico em `docs/superpowers/debt/`.
3. **Workflow inativo por padrão** na construção: TODOS os IGOR_* nascem com `active: false`. Ativação após smoke verde via UI ou `mcp__n8n-mcp__publish_workflow`.
4. **errorWorkflow universal**: cada workflow tem `settings.errorWorkflow = ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
5. **Gates de segurança** em `settings`: `dry_run_send=true` (default) bloqueia Evolution sendText. `allow_real_whatsapp_send=false` (default).
6. **Source of truth dual**: JSON canonical em `n8n/workflows/IGOR_*.json` é o que vale (foi PUT'd para n8n). `*.sdk.ts` é apenas script gerador, mas pode estar **dessincronizado** com a live (vide §10).

---

## 8. Pattern ASX (referência de stack)

ASX em `docs/referencias/workflows-asx/` roda em produção há meses com:
- httpRequest direto pra Chatwoot via header manual `api_access_token` (Igor melhora usando credential `igor_chatwoot_api` no UI)
- URLs hardcoded como `https://api.agenciaprospect.space/message/sendText/ASX_SDR`
- `chatwootConversationId` injetado pela Evolution Chatwoot Integration (Igor segue mesmo padrão)
- 06-FB-Leads-Outbound-Webhook: pattern de entrada via webhook + Chatwoot create contact + Evolution sendText (referência para IGOR_10/IGOR_11)

---

## 9. Estado atual (2026-05-15)

### Fases concluídas
- **Fase 0** Audit ✅
- **Fase 1** Plan ✅
- **Fase 2** Supabase migrations 001-007 ✅
- **Fase 3** Chatwoot seed (34 labels + 15 attrs + team + bot) ✅
- **Fase A** Reset (revert 6 simplified commits + DELETE 6 workflows do n8n) ✅
- **Fase B** Rebuild 7 inbound workflows NO SIMPLIFICATIONS ✅
- **Fase C** Wiring + reviews + fixes ✅

### Migrations Supabase aplicadas
- 001 core_schema, 002 indexes, 003 settings_seed, 004 campaign_schema, 005 RLS, 006 campaign_seed, 007 asserts_rpc (Fase 2)
- 008 messages_msgid_unique (partial UNIQUE em msg_id — necessária pra UPSERT IGOR_02/06) ✅
- 009 settings_fase_c_activation (chaves separadas after_hours_start/end/timezone + workflows_enabled IGOR_01-08=true + human_inbox_id) ✅
- 010 settings_gates (dry_run_send + allow_real_whatsapp_send) — status: provável aplicada (Load Gates tem COALESCE então não bloqueia mesmo se ausente)
- 011 chatwoot_assignee_optional (chatwoot_human_assignee_id default null) ✅
- 012 smoke_test_phone (smoke_test_phone + smoke_test_message keys em settings) ✅

### Integrações configuradas em Fase C
- ✅ Chatwoot inbox API "Igor After Hours" criada (id=1)
- ✅ Evolution Chatwoot Integration habilitada em `convert-teste`
- ✅ Evolution webhook MESSAGES_UPSERT → `/webhook/igor/inbound` (em convert-teste)
- ✅ Credencial `igor_evolution_api` criada e wired em IGOR_03/05/08 + IGOR_TEST_Smoke_Trigger
- ✅ Credencial `igor_chatwoot_api` wired em IGOR_05 (estava com bloco vazio após PUT do subagent — fix aplicado em commit c7bd8b4)

### Dívida atual (a resolver antes de prod real)

1. **IGOR_01 com BYPASS de business hours em código** — Code node "Check Business Hours + Holiday" forçado a retornar `inside_business_hours: false`. Comentário inline marca: `/* BYPASS smoke test 2026-05-15 */`. **Reverter** antes de prod.
2. **SDK files (`*.sdk.ts`) dessincronizados** com JSON canonical em IGOR_03 e IGOR_05: subagent não adicionou node "Load Gates" ao SDK. JSON canonical é source of truth (per §7.6) mas regenerar do SDK perderia o node. Reescrever SDKs ou marcar JSON como exclusiva fonte.
3. **IGOR_TEST_Smoke_Trigger pattern questionado** pelo usuário (2026-05-15): a ideia original era simular mensagem ENTRANTE (POST direto no webhook IGOR_01 com payload fake), não enviar ping do bot pro operador. Refazer se necessário.
4. **Migration 010** ainda não confirmada aplicada — mas não bloqueia (Load Gates tem COALESCE default seguro).
5. **Fluxo Disparo (IGOR_09-13)** zero código — só desenho.

---

## 10. Checklist para revisor agent

Ao revisar um workflow novo/modificado:

- [ ] grep `$env\.` no JSON → zero hits (qualquer hit = bug)
- [ ] grep `$vars\.` no JSON → zero hits (Enterprise-only)
- [ ] `settings.errorWorkflow = "ZrsbaSTlW5bqMEaS"` setado
- [ ] `active: false` setado se workflow não foi explicitamente publicado
- [ ] `tags` contém `igor` + tag de fase (`fase-b-rebuild` ou similar)
- [ ] Credenciais referenciadas por nome canonical (§5) com `id+name` no bloco `credentials` do node — sem hardcode de tokens
- [ ] URLs hardcoded com valores canonicos (§6)
- [ ] `onError: continueRegularOutput` em postgres/redis nodes onde falha não pode bloquear pipeline (especialmente IGOR_08)
- [ ] Code nodes não têm `TODO`, `stub`, `_skip_X`, `placeholder` literal (placeholders de forward dependency tipo `pending_IGOR_12` são aceitáveis se DOCUMENTADOS)
- [ ] Workflow validates limpo via `mcp__n8n-mcp__validate_workflow` se SDK em sync
- [ ] JSON canonical em `n8n/workflows/IGOR_*.json` está em sync com n8n live (re-export pós-PUT)
- [ ] Contrato espec ↔ implementação: ler `docs/logica-fluxo-igor-*.md` § correspondente + `docs/IMPLEMENTATION_PLAN.md §2 IGOR_XX` e cruzar com nodes

---

## 11. Documentos relacionados

- **Lógica funcional** (DON'T simplify):
  - `docs/logica-fluxo-igor-receptivo-fora-expediente.md` — spec inbound
  - `docs/logica-fluxo-igor-agente-ativo-promocao.md` — spec campanha
- **Plano operacional**:
  - `docs/IMPLEMENTATION_PLAN.md` (§2 catálogo workflows, §3 contratos, §5 schema DDL, §7 credentials, §10 smoke tests, §13 templates)
  - `docs/WORKFLOW_PLAN.md` (Fase 4 ordem de construção)
  - `docs/RUNBOOK.md` (smoke runbook + diagnostics)
- **Status / pendências**:
  - `docs/VALIDATION_REPORT.md` (status atual de cada workflow)
  - `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` (débito histórico — TODO resolvido)
- **Memórias do agente** (`~/.claude/projects/.../memory/MEMORY.md`):
  - `feedback_nunca_simplificar_e_asx_e_referencia.md`
  - `feedback_env_file_is_reference_only.md` ← regra `$env` proibido
  - `feedback_asx_e_apenas_referencia_tecnica.md`
  - `project_decisoes_fase_0.md`
- **Plans**:
  - `docs/superpowers/plans/2026-05-15-fase-b-inbound-rebuild.md`
  - `~/.claude/plans/elegant-tinkering-chipmunk.md` (Fase C integração)

---

## 12. Changelog

| Data | Evento | Commits/Refs |
|------|--------|--------------|
| 2026-05-14 | Fase 0+1+2: audit, plan, 7 migrations, Chatwoot seed, Kommo CSV import | múltiplos |
| 2026-05-15 04:34 | Identificadas simplificações não-autorizadas em 6 workflows | Memória |
| 2026-05-15 06:00-09:00 | Fase A reset (revert 6 + DELETE n8n 6) + Fase B rebuild 7 workflows | 6 reverts + 8 feat + fixes |
| 2026-05-15 09:00-10:00 | Fase C wiring Evolution credential + onError + inbox API + integração nativa | `334b124`, `225bbe0` |
| 2026-05-15 10:00-11:00 | Reviews + IGOR_01 P0 fix (Call IGOR_03 wired) + Migrations 009, 010, 011 | `819d1ca`, `d328338`, `3f67be4` |
| 2026-05-15 11:00-12:30 | Remoção massiva $env → hardcode (29 sites em IGOR_03/04/05/08) | `e1a937b` |
| 2026-05-15 12:30-13:00 | Fix credential wiring IGOR_05 (3 nodes Chatwoot ficaram com bloco vazio) | `c7bd8b4` |
| 2026-05-15 13:00-13:30 | Restore IGOR_05 assignee opcional via settings (fix dead-code) | `3f67be4` |
| 2026-05-15 13:30-14:00 | Publish 7 workflows IGOR_* via MCP publish_workflow | (live state) |
| 2026-05-15 14:00 | BYPASS de business hours em IGOR_01 (DÍVIDA — reverter) | (PUT REST) |
| 2026-05-15 14:30 | IGOR_TEST_Smoke_Trigger criado + migration 012 | `e5f28b7` |
