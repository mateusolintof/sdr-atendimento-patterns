# Instituto Dr. Igor — Arquitetura do Sistema

> Versão: 2026-05-20 — pós-refator de consolidação + pós-incident Alice/pacientes (2026-05-18).
>
> Este documento descreve **como o sistema funciona hoje** — workflows ativos, decisões arquiteturais, gates de bloqueio, comportamento da Alice, integração entre serviços. Versões anteriores (Fase C com IGOR_01-13) estão em `archives/IMPLEMENTATION_PLAN.md`.

---

## 1. Visão geral

Instituto Dr. Igor opera dois fluxos automatizados independentes sobre o mesmo canal WhatsApp:

- **Fluxo Receptivo Fora de Expediente** — lead manda mensagem espontânea após o horário comercial. Alice (IA) acolhe, qualifica em poucas perguntas e encaminha para a atendente.
- **Fluxo Campanha Promocional** — disparo one-shot de oferta promocional pra leads antigos que nunca agendaram. **Sem IA conversacional**: respostas dos leads vão direto pra atendente humana.

Os dois compartilham infraestrutura (handoff, labels, mídia, logger, health check) mas têm papéis distintos.

|  | Receptivo (after-hours) | Campanha promocional |
|---|---|---|
| **Quem inicia** | Lead manda mensagem | Sistema dispara mensagem |
| **Quando IA age** | Apenas após 18:30 (incluindo fim de semana/feriado) | Nunca — sem IA conversacional |
| **Saída para humano** | Quando coleta callback_period ou compliance | Imediato quando lead responder |
| **Status atual** | ⏸️ Pausado (desativado pós-incident, aguardando defesa em profundidade) | ⏸️ Pausado (aguardando reativação coordenada com Receptivo) |

### Estado de publicação (2026-05-20)

Todos workflows com webhook estão DESATIVADOS após o incident de 2026-05-18:
- `IGOR_Inbound`, `IGOR_Handoff`, `IGOR_Chatwoot_Logger`, `IGOR_Campaign_Sender` → `active=false`
- Webhooks Evolution (dr.igor + convert-teste) → `enabled=false`

Permanecem ativos:
- `IGOR_04_Tool_Labels_Attributes` (callable, sem trigger próprio)
- `IGOR_07_Error_Logger` (errorTrigger)
- `IGOR_08_Health_Check` (schedule `*/10 * * * *`)

### O que o sistema NÃO faz

- Não agenda consulta nem consulta agenda real.
- Não interpreta exames, laudos, imagens clínicas ou documentos médicos.
- Não prescreve, diagnostica ou orienta clinicamente.
- Não insiste em venda quando o lead recusa.
- Não continua respondendo depois que a atendente humana assume.
- Não envia campanha para quem pediu opt-out (mesmo histórico antigo).

---

## 2. A Agente Alice

Atua apenas no fluxo receptivo. Não existe "Alice Promotora" — campanha não tem IA conversacional.

### Objetivo

Receber lead que chegou fora do expediente, acolher, entender o objetivo em poucas perguntas e coletar o melhor período pra equipe retornar.

- Comunicação calorosa, sem pressa.
- **Uma pergunta por vez**.
- Informa que a equipe encerrou o expediente, quando faz sentido.
- Coleta: **nome → objetivo principal → callback_period** → handoff.

### Personalidade

- Tom natural e conversacional, não robótico.
- Frases curtas estilo WhatsApp (3-5 linhas).
- Sem emoji (preferência da equipe).
- Sem jargão técnico — nunca menciona workflow, label, score, IA, automação, tool, payload.
- PT-BR informal.

### O que Alice NUNCA faz

- Diagnostica nada (mesmo se o lead perguntar "será que tenho X?").
- Interpreta exame (PDF, foto de exame, prescrição → handoff compliance).
- Promete agenda específica ("amanhã às 10h" não — só pergunta período).
- Inventa preço ou condição comercial.
- Pede CPF, RG, dados sensíveis desnecessários.
- Continua respondendo após handoff.
- Simula agendamento ("marquei pra você", "agendado", "confirmado").

### Tools da Alice

| Tool | Quando chama | Sub-workflow |
|---|---|---|
| `set_label_and_attr` | Marcar transições no Chatwoot | `IGOR_04_Tool_Labels_Attributes` |
| `request_handoff` | Coletou dados mínimos OU caso compliance | `IGOR_Handoff` |

Modelo: `gpt-5.4-mini`, temperature `0.3`, memória Postgres (`memoryPostgresChat`, session key `after_hours_{phone}`, 25 turnos de contexto), `maxIterations: 6`.

---

## 3. Stack de serviços

| Serviço | Papel | Onde roda |
|---|---|---|
| **WhatsApp** | Canal de origem | Cliente |
| **Evolution API** | Gateway WhatsApp ↔ Chatwoot ↔ n8n. Envia (`sendText`), recebe webhook `MESSAGES_UPSERT`, sincroniza contatos com Chatwoot automaticamente. | VPS Ubuntu (Portainer) |
| **Chatwoot** | Inbox operacional onde atendente lê e responde. Guarda labels, custom_attrs, notas privadas, atribuições (team). | VPS Ubuntu (Portainer) |
| **n8n** | Orquestrador. Webhooks, routers, agente IA, tools, schedules. | VPS Ubuntu (Portainer) |
| **Supabase Cloud** | Banco principal. `contacts`, `conversations`, `leads`, `messages`, `events`, `settings`, `campaign_runs`, `campaign_contacts`. | Cloud |
| **Redis** (embarcado n8n) | Locks distribuídos + batching de mensagens fragmentadas. | Container n8n |
| **OpenAI** | LLM (gpt-5.4-mini Alice), Whisper (áudio→texto), Vision (gpt-4o-mini imagem). | API |

### Integração crucial: Evolution ↔ Chatwoot

Evolution tem integração nativa com Chatwoot habilitada via `POST /chatwoot/set/{instance}`. Quando ativa:

1. Evolution recebe mensagens WhatsApp
2. **Auto-cria/atualiza** contato e conversa no Chatwoot (sem ação do n8n)
3. **Injeta** `chatwootConversationId` e `chatwootInboxId` no webhook MESSAGES_UPSERT
4. n8n nunca precisa criar contato no Chatwoot — só atualiza labels, custom_attrs, private_notes, assignments via API pública

**Regra operacional crítica (pós-incident 2026-05-18)**: NUNCA habilitar webhook + integração Chatwoot em duas instâncias Evolution simultâneas. Comutar = desabilitar uma E habilitar outra. Procedimento em `RUNBOOK.md`.

---

## 4. Inbox Chatwoot + 4 Teams

1 inbox WhatsApp única (`Igor After Hours`, id=1) recebe TODAS as conversas. Organização visual via 4 teams:

| Team ID | Nome | Atribuído por | Quando |
|---|---|---|---|
| 1 | `atendimento humano` | `IGOR_Inbound` (gate inside_business_hours OU existing_journey); `IGOR_Chatwoot_Logger` (humano respondeu) | leads em conversa ativa com humano OU compliance handoff |
| 3 | `ia após-expediente` | `IGOR_Inbound` quando Alice vai assumir | Alice em ação |
| 4 | `aguardando retorno` | `IGOR_Handoff` (outcome qualified/unqualified) | pós-handoff Alice esperando humano |
| 5 | `promoção maio 2026` | `IGOR_Campaign_Sender` ~3-5s após cada envio | conversas da campanha |

Atribuição via API pública: `POST /api/v1/accounts/{acc}/conversations/{id}/assignments` com `{ team_id }`.

⚠️ NÃO usar UPDATE direto no banco do Chatwoot. ASX usa esse padrão (em `Move to Vendor Inbox` do 03-Finalize-Handoff), mas Igor proíbe.

---

## 5. Workflows ativos

### Inventário

| Nome canônico | ID n8n | Tipo | Função |
|---|---|---|---|
| `IGOR_Inbound` | `6hXJpXn139z6WCYW` | webhook | Receptor único de msgs WhatsApp. Gates determinísticos → mídia switch → Redis batching → Alice → reply |
| `IGOR_Handoff` | `mfB7MGpCYSPQvRSx` | callable | Chamado por Alice via tool. Ramifica por outcome (qualified/unqualified/compliance), atribui team, posta private note |
| `IGOR_Chatwoot_Logger` | `xpXRENR7Hoo2W5p3` | webhook | Recebe eventos Chatwoot. Flipa `owner_flow='human_daytime'` quando humano responde. Detecta label `agendado` |
| `IGOR_Campaign_Sender` | `4NzqtCS3ZGrwSVnB` | schedule | Cron `*/7 * * * *`. Disparo controlado da campanha promo |
| `IGOR_04_Tool_Labels_Attributes` | `AJF7dhGrqJEXMLqz` | callable | Mescla labels (GET current + add - remove) + PATCH custom_attributes no Chatwoot |
| `IGOR_07_Error_Logger` | `ZrsbaSTlW5bqMEaS` | errorTrigger | Target de `errorWorkflow`. INSERT events('infra_error') |
| `IGOR_08_Health_Check` | `cDpDA1QdIH9wHAlN` | schedule | Ping 5 services + SQL snapshots a cada 10min |

### Arquivados (não recriar)

`IGOR_01_*`, `IGOR_01_v2`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_05_*`, `IGOR_05_v2` (reaproveitado como IGOR_Handoff), `IGOR_06_Chatwoot_Message_Logger` (renomeado), `IGOR_AUX_save_lead_partial`, `IGOR_AUX_update_conversation_state`. Workflows IGOR_09/IGOR_10/IGOR_11/IGOR_12/IGOR_13 planejados foram **cancelados**.

---

## 6. Fluxo Receptivo — gates de bloqueio determinísticos

`IGOR_Inbound` aplica **gates em ordem** antes de acionar Alice. Cada gate pode bloquear, desviar ou continuar.

### Sequência de gates

```
Webhook Evolution chega
  ↓
Extrair Campos (Set) — phone_raw, msg_id, fromMe, conversation, messageType, chatwootConversationId, instance, ...
  ↓
Normaliza Payload (Set) — normaliza phone pra 55+DDD+9+8dígitos, valida regex
  ↓
IF Lead Message — !fromMe? Senão, fim silencioso
  ↓
Load State (Postgres) — settings + contacts + conversations + campaign_contacts (LEFT JOIN único)
  ↓
Compute Gates (Code) — calcula:
  - block_reason: 'ai_disabled_global' | 'workflow_disabled' | 'phone_invalid' | 'do_not_contact' | 'owner_flow_<value>' | 'campaign_active'
  - move_to_human: insideBusinessHours OR !isNewLeadJourney
  - should_process_ai: !block_reason && !move_to_human
  ↓
IF Block Reason? — sim → INSERT events('inbound_blocked') + Resp blocked
  ↓ não
IF Move to Human? — sim → UPSERT conv human_daytime + POST Assign Human Team + INSERT events('inbound_moved_to_human') + Resp moved
  ↓ não
Switch Message Type — texto / áudio / imagem / documento / unknown
  ↓
Mídia: transcribe / analyze vision / regex clínico → safety_flags
  ↓
Prepare for Redis → Redis Push → Wait 3s → Redis Get → Parse Redis Batch
  ↓
IF Last Message — quem tem o lock continua, quem não tem → No Op
  ↓
Merge Messages → Redis Delete → UPSERT conv ai_active + journey_started_at + turn_count++
  ↓
Log User Message → POST Assign AI Team (id=3) → Call IGOR_04 Labels (lead_novo, fora_expediente, ai_after_hours)
  ↓
Alice Agent (LangChain)
  ↓
Log Assistant Message → Format AI Output → Split → Loop → Presence → Send WhatsApp via Evolution → Wait 2s → próximo
```

### Por que essa ordem

- **`fromMe` primeiro** porque é o caso mais comum (todo bot vê seus próprios envios).
- **Opt-out antes de business hours** porque opt-out tem prioridade máxima — nem mesmo fora do expediente o sistema viola pedido de parar.
- **Campanha active antes de business hours** — resposta de campanha que chega às 14h não deve ser bloqueada por horário, vai pra fluxo de humano direto.
- **Phone inválido antes de lookup** — sem phone normalizado o SELECT não bate.
- **Lock antes de Alice** — sem isso ela responderia 3 vezes a uma frase fragmentada.

### ⚠️ Gate "lead novo" — defesa em profundidade (pendente)

Hoje o sistema usa `is_new_lead_journey = (conversation.journey_started_at IS NULL)`. **Insuficiente em isolamento** — pacientes existentes que nunca passaram pelo IGOR_Inbound antes têm `conversations` row inexistente → gate retorna `true` falsamente.

Pós-incident 2026-05-18: **3 camadas obrigatórias antes de reativar IGOR_Inbound**:

1. **Backfill conversations** — migration que cria row pra TODA conv existente no Chatwoot com `owner_flow='human_daytime'`, `human_locked=true`, `journey_started_at=conv.created_at`.
2. **Gate runtime** — query HTTP no Chatwoot (msgs outgoing humanas anteriores ao webhook atual). Se >0 → `block_reason='existing_human_conversation'`.
3. **Label override** — se conv Chatwoot tem label `ai_disabled` OU `atendimento_humano`, NUNCA aciona Alice.

Detalhes em `tasks.md` seção "Defesa em profundidade pré-reativação".

---

## 7. Sistema de Handoff (IGOR_Handoff)

Alice chama `request_handoff` quando coleta dados mínimos OU detecta compliance. `IGOR_Handoff` (callable, ID `mfB7MGpCYSPQvRSx`) faz:

```
1. Start (executeWorkflowTrigger) — inputs: chatwoot_conversation_id, chatwoot_contact_id, outcome, lead_name, lead_phone, handoff_reason, summary, callback_period
2. Load Team IDs (Postgres) — SELECT settings json_object_agg
3. Compute Branch (Code) — ramifica por outcome:
   ├─ qualified    → owner_flow='handoff_queue',  team=4 (aguardando retorno), labels=[handoff_done, lead_qualificado, aguardando_humano_proximo_expediente]
   ├─ unqualified  → owner_flow='ai_unqualified', team=4 (aguardando retorno), labels=[handoff_done, nao_qualificado_ia, ai_disabled]
   └─ compliance   → owner_flow='compliance_hold', team=1 (atendimento humano), labels=[handoff_done, compliance_humano, ai_disabled]
4. UPDATE conversation handoff (Postgres) — ai_enabled=false, human_locked=true, state='handoff', owner_flow=..., assigned_team_id=...
5. POST Assign Team (HTTP Chatwoot) — body { team_id }
6. Call IGOR_04 Labels (executeWorkflow) — adiciona labels + custom_attrs
7. POST Private Note (HTTP Chatwoot) — body { content, message_type: 'outgoing', private: true }
8. INSERT events('handoff_complete', payload)
9. Success Response (Set) — retorna pra Alice
```

Após o handoff, gate `isOwnerFlowBlocked` em IGOR_Inbound bloqueia Alice na próxima mensagem. Determinístico, sem race condition.

### Private note no Chatwoot

A atendente vê (na sidebar privada da conversa):

```
✅ Lead QUALIFICADO pela Alice (fora do expediente)
(ou ⚠️ COMPLIANCE / ℹ️ NÃO QUALIFICADO conforme outcome)

Nome: {lead_name}
Telefone: {lead_phone}
Período para retorno: {callback_period}
Motivo do handoff: {handoff_reason}

Resumo: {summary}
```

---

## 8. Fluxo Campanha Promocional (IGOR_Campaign_Sender)

One-shot. Sem IA conversacional. Cron `*/7 * * * *`.

### Sequência

```
Cron 7 min
  ↓
Load Campaign State (Postgres CTE) — settings + campaign_runs WHERE status='ativo' + COUNT(sent today)
  ↓
Compute Gates (Code) — should_proceed?
  - ai_enabled_global, workflows_enabled.IGOR_Campaign_Sender
  - campaign != null && status='ativo'
  - sent_today < max_daily_sends
  - janela 09:00-17:30 SP
  - dia útil (seg-sex)
  - não é feriado
  ↓
IF Should Proceed? — não → Resp Idle (200 com skip_reason). Sim → segue.
  ↓
Pick Eligible Batch (Postgres SELECT FOR UPDATE SKIP LOCKED LIMIT 2) — phone + contact_name + personalized_context
  ↓
Split In Batches (size=1) → Loop Items:
  Mark Sending (Postgres UPDATE status='scheduled') — transient state, evita dupla seleção
  ↓
  Pick Variant + Personalize (Code) — random 1 de 3 variantes em campaign_runs.message_variants[]; valida primeiro nome contra junk list (rejeita "Nada", "eliethmachado40", "DEUS É O MEU REFÚGIO" → fallback "Olá,")
  ↓
  Send WhatsApp (HTTP Evolution sendText, URL dinâmica `{{ instance }}`)
  ↓
  IF Send OK?
    True  → Update Sent (status='sent', sent_at, sent_message, message_variant) → Wait 5s (Chatwoot sync) → Search Chatwoot Contact → Get Conversations → Assign Promo Team (id=5) → INSERT event sent → Call IGOR_04 Labels [promo_maio_2026, promo_enviada, promo_disparo] → Wait jitter 45-90s → next batch
    False → Update Failed (status='send_failed', skip_reason) → INSERT event failed → Wait jitter → next batch
  ↓
Final Output (Set) — ok, batch_size, remaining_quota
```

### Variantes anti-block (3)

Coluna `campaign_runs.message_variants jsonb`. Personalização `{nome}` interpola primeiro nome de `contacts.name`. Variantes atuais (A/E/G — versão "mais quente" reformulada em 2026-05-18) descrevem oferta R$ 600 (de R$ 800) + bônus T Sculptor + condição de maio.

### Cadência

- Cron a cada 7 min
- batch=2 (no máximo 2 sends por execução)
- Wait 45-90s jitter ALEATÓRIO entre sends do mesmo batch
- max_daily_sends progressivo: dia 1: 20, dia 2: 50, dia 3+: 100 (configurável em `campaign_runs.max_daily_sends`)
- Janela 09:00-17:30 SP, seg-sex

### Tracking de resposta + agendamento

- **Lead responde**: IGOR_Inbound detecta `block_reason='campaign_active'` → executa node `Update Campaign Replied` ANTES de bloquear → `campaign_contacts.status='replied'` + `replied_at=now()`
- **Atendente aplica label `agendado` no Chatwoot**: IGOR_Chatwoot_Logger detecta `event=conversation_updated` + label `agendado` adicionada → UPDATE campaign_contacts SET `status='converted'`, `interest_classification='agendado'`, `handoff_at=now()`

---

## 9. Tratamento de Mídia

Quando lead manda algo que não é texto puro, switch no IGOR_Inbound aciona pipeline específico **antes** de Alice ver:

| Tipo | Pipeline |
|---|---|
| **Texto** (`conversation`/`extendedTextMessage`) | Extract Text (Set) — passthrough |
| **Áudio** (`audioMessage`) | Extrai Base64 → Base64 to Audio File → OpenAI Whisper `transcribe` → Padroniza Saida Audio (Set) |
| **Imagem** (`imageMessage`) | Preparar Imagem (Set, captura caption + base64) → Base64 to Image File → OpenAI Vision `gpt-4o-mini analyze` (prompt restritivo, classifica `clinical: true/false` + descrição) → Normalize Image Result (Set) |
| **Documento** (`documentMessage`) | Handle Document (Set, regex em filename + caption: `exame|laudo|receita|prescr|hemograma|ressonancia|...` → `clinical: true/false`) |
| **Unknown** | Handle Unknown (Set, marca como `[mensagem do tipo X]`) |

Todos convergem em `Prepare for Redis` com `{ message, clinical }`. Quando `clinical=true`, Alice é instruída a chamar `request_handoff(outcome='compliance')`.

### Por que não interpretamos clinicamente

Decisão de compliance: Instituto Dr. Igor é consultório médico. IA emitir qualquer opinião sobre exame seria exercício ilegal da medicina. Prompt do Vision tem instrução **explícita** de não interpretar — apenas classificar tipo.

---

## 10. Comportamento com mensagens do Chatwoot (IGOR_Chatwoot_Logger)

Webhook do Chatwoot dispara em vários eventos. Logger filtra e processa:

```
Chatwoot Webhook
  ↓
IF event=='message_created'
  - TRUE: Normalize Chatwoot Message → UPSERT Messages → Check IA Match (Postgres) → Compute Final Branch → Route By Branch
  - FALSE: IF agendado label added
    - TRUE: UPDATE campaign converted → INSERT campaign_agendamento → Filtered Response
    - FALSE: INSERT event_filtered → Filtered Response
```

### Detecção AI vs Humano (patch pós-incident 2026-05-18)

Problema: integração Evolution↔Chatwoot espelha msgs outgoing (incluindo as enviadas pela Alice via Evolution sendText) com `sender.type='user'` apontando pro admin Mateus Olinto. Indistinguível de humano respondendo manualmente.

Solução: **antes** de marcar como "humano respondeu", `Check IA Match` faz query:
```sql
SELECT COUNT(*) AS hits FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE c.chatwoot_conversation_id = $1
  AND m.role = 'assistant'
  AND m.created_at > now() - interval '120 seconds'
  AND (m.text = $2 OR m.normalized_text = $2)
```

Se `hits > 0`, é msg da Alice espelhada → `bot_noop` (não flipa owner_flow). Senão, humano real → `human_takeover` → UPDATE conv human_daytime + CALL IGOR_04 + INSERT event human_assumed.

---

## 11. Banco de Dados (Supabase)

Conexão via `igor_supabase_postgres` (session pooler).

### Tabelas principais

**`contacts`** — phone (unique), name, email, do_not_contact, consent_marketing.

**`conversations`** — chatwoot_conversation_id (unique), chatwoot_inbox_id, state, ai_enabled, human_locked, **owner_flow**, **journey_started_at**, **turn_count**, current_flow, assigned_team_id, last_message_at, last_ai_message_at, last_human_message_at.

`owner_flow` enum: `ai_active | human_daytime | handoff_queue | ai_unqualified | compliance_hold | opt_out`.

**`messages`** — conversation_id, msg_id (unique partial), text, normalized_text, message_type, direction (inbound/outbound), role (user/agent/assistant/system), from_me, safety_flags jsonb.

**`leads`** — contact_id, conversation_id, source, external_id, status, objective, callback_period, kommo_data jsonb, qualified_at, handoff_at, scheduled_at.

**`events`** — event_type, phone, chatwoot_conversation_id, workflow_name, payload jsonb (catch-all log).

**`settings`** — key (unique), value jsonb. Configs operacionais.

**`campaign_runs`** — id, name, status, message_template, **message_variants jsonb**, regular_price, promo_price, max_daily_sends, send_window_start/end, starts_at, ends_at. Status: `ativo | pausado | finalizado`.

**`campaign_contacts`** — campaign_id, contact_id, lead_id, phone, status, sent_at, replied_at, sent_message, message_variant, interest_classification, callback_period, handoff_at, optout_at. Status: `queued | scheduled | sent | delivered | replied | interested | not_interested | handoff_pending | handoff_done | converted | opt_out | send_failed | blocked | skipped`. UNIQUE (campaign_id, contact_id).

### Migrations aplicadas

```
001_core_schema.sql
002_indexes_constraints.sql
003_settings_seed.sql
004_campaign_schema.sql
005_rls_policies.sql
006_campaign_seed_2026-05.sql
007_asserts_rpc.sql
008_messages_msgid_unique.sql           # partial UNIQUE em msg_id
009_settings_fase_c_activation.sql      # after_hours_*, timezone, holiday_policy
010_settings_gates.sql                  # ⚠️ legacy: gates dry_run_send/allow_real removidos do código
011_chatwoot_assignee_optional.sql      # chatwoot_human_assignee_id (default null)
012_smoke_test_phone.sql                # ⚠️ legacy: settings smoke_test_phone/_message foram DELETED em runtime
013_settings_teams_and_flow.sql         # ai_team_id, human_daytime_team_id, handoff_queue_team_id, max_alice_turns
014_conversations_owner_flow.sql        # journey_started_at, owner_flow, turn_count
015_campaign_variants_and_tracking.sql  # campaign_runs.message_variants + seed das 3 variantes
```

### Convenções

- **Parametrizar** SEMPRE via `queryReplacement`. Nunca interpolar string em SQL.
- **`ON CONFLICT DO UPDATE`** pra UPSERT idempotente.
- **`FOR UPDATE SKIP LOCKED`** em SELECTs de fila (campanha).
- **`now()` lado servidor**, não tempo do n8n.
- **JSONB** pra payloads dinâmicos. `jsonb_set()` pra updates parciais.
- **Timezone-aware**: `(now() AT TIME ZONE 'America/Sao_Paulo')::date` quando precisar "dia útil" do negócio.

---

## 12. Configuração externa

Tabela `public.settings` (key/value jsonb). Lida no início de cada workflow via SELECT json_object_agg agregando.

Chaves operacionais ativas:

| Key | Tipo | Default | Uso |
|---|---|---|---|
| `ai_enabled_global` | bool | true | kill switch global |
| `workflows_enabled` | jsonb obj | `{IGOR_Inbound: true, IGOR_Campaign_Sender: true}` | flag por workflow |
| `after_hours_start` / `_end` | string HH:MM | `"18:30"` / `"07:30"` | janela horária do receptivo |
| `timezone` | string IANA | `"America/Sao_Paulo"` | check de horário |
| `holidays` | jsonb array YYYY-MM-DD | `[]` | feriados |
| `holiday_policy` | enum | `after_hours_force` | em feriado IA atua o dia todo |
| `chatwoot_human_assignee_id` | int OR null | null | atendente específica (null = team-only) |
| `ai_team_id` | int | 3 | team `ia após-expediente` |
| `human_daytime_team_id` | int | 1 | team `atendimento humano` |
| `handoff_queue_team_id` | int | 4 | team `aguardando retorno` |
| `promo_team_id` | int | 5 | team `promoção maio 2026` |
| `max_alice_turns` | int | 6 | turnos máximos antes de forçar handoff |
| `do_not_contact_keywords` | jsonb array | (PT-BR list) | opt-out keywords |
| `campaign_optout_threshold` | jsonb obj | `{window_size:20, max_optouts:3}` | auto-pausa campanha |

Chaves DELETADAS (não usar mais): `dry_run_send`, `allow_real_whatsapp_send`, `smoke_test_phone`, `smoke_test_message`, `human_team_id`, `after_hours_window`.

---

## 13. Credenciais n8n

Workflow refs por **nome canônico** (auto-resolve via MCP create_workflow_from_code para Postgres/OpenAI/Redis). HTTP nodes precisam wiring manual via REST.

| Nome canônico | Tipo | Header / Conn |
|---|---|---|
| `igor_chatwoot_api` (id `x8StLhAFnYjQxUFg`) | httpHeaderAuth | `api_access_token` |
| `igor_evolution_api` (id `DDhbwLsNclqTA18X`) | httpHeaderAuth | `apikey` |
| `igor_openai` | openAiApi | Bearer |
| `igor_supabase_postgres` (id `Z7DeBop4nK4JlIXO`) | postgres | session pooler |
| `igor_redis_embedded` (id `ayVMY7Njm6ecLLuc`) | redis | local |

⚠️ **Proibido**: `={{ $env.X }}` (container bloqueia) e `={{ $vars.X }}` (Enterprise-only).

---

## 14. Princípios arquiteturais inegociáveis

1. **Determinístico antes de LLM**. Gates de bloqueio são Code/IF/Switch/SQL — Alice só roda depois que TODOS os gates determinísticos passaram.
2. **Credenciais por nome**, não env vars. Vantagem: troca uma vez na UI propaga pra todos workflows.
3. **API pública do Chatwoot** pra qualquer mutação visual. Nunca UPDATE direto no banco do Chatwoot.
4. **Idempotência** em UPSERT, `ON CONFLICT DO NOTHING/UPDATE`. `FOR UPDATE SKIP LOCKED` em filas.
5. **1 webhook Evolution ativo por vez** (lição incident 2026-05-18).
6. **Defesa em profundidade no gate "lead novo"** — múltiplos sinais (Supabase + Chatwoot history + labels).
7. **errorWorkflow `ZrsbaSTlW5bqMEaS`** em todos workflows.
8. **`scheduled` não `sending`** pra status transient em campanha (CHECK constraint).
9. **NÃO interpretar clinicamente** — handoff compliance imediato.
10. **NÃO continuar respondendo após handoff** — gate determinístico via `owner_flow`.

---

## 15. Estado e dívidas (2026-05-20)

### Pendente antes de reativar IGOR_Inbound

Defesa em profundidade do gate "lead novo" (3 camadas — ver §6). Incident 2026-05-18 mostrou que gate atual `journey_started_at IS NULL` é insuficiente.

### Pendente antes de reativar IGOR_Campaign_Sender

- Lista Kommo de 137 leads ainda válida em `campaign_contacts` (134 queued + 6 sent durante teste, 1 deletado).
- Confirmar `dr.igor` profile name (atualmente "Instituto Aguiar Neri" — pode ou não estar correto pra clínica do Dr. Igor).
- Verificar variantes finais (A2/E2/G2 reformuladas em 2026-05-18 já aplicadas).

### Conhecimento sobre o número WhatsApp da clínica (dr.igor)

- ownerJid `557597047880@s.whatsapp.net` (75 9 7047-8880, Bahia)
- profileName: "Instituto Aguiar Neri" (não "Dr. Igor")
- Tem pacientes existentes em relacionamento ativo com atendentes humanas no Chatwoot — daí o motivo pelo qual gates de "lead novo" precisam ser robustos antes de reativar IGOR_Inbound nesse número.

### Detalhes operacionais

Lista completa de pendências em `tasks.md`. Procedimentos de pause/resume em `RUNBOOK.md`.

---

## 16. Glossário

- **Lead novo** — alguém que nunca teve interação registrada no Supabase (`conversations.journey_started_at IS NULL`) E que não tem histórico humano no Chatwoot.
- **Owner flow** — coluna em `conversations` que indica quem "possui" a conversa: `ai_active` (Alice), `human_daytime` (atendente), `handoff_queue` (aguardando retorno pós-Alice), `ai_unqualified` (Alice tentou e lead não engajou), `compliance_hold` (handoff por compliance), `opt_out`.
- **Callback period** — preferência do lead pro horário de retorno humano (manhã/tarde/noite + horário aprox).
- **Handoff** — Alice termina participação. Setado `human_locked=true`, conversa muda de team, atendente assume.
- **Compliance fast-path** — Alice nem conversa quando lead manda documento clínico. Bypass direto pro handoff humano.
- **Variant** — uma das 3 versões da mensagem promo (A2/E2/G2). Picked aleatoriamente por send pra reduzir filtros de spam.
- **Webhook duplo** — situação onde 2 instâncias Evolution têm webhook ativo apontando pro mesmo endpoint n8n. PROIBIDO.
- **Defesa em profundidade** — múltiplas camadas independentes pra mesmo gate. Aqui usado pra evitar que Alice responda paciente existente.
