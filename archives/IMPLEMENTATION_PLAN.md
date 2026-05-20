# IMPLEMENTATION_PLAN — Instituto Dr. Igor

> Versão: 0.3 — pós Fase C. Inbound (IGOR_01-08 + AUX) construído e ativo. Falta Frente Campanha (IGOR_10/12/13; IGOR_09 é script Python; IGOR_11 deferido inline).
>
> Este documento foca em **contratos por workflow** e schema. Para arquitetura geral, leia `docs/ARCHITECTURE.md`. Para estado vivo, `docs/VALIDATION_REPORT.md`.

Fonte funcional: `docs/logica-fluxo-igor-receptivo-fora-expediente.md` e `docs/logica-fluxo-igor-agente-ativo-promocao.md`. Em caso de conflito entre este plano e os documentos de lógica, os documentos prevalecem (exceto em nomes canônicos dos workflows, fixados no `AGENTS.md`).

---

## Sumário

1. [Arquitetura](#1-arquitetura)
2. [Catálogo dos 13 workflows IGOR](#2-catálogo-dos-13-workflows-igor)
3. [Contratos de dados entre workflows](#3-contratos-de-dados-entre-workflows)
4. [Matriz de bloqueios determinísticos](#4-matriz-de-bloqueios-determinísticos)
5. [Migrations Supabase (DDL completo)](#5-migrations-supabase-ddl-completo)
6. [Labels e custom_attributes Chatwoot](#6-labels-e-custom_attributes-chatwoot)
7. [Credentials n8n](#7-credentials-n8n)
8. [Fixtures](#8-fixtures)
9. [Scripts](#9-scripts)
10. [Plano de testes (Fase 6)](#10-plano-de-testes-fase-6)
11. [Kill switches e feature flags](#11-kill-switches-e-feature-flags)
12. [Riscos e mitigações](#12-riscos-e-mitigações)
13. [Decisões pendentes (P1)](#13-decisões-pendentes-p1)
14. [Informações faltantes (P2)](#14-informações-faltantes-p2)
15. [Critérios para avançar à Fase 2](#15-critérios-para-avançar-à-fase-2)

---

## 1. Arquitetura

```text
                       ┌──────────────────────────────────────────┐
                       │                Lead via WhatsApp         │
                       └────────────────────┬─────────────────────┘
                                            │
                                            ▼
                              ┌─────────────────────────┐
                              │  Evolution API          │
                              │  instance: convert-teste│
                              └─────────────┬───────────┘
                                            │ webhook MESSAGES_UPSERT
                                            ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                       n8n self-hosted                        │
        │                                                              │
        │  IGOR_01_Inbound_AfterHours ───┬─► IGOR_02_Media_Normalizer  │
        │                                ├─► IGOR_03_Agent_AfterHours  │
        │                                │    │ tools: get_state,      │
        │                                │    │   set_state, add_label,│
        │                                │    │   set_attr, save_lead, │
        │                                │    │   schedule_callback,   │
        │                                │    │   trigger_handoff      │
        │                                │    │                        │
        │                                │    └─► IGOR_05_Finalize_Handoff
        │                                │           │                 │
        │                                │           └─► IGOR_04_Tool_Labels_Attributes
        │                                │                             │
        │                                └─► IGOR_07_Error_Logger      │
        │                                                              │
        │  IGOR_06_Chatwoot_Message_Logger  (webhook do Chatwoot)      │
        │  IGOR_08_Health_Check             (schedule 5–10 min)        │
        │                                                              │
        │  IGOR_09_Campaign_Importer ───► IGOR_04 (labels)             │
        │  IGOR_10_Campaign_Dispatcher ─► IGOR_11_Campaign_Message_Generator
        │                              ─► Evolution sendText           │
        │  IGOR_12_Campaign_Inbound_Handler ─► IGOR_02                 │
        │                                  ─► IGOR_13_Agent_Campaign   │
        │                                       └─► IGOR_05            │
        └──────┬────────────────────────────┬─────────────────┬────────┘
               │                            │                 │
               ▼                            ▼                 ▼
        ┌──────────────┐           ┌─────────────────┐   ┌──────────┐
        │  Supabase    │           │     Chatwoot    │   │  Redis   │
        │  (DB + RPC)  │           │  (inbox, labels,│   │ embarcado│
        │              │           │  attrs, teams)  │   │  no n8n  │
        └──────────────┘           └─────────────────┘   └──────────┘

LangSmith (opcional)         OpenAI / Gemini (LLM)
```

### Princípio aplicado

- **Decisões determinísticas** em Code nodes, IF, Switch, SQL, locks Redis.
- **LLM apenas** para: resposta conversacional, transcrição/descrição de mídia, extração semântica estruturada, classificação de intenção, personalização de mensagem de campanha, resumo para nota interna.
- **A LLM nunca decide** se pode responder, enviar campanha, ignorar opt-out, sobrescrever labels, ativar envio real, alterar produção ou responder depois que humano assumiu.

---

## 2. Catálogo dos 13 workflows IGOR

Cada entrada inclui: trigger, contrato de entrada, decisões determinísticas (em ordem), uso de LLM, sub-workflows chamados, mutações produzidas, observabilidade.

### IGOR_01_Inbound_AfterHours
- **Trigger**: webhook (`POST /webhook/igor/inbound`).
- **Entrada**: payload Evolution `MESSAGES_UPSERT` (texto/áudio/imagem/documento).
- **Decisões determinísticas (ordem)**:
  1. `payload.data.key.fromMe === true` → NoOp.
  2. `settings.ai_enabled_global === false` → NoOp + log.
  3. `settings.workflows_enabled.IGOR_01 === false` → NoOp.
  4. Normalizar phone (`5511XXXXXXXXX`). Inválido → INSERT `events('invalid_phone')` + NoOp.
  5. Lookup `contacts` por phone. Se `do_not_contact = true` → NoOp + label `optout` na conversa.
  6. Lookup `conversations` por `chatwoot_conversation_id`. Se `human_locked = true` OU `ai_enabled = false` → NoOp.
  7. Se contato em `campaign_contacts` com status ∈ (`sent`,`delivered`,`replied`,`interested`) → roteia para `IGOR_12_Campaign_Inbound_Handler` e sai.
  8. Verificar janela: se hora atual ∈ [`AFTER_HOURS_END`, `AFTER_HOURS_START`) (em `TIMEZONE`) → NoOp (dentro do expediente).
  9. Verificar feriado/fim-de-semana via `settings.holidays` (lista de YYYY-MM-DD em JSON). Se feriado → comportamento `settings.holiday_policy` (P1).
  10. Adquirir lock Redis `igor:lock:inbound:{phone}` com `SET NX EX 30`. Falha → enfileirar com `RPUSH igor:batch:{phone}` e sair.
  11. Chamar `IGOR_02_Media_Normalizer` se `messageType ≠ text`.
  12. Chamar `IGOR_03_Agent_AfterHours` com payload normalizado.
- **LLM**: não (router puro).
- **Sub-workflows**: `IGOR_02`, `IGOR_03`, `IGOR_07` (error path).
- **Mutações**: `events`, `messages` (insert), `conversations.state = ai_after_hours`, Chatwoot label `fora_expediente`, Redis lock.
- **Observabilidade**: log `inbound_received`, `inbound_blocked` (com motivo), `inbound_routed`.

### IGOR_02_Media_Normalizer
- **Trigger**: callable (`executeWorkflowTrigger`).
- **Entrada**: `{ phone, msgId, messageType, media_url|media_base64, caption?, mimeType? }`.
- **Decisões**:
  - `audio` → baixar + transcrever (modelo P1: Whisper-1 ou Gemini 1.5 Audio).
  - `image` → se sem caption: descrever + classificar sensibilidade (visão LLM com prompt restritivo). Se `safety_flags.clinical = true` → forçar `should_handoff = true`.
  - `document` (pdf): tipo → se contém heurística clínica ("exame", "laudo", "prescrição", "receita", CRM, "diagnóstico") → `should_handoff = true`, `handoff_reason = documento_clinico_sensivel`.
  - `text` → passa direto.
  - `unknown` → `should_handoff = true`, `handoff_reason = mídia_desconhecida`.
- **Saída**: `{ normalized_text, media_summary?, safety_flags{ clinical, sensitive_image, payment_proof, financial }, should_handoff, handoff_reason? }`.
- **LLM**: SIM — transcrição (áudio), descrição/classificação (imagem), classificação de documento.
- **Sub-workflows**: nenhum.
- **Mutações**: `messages` (insere a versão normalizada com `transcript`, `summary`, `safety_flags`).
- **Observabilidade**: log `media_normalized` com `messageType` e `safety_flags`.

### IGOR_03_Agent_AfterHours
- **Trigger**: callable.
- **Entrada**: payload normalizado de `IGOR_01`.
- **Decisões determinísticas dentro do agente** (pré-LLM):
  - `should_handoff` do normalizer → pular conversa e chamar `IGOR_05` direto com motivo compliance.
- **Comportamento conversacional** (Alice):
  - Saudar (apenas na primeira interação da janela), coletar `nome`, `objetivo_principal`, `callback_period`.
  - Memória: Postgres Chat Memory ligada ao Supabase, key = `chatwoot_conversation_id`.
  - Tools acopladas: `get_conversation_state`, `update_conversation_state`, `save_lead_partial`, `request_handoff`. Tools são `executeWorkflow` apontando para `IGOR_04` e `IGOR_05`.
- **Saída**: mensagem em Chatwoot via `POST /api/v1/accounts/{id}/conversations/{c}/messages`. Se `DRY_RUN`, log em `events('dry_run_send')` em vez de mandar.
- **LLM**: SIM (gpt-4 ou gemini — P1) — resposta conversacional e extração estruturada.
- **Sub-workflows**: `IGOR_04`, `IGOR_05`.
- **Mutações**: `messages`, `leads` (parcial: name, objective, callback), `conversations.state`, labels (`qualificacao_rapida`, `callback_solicitado`, etc.), custom_attributes.
- **Observabilidade**: `after_hours_started`, `after_hours_name_collected`, `after_hours_objective_collected`, `callback_collected`, `agent_error`.

### IGOR_04_Tool_Labels_Attributes
- **Trigger**: callable.
- **Entrada**: `{ chatwoot_conversation_id, chatwoot_contact_id?, labels_to_add: [], labels_to_remove: [], custom_attributes: { conversation: {}, contact: {} } }`.
- **Decisões**:
  - GET labels atuais da conversa e do contato.
  - Mesclar `add` com lista atual (não sobrescrever), remover apenas o explicitado.
  - PATCH custom_attributes (não DELETE).
- **LLM**: não.
- **Sub-workflows**: nenhum.
- **Mutações**: labels e custom_attributes no Chatwoot.
- **Observabilidade**: `label_added`, `attribute_set`.

### IGOR_05_Finalize_Handoff
- **Trigger**: callable.
- **Entrada**: `{ chatwoot_conversation_id, chatwoot_contact_id, lead_id?, handoff_reason, summary, callback_period?, owner_flow }`.
- **Decisões (sequência obrigatória)**:
  1. UPDATE `conversations SET state='human_assigned', ai_enabled=false, human_locked=true, assigned_team_id=...`.
  2. UPDATE `leads SET status='aguardando_atendente', handoff_at=now()`.
  3. Chamar `IGOR_04` com `labels_to_add: ['handoff_done','ai_disabled','aguardando_atendente']`.
  4. Criar private note em Chatwoot via `POST /messages` com `private: true` e template padrão.
  5. Assign team via `POST /api/v1/accounts/{id}/conversations/{c}/assignments` body `{team_id}`.
  6. (Opcional) Assignee específico se `CHATWOOT_HUMAN_ASSIGNEE_ID` setado.
  7. INSERT `events('handoff_complete', payload)`.
  8. Enviar mensagem final ao lead (texto fixo). Se DRY_RUN, log.
- **LLM**: não.
- **Sub-workflows**: `IGOR_04`.
- **Mutações**: Chatwoot (labels, attrs, assignment, private note, mensagem final), Supabase (`conversations`, `leads`, `events`).
- **Observabilidade**: `handoff_complete` com `handoff_reason`.

### IGOR_06_Chatwoot_Message_Logger
- **Trigger**: webhook (`POST /webhook/igor/chatwoot`) recebendo eventos Chatwoot.
- **Entrada**: payload `message_created` do Chatwoot.
- **Decisões**:
  - `body.event === 'message_created'` (filtra outros eventos).
  - Se `message_type === 'outgoing'` e `sender.type === 'user'` (agente humano) → SET `conversations.human_locked = true, ai_enabled = false`. Aplicar label `atendimento_humano`. Insert `events('human_assumed')`.
  - Se `sender.type === 'agent_bot'` → não trava (é o próprio Igor).
  - Sempre insere `messages` (espelhamento).
- **LLM**: não.
- **Mutações**: `conversations`, `messages`, `events`; Chatwoot label.
- **Observabilidade**: `human_assumed`, `message_mirrored`.

### IGOR_07_Error_Logger
- **Trigger**: `errorTrigger` — referenciado por todos os outros workflows via `errorWorkflow`.
- **Entrada**: `$json.workflow`, `$json.execution`, `$json.execution.error`.
- **Decisões**: monta payload com `workflow_id, workflow_name, execution_id, last_node, error_message, error_stack` (mascarado).
- **LLM**: não.
- **Mutações**: INSERT `events('infra_error', payload)`.

### IGOR_08_Health_Check
- **Trigger**: schedule (a cada 10 min — `*/10 * * * *`).
- **Decisões/Checks**:
  - Ping Evolution `/instance/connectionState/{instance}` → status open?
  - Ping Chatwoot `/api/v1/accounts/{id}` → 200?
  - SELECT contagens últimas 24h em `events`, `messages`, `leads`, `campaign_contacts`.
  - Detectar: conversas com `ai_enabled = true` recebendo mensagem do agent humano (race), batches Redis órfãos (`KEYS igor:batch:*` com TTL alto), `infra_error` > threshold, opt-out > threshold.
- **LLM**: não.
- **Mutações**: INSERT `events('health_check')`.
- **Observabilidade**: o evento `health_check` é a fonte do dashboard operacional.

### IGOR_09_Campaign_Importer
- **Trigger**: **manual via `scripts/import-kommo-csv.sh`** (carga inicial única; decisão fechada em 2026-05-14). Script lê os CSVs em `lista-leads/` (gitignored).
- **Entrada**: CSVs do Kommo (formato `kommo_export_leads_*.csv`, 66 colunas, header padrão). Carga inicial atual: **2 CSVs com ~139 leads no total**. Todos importados com mesmo `source='kommo_2026-05-14'`, mesmo `campaign_run`, mesma mensagem. O `Funil de vendas` e `Etapa` do Kommo são categorização interna (humano/IA é organização nossa, não muda nada para o lead) — vão para `leads.kommo_data` apenas como metadata. Dedup pelo `ID` Kommo se mesmo lead aparecer nos dois CSVs.
- **Decisões** (filtros adicionais que o usuário pediu para NÃO aplicar — ele pré-filtrou ao gerar os arquivos):
  1. Validar campanha em `campaign_runs.status = 'ativo'` (vai existir após a migration `004` e um `INSERT INTO campaign_runs ...` manual).
  2. Para cada linha:
     - Normalizar telefone (`Celular` → strip `'`, validar `55+DDD+9 dígitos`). Inválido → `campaign_contacts.status='skipped'`, `skip_reason='invalid_phone'`.
     - Dedup por (`source='kommo_csv_<data>'`, `external_id=ID_Kommo`) e por `phone` (se já existe contato com mesmo telefone, usar o existente).
     - Upsert `contacts` (name, email, phone).
     - Upsert `leads` (com `external_id`, `source`, `objective` = `Objetivo principal`, `city` = `Cidade`, e `kommo_data` JSON com os campos ricos do Kommo).
     - Checklist universal de elegibilidade (apenas):
       - `contacts.do_not_contact = false`
       - `leads.scheduled_at IS NULL`
       - não recebeu campanha nos últimos 30 dias (se houver `campaign_contacts` anterior)
       - **etapa Kommo ≠ AGENDADO** (decisão 2026-05-14: pular se já tem consulta marcada; `skip_reason='ja_agendado_kommo'`)
     - Falha → `campaign_contacts.status='skipped'` + `skip_reason`.
     - Sucesso → `campaign_contacts.status='queued'` + `eligibility_reason='kommo_csv_import'` + `personalized_context` (texto curto montado dos campos Kommo, ver IGOR_11).
- **LLM**: não.
- **Sub-workflows**: `IGOR_04` (labels `promo_eligivel` para queued ou `optout`/`erro_envio` para skip).
- **Mutações**: `contacts`, `leads`, `campaign_contacts`, labels Chatwoot.
- **Não roda em n8n inicialmente**: é um script Bash + Python local que escreve direto no Supabase via PostgREST. Migrar para workflow n8n depois é opcional.

#### Mapeamento Kommo CSV → Supabase

| Coluna CSV | Destino |
|---|---|
| `ID` | `leads.external_id` (string) + chave de dedup |
| `Nome completo` | `contacts.name` |
| `Celular` | `contacts.phone` (normalizado) |
| `Email pessoal` (ou `Email comercial`) | `contacts.email` |
| `Cidade` | `leads.city` |
| `Objetivo principal` | `leads.objective` |
| `Motivo não agendamento`, `Capacidade financeira/Investimento`, `Urgência`, `Disponibilidade`, `Busca medicação`, `Tentativas anteriores`, `Perguntou método`, `Canal preferido`, `Ultima mensagem`, `Resposta IA`, `Tags`, `Funil de vendas`, `Etapa do lead` | `leads.kommo_data` (jsonb) |
| `Primeiro Contato`, `Ultima mensagem` (data) | `leads.kommo_data.dates` |
| `utm_*`, `gclid`, `fbclid`, `referrer` | `leads.kommo_data.attribution` |

### IGOR_10_Campaign_Dispatcher
- **Trigger**: schedule (`*/1 * * * 1-5` durante `CAMPAIGN_SEND_WINDOW_*`).
- **Decisões**:
  1. `settings.workflows_enabled.IGOR_10 === false` → sair.
  2. Hora atual ∈ janela `[CAMPAIGN_SEND_WINDOW_START, CAMPAIGN_SEND_WINDOW_END)`? Não → sair.
  3. Dia da semana ∈ 1..5 (seg-sex)? Não → sair.
  4. `feriado(hoje)` em `settings.holidays`? Sim → sair.
  5. Contagem do dia em `campaign_contacts WHERE sent_at::date = CURRENT_DATE` < `CAMPAIGN_DAILY_LIMIT`? Não → sair.
  6. Throttle: já enviou nos últimos `60/CAMPAIGN_PER_MINUTE_LIMIT` segundos? Sim → sair.
  7. Buscar 1 `campaign_contacts WHERE status='queued' AND campaign_id IN (campaigns ativos) ORDER BY created_at LIMIT 1`.
  8. **Revalidar elegibilidade** (do_not_contact mudou? human_locked? agendou? bloqueio manual?). Falhou → status='skipped'.
  9. Chamar `IGOR_11_Campaign_Message_Generator` → recebe `sent_message`.
  10. Se `ALLOW_REAL_WHATSAPP_SEND=true` AND `IGOR_DRY_RUN=false`: enviar via Evolution. Senão: log `dry_run_send`.
  11. UPDATE `campaign_contacts.status='sent', sent_at=now()`.
- **LLM**: não.
- **Sub-workflows**: `IGOR_11`, `IGOR_04`.
- **Mutações**: `campaign_contacts`, `messages`, Evolution sendText (condicional), labels.

### IGOR_11_Campaign_Message_Generator
- **Trigger**: callable.
- **Entrada**: `{ campaign_id, contact: { name, phone }, campaign_run: { message_template } }`.
- **Decisões**:
  - Carrega `campaign_runs.message_template` (texto literal aprovado).
  - Substitui variáveis simples: `{nome}` → `contact.name` se existir, senão remove a saudação personalizada e mantém só "Olá 😊".
  - Sem variantes A/B no MVP (decisão 2026-05-14: template único).
- **LLM**: **não**. Decisão 2026-05-14 — o template é texto fixo aprovado; LLM não interfere (zero risco de inventar preço, prometer resultado, ou alterar copy).
- **`personalized_context`** continua sendo populado em `campaign_contacts` para análise futura, mas **não é usado para gerar mensagem** nesta campanha.
- **Saída**: `{ sent_message }`.
- **Mutações**: `campaign_contacts.sent_message`.

#### Template canônico (decidido em 2026-05-14)

Armazenado em `campaign_runs.message_template`:

```
Olá 😊

Como você demonstrou interesse em iniciar esse cuidado com o Dr. Igor, quis te avisar antecipadamente sobre uma condição especial disponível durante o mês de maio para novos pacientes.

Neste período, o investimento da consulta está em R$ 600, com taxa de agendamento de R$ 180, integralmente abatida no valor da consulta.

E tem mais um detalhe, os pacientes que realizarem o agendamento neste mês ganharão 01 sessão de T Sculptor.

O T Sculptor é uma tecnologia voltada para fortalecimento muscular e auxílio na redução de gordura, ajudando na definição corporal, ganho de massa muscular e melhora do contorno corporal de forma não invasiva.

Como a agenda permanece limitada, estou entrando em contato primeiro com os pacientes que já haviam demonstrado interesse no acompanhamento.

Se fizer sentido para você neste momento, posso verificar os horários disponíveis.
```

Não há variável obrigatória no template. Se quiser adicionar `{nome}` na saudação ("Olá, {nome} 😊"), fica como opção futura — me avise.

### IGOR_12_Campaign_Inbound_Handler
- **Trigger**: callable (chamado por `IGOR_01` quando detecta resposta de campanha) **ou** webhook próprio caso o webhook Evolution roteie por path.
- **Decisões** (idênticas em estrutura ao `IGOR_01`, mas no contexto campanha):
  1. `fromMe`, `human_locked`, `ai_enabled`, opt-out → bloquear.
  2. `campaign_contacts.status` deve estar em (`sent`,`delivered`,`replied`) — caso contrário rotear para `IGOR_01`.
  3. Chamar `IGOR_02` para normalizar mídia.
  4. Classificar intenção: `interested`, `price_question`, `scheduling`, `doubt`, `not_interested`, `opt_out`, `human_request`, `sensitive_medical`, `unknown` (regra-determinística + confirmação LLM).
  5. `opt_out` → set `contacts.do_not_contact=true`, `campaign_contacts.status='opt_out'`, label `promo_optout`, IA não responde mais.
  6. `unknown` → caminho explícito: Alice pergunta "Pode me dizer com outras palavras?" e classifica novamente.
  7. Demais → chamar `IGOR_13`.
- **Sub-workflows**: `IGOR_02`, `IGOR_13`, `IGOR_05`.
- **Mutações**: `campaign_contacts`, `events`, labels.

### IGOR_13_Agent_Campaign
- **Trigger**: callable.
- **Entrada**: payload normalizado + classificação de intenção + `personalized_context`.
- **Decisões internas**:
  - Conversa explica oferta (preço, validade, mídia opcional).
  - Coleta `callback_period`.
  - Chama `IGOR_05` no momento certo.
- **LLM**: SIM — resposta conversacional.
- **Mutações**: `messages`, `campaign_contacts`, `events`.

---

## 3. Contratos de dados entre workflows

### Payload normalizado (saída de `IGOR_02`, entrada de `IGOR_03`/`IGOR_13`)

```json
{
  "phone": "5562XXXXXXXXX",
  "msgId": "evolution-msg-uuid",
  "fromMe": false,
  "messageType": "text|audio|image|document|unknown",
  "text": "Texto bruto ou caption original",
  "normalized_text": "Texto que o agente usa (transcrição/descrição/texto original)",
  "media": {
    "url": "https://...",
    "mime_type": "audio/ogg|image/jpeg|application/pdf|null",
    "summary": "Descrição curta para imagens; null para áudio/texto"
  },
  "safety_flags": {
    "clinical": false,
    "sensitive_image": false,
    "payment_proof": false,
    "financial": false,
    "unknown_media": false
  },
  "chatwoot_conversation_id": 123,
  "chatwoot_contact_id": 456,
  "chatwoot_inbox_id": 7,
  "timestamp": "2026-05-14T22:31:00-03:00",
  "routing_decision": {
    "should_handoff": false,
    "handoff_reason": null,
    "owner_flow": "after_hours|campaign|null",
    "campaign_id": null,
    "campaign_contact_id": null
  }
}
```

### Resposta padrão de callables

```json
{
  "success": true,
  "data": { /* específico do callable */ },
  "error": null
}
```

Em erro: `{ "success": false, "data": null, "error": "code_string" }`.

---

## 4. Matriz de bloqueios determinísticos

Cada linha = um estado que IMPEDE a IA de agir. Cobertura obrigatória.

| Estado | Workflow que checa | Nó/IF | Query/expressão | Comportamento ao bloquear |
|---|---|---|---|---|
| `fromMe === true` | IGOR_01, IGOR_12 | IF `payload.data.key.fromMe` | direto do payload | NoOp |
| `ai_enabled_global === false` | IGOR_01, IGOR_10, IGOR_12 | SQL SELECT settings | `SELECT value FROM settings WHERE key='ai_enabled_global'` | NoOp + log |
| `workflows_enabled.IGOR_XX === false` | cada workflow no nó 1 | SQL | `SELECT value->>'IGOR_XX' FROM settings WHERE key='workflows_enabled'` | NoOp |
| `contacts.do_not_contact === true` | IGOR_01, IGOR_09, IGOR_10, IGOR_12 | SQL lookup | `SELECT do_not_contact FROM contacts WHERE phone=$1` | NoOp + label `optout` |
| `conversations.human_locked === true` | IGOR_01, IGOR_12 | SQL | `SELECT human_locked FROM conversations WHERE chatwoot_conversation_id=$1` | NoOp |
| `conversations.ai_enabled === false` | IGOR_01, IGOR_12 | SQL | `SELECT ai_enabled FROM conversations WHERE chatwoot_conversation_id=$1` | NoOp |
| Label `ai_disabled`/`handoff_done`/`atendimento_humano` | IGOR_01, IGOR_12 | GET Chatwoot labels da conversa | `GET /conversations/{c}/labels` | NoOp (defesa em profundidade vs. DB) |
| Fora da janela after-hours (e mensagem inbound) | IGOR_01 | Code | hora em `TIMEZONE` vs `AFTER_HOURS_START..END` | NoOp (atendente humana cuida) |
| Feriado / fim de semana (after-hours) | IGOR_01 | Code | `settings.holidays JSON`, dow | NoOp + comportamento `holiday_policy` |
| Janela de campanha fora | IGOR_10 | Code | `CAMPAIGN_SEND_WINDOW_*` | sair |
| Limite diário de campanha atingido | IGOR_10 | SQL | `COUNT campaign_contacts.sent_at::date=today` | sair |
| Per-minute throttle | IGOR_10 | Redis | `GET igor:campaign:lastSentAt` | sair |
| Já em campanha ativa (resp em IGOR_01) | IGOR_01 | SQL | `campaign_contacts.status IN (...)` | rotear para IGOR_12 |
| Bloqueio manual | IGOR_09, IGOR_10 | SQL | `campaign_contacts.status='blocked'` | skip |
| Recebeu campanha nos últimos 30 dias | IGOR_09 | SQL | `campaign_contacts.sent_at > now() - INTERVAL '30 days'` para mesmo contact_id | skip |
| Já agendou | IGOR_09, IGOR_10, IGOR_13 | SQL | `leads.scheduled_at IS NOT NULL` | skip / não insistir |
| `safety_flags.clinical === true` ou `sensitive_image === true` | IGOR_02 → IGOR_03/IGOR_13 | Boolean do payload | direto | `should_handoff=true`, compliance handoff |
| Rota `unknown` | IGOR_01, IGOR_03, IGOR_12, IGOR_13 | Switch fallback | default branch | log `unknown_route`, pergunta de esclarecimento, sem ação irreversível |

**Regra de ouro**: a primeira checagem que falha encerra o fluxo. Nenhum estado é avaliado pela LLM.

---

## 5. Migrations Supabase (DDL completo)

Cinco arquivos, na ordem fixada pelo `AGENTS.md`. Aplicação 100% manual no Supabase SQL Editor (decisão da Fase 0).

### 5.1 `supabase/migrations/001_core_schema.sql`

```sql
-- Igor — core schema
-- Idempotente: usa IF NOT EXISTS / DO blocks.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- contacts
CREATE TABLE IF NOT EXISTS public.contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone              text NOT NULL UNIQUE,
  name               text,
  email              text,
  consent_marketing  boolean NOT NULL DEFAULT false,
  do_not_contact     boolean NOT NULL DEFAULT false,
  optout_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- conversations
CREATE TABLE IF NOT EXISTS public.conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  chatwoot_conversation_id integer NOT NULL UNIQUE,
  chatwoot_inbox_id        integer NOT NULL,
  state                    text NOT NULL DEFAULT 'new',
  ai_enabled               boolean NOT NULL DEFAULT true,
  human_locked             boolean NOT NULL DEFAULT false,
  current_flow             text,                  -- after_hours | campaign | null
  assigned_team_id         integer,
  assigned_agent_id        integer,
  last_message_at          timestamptz,
  last_ai_message_at       timestamptz,
  last_human_message_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- leads
CREATE TABLE IF NOT EXISTS public.leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id      uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  source               text,                       -- ex: 'kommo_csv_2026-05-14', 'whatsapp', 'meta_ads'
  external_id          text,                       -- ex: ID do lead no Kommo (deduplicação na importação)
  status               text NOT NULL DEFAULT 'novo',
  objective            text,
  city                 text,
  callback_preference  text,
  callback_period      text,
  kommo_data           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- campos ricos do Kommo: motivo_nao_agendamento, capacidade_financeira, urgencia, disponibilidade, busca_medicacao, tentativas_anteriores, perguntou_metodo, canal_preferido, ultima_mensagem, resposta_ia, tags
  qualified_at         timestamptz,
  handoff_at           timestamptz,
  scheduled_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

-- messages (espelho normalizado de Evolution + Chatwoot)
CREATE TABLE IF NOT EXISTS public.messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  msg_id              text,                       -- Evolution msgId
  text                text,
  normalized_text     text,
  message_type        text NOT NULL,              -- text|audio|image|document|unknown
  direction           text NOT NULL,              -- inbound|outbound|internal
  role                text NOT NULL,              -- user|assistant|agent|system
  from_me             boolean NOT NULL DEFAULT false,
  media_url           text,
  media_mime_type     text,
  media_summary       text,
  safety_flags        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- events (log universal)
CREATE TABLE IF NOT EXISTS public.events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         text NOT NULL,
  phone              text,
  chatwoot_conversation_id integer,
  campaign_id        uuid,
  campaign_contact_id uuid,
  workflow_name      text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- assignments (vendedor / atendente humana atribuída ao lead)
CREATE TABLE IF NOT EXISTS public.assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  agent_id     integer,            -- Chatwoot agent.id
  team_id      integer,            -- Chatwoot team.id
  assigned_at  timestamptz NOT NULL DEFAULT now()
);

-- conversation_summaries (resumo curto para atendente)
CREATE TABLE IF NOT EXISTS public.conversation_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  summary         text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.contacts                IS 'Contato único, opt-out global vive aqui';
COMMENT ON TABLE  public.conversations           IS 'Estado da conversa Chatwoot; ai_enabled/human_locked são os flags de bloqueio determinístico principais';
COMMENT ON TABLE  public.leads                   IS 'Aspecto comercial do contato; um contato pode ter múltiplos leads ao longo do tempo';
COMMENT ON TABLE  public.messages                IS 'Espelho normalizado das mensagens; inclui transcrições e flags de mídia';
COMMENT ON TABLE  public.events                  IS 'Log universal — toda decisão importante grava aqui';
COMMENT ON TABLE  public.assignments             IS 'Vínculo lead → atendente humana (após handoff)';
COMMENT ON TABLE  public.conversation_summaries  IS 'Resumo curto da conversa, usado em private note no handoff';
```

### 5.2 `supabase/migrations/002_indexes_constraints.sql`

```sql
-- Índices e CHECK constraints

CREATE INDEX IF NOT EXISTS idx_contacts_phone               ON public.contacts (phone);
CREATE INDEX IF NOT EXISTS idx_conversations_contact        ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_state          ON public.conversations (state);
CREATE INDEX IF NOT EXISTS idx_leads_contact                ON public.leads (contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_status                 ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time   ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid               ON public.messages (msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_type_time             ON public.events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_conv                  ON public.events (chatwoot_conversation_id) WHERE chatwoot_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_lead             ON public.assignments (lead_id);

-- Enums via CHECK (mais flexível que tipo enum para evoluir)
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_state_check,
  ADD CONSTRAINT conversations_state_check CHECK (state IN (
    'new','after_hours_candidate','ai_after_hours','collecting_name','quick_qualification',
    'collecting_callback_time','handoff_pending','human_assigned','human_locked','closed',
    'opt_out','compliance_hold',
    'campaign_active','campaign_replied','campaign_interested','campaign_collecting_callback',
    'campaign_handoff_pending','campaign_handoff_done','campaign_opt_out'
  ));

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_status_check,
  ADD CONSTRAINT leads_status_check CHECK (status IN (
    'novo','em_atendimento_ia_fora_expediente','qualificacao_rapida','callback_solicitado',
    'callback_horario_coletado','aguardando_atendente','humano_em_atendimento','agendado',
    'nao_interessado','opt_out'
  ));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_type_check,
  ADD CONSTRAINT messages_type_check CHECK (message_type IN ('text','audio','image','document','unknown')),
  DROP CONSTRAINT IF EXISTS messages_direction_check,
  ADD CONSTRAINT messages_direction_check CHECK (direction IN ('inbound','outbound','internal')),
  DROP CONSTRAINT IF EXISTS messages_role_check,
  ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant','agent','system'));

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_type_check,
  ADD CONSTRAINT events_type_check CHECK (event_type ~ '^[a-z_]+$');
```

### 5.3 `supabase/migrations/003_settings_seed.sql`

```sql
-- Tabela settings + seed mínimo

CREATE TABLE IF NOT EXISTS public.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.settings (key, value) VALUES
  ('ai_enabled_global', 'true'::jsonb),
  ('workflows_enabled', '{
      "IGOR_01": false, "IGOR_02": false, "IGOR_03": false, "IGOR_04": false,
      "IGOR_05": false, "IGOR_06": false, "IGOR_07": true,  "IGOR_08": false,
      "IGOR_09": false, "IGOR_10": false, "IGOR_11": false, "IGOR_12": false,
      "IGOR_13": false
   }'::jsonb),
  ('after_hours_window', '{"start": "18:30", "end": "07:30", "timezone": "America/Sao_Paulo"}'::jsonb),
  ('holidays', '[]'::jsonb),  -- feriado = tratamento idêntico ao fora de expediente
  ('do_not_contact_keywords', '[
      "pare","parar","para","remova","remover","cancela","cancelar","sair","saia",
      "nao quero","não quero","sem interesse","nao envia","não envia","stop","unsubscribe"
   ]'::jsonb),
  ('human_team_id', 'null'::jsonb),
  ('human_inbox_id', 'null'::jsonb),
  ('campaign_offer', '{
      "regular_price": 800,
      "promo_price": 600,
      "valid_until": "2026-05-31"
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.settings IS 'Configuração runtime do Igor — alterar aqui pausa/destrava workflows sem reimportar';
```

### 5.4 `supabase/migrations/004_campaign_schema.sql`

```sql
-- Campanha promocional

CREATE TABLE IF NOT EXISTS public.campaign_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  offer_name          text NOT NULL,
  regular_price       numeric(10,2),
  promo_price         numeric(10,2),
  booking_fee         numeric(10,2),                -- taxa de agendamento (R$ 180 na campanha atual)
  booking_fee_note    text,                         -- ex: "integralmente abatida no valor da consulta"
  bonuses             jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ex: [{"name":"T Sculptor","description":"01 sessão"}]
  message_template    text NOT NULL,                -- texto fixo aprovado; suporta {nome} opcional
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'ativo',
  media_url           text,
  media_type          text,
  media_caption       text,
  max_daily_sends     integer NOT NULL DEFAULT 20,
  send_window_start   text NOT NULL DEFAULT '09:00',
  send_window_end     text NOT NULL DEFAULT '17:30',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_runs_status_check CHECK (status IN ('ativo','pausado','finalizado')),
  CONSTRAINT campaign_runs_media_type_check CHECK (media_type IS NULL OR media_type IN ('image','video','none'))
);

CREATE TABLE IF NOT EXISTS public.campaign_contacts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              uuid NOT NULL REFERENCES public.campaign_runs(id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  lead_id                  uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  phone                    text NOT NULL,
  status                   text NOT NULL DEFAULT 'queued',
  eligibility_reason       text,
  skip_reason              text,
  personalized_context     text,
  message_variant          text,
  sent_message             text,
  sent_at                  timestamptz,
  delivered_at             timestamptz,
  replied_at               timestamptz,
  interest_classification  text,
  callback_period          text,
  handoff_at               timestamptz,
  optout_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_contacts_status_check CHECK (status IN (
    'queued','skipped','scheduled','sent','delivered','replied',
    'interested','not_interested','handoff_pending','handoff_done',
    'converted','opt_out','send_failed','blocked'
  )),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status     ON public.campaign_contacts (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_phone      ON public.campaign_contacts (phone);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_sent_at    ON public.campaign_contacts (sent_at) WHERE sent_at IS NOT NULL;
```

### 5.5 `supabase/migrations/005_rls_policies.sql`

```sql
-- RLS: ligar em todas as tabelas; deixar service_role livre (bypass automático);
-- NÃO usar FORCE ROW LEVEL SECURITY para não bloquear o service_role do n8n.
-- Painel humano (authenticated) pode ler tudo mas não escrever, por enquanto.

ALTER TABLE public.contacts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_contacts       ENABLE ROW LEVEL SECURITY;

-- Policy de leitura para usuários authenticated (painel humano futuro)
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'contacts','conversations','leads','messages','events','assignments',
      'conversation_summaries','settings','campaign_runs','campaign_contacts'
    ])
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I_authenticated_read ON public.%I; '
      'CREATE POLICY %I_authenticated_read ON public.%I FOR SELECT TO authenticated USING (true);',
      t, t, t, t
    );
  END LOOP;
END$$;

-- service_role bypassa RLS automaticamente; n8n usa service_role no header.
-- Nenhuma policy de write para authenticated/anon — qualquer escrita exige service_role.
```

---

## 6. Labels e custom_attributes Chatwoot

Estado atual (do `api-discovery.md`): 0 labels, 0 custom_attribute_definitions. Tudo abaixo é a criar.

### 6.1 Labels (todas escopo `conversation` salvo indicação)

| Categoria | Nome | Cor sugerida | Escopo | Observação |
|---|---|---|---|---|
| origem | `origem_whatsapp` | `#1F93FF` | conversation | aplicada na 1ª mensagem |
| origem | `origem_meta_ads` | `#1F93FF` | conversation | |
| origem | `origem_site` | `#1F93FF` | conversation | |
| origem | `origem_desconhecida` | `#9E9E9E` | conversation | |
| origem | `origem_lista_promocao` | `#7C4DFF` | conversation | campanha |
| origem | `origem_retorno_antigo` | `#7C4DFF` | conversation | campanha |
| automação | `ai_after_hours` | `#FF9800` | conversation | |
| automação | `ai_campaign` | `#7C4DFF` | conversation | |
| automação | `ai_disabled` | `#9E9E9E` | conversation | |
| automação | `human_locked` | `#F44336` | conversation | |
| automação | `handoff_pending` | `#FFC107` | conversation | |
| automação | `handoff_done` | `#4CAF50` | conversation | |
| receptivo | `fora_expediente` | `#FF9800` | conversation | |
| receptivo | `qualificacao_rapida` | `#FFC107` | conversation | |
| receptivo | `callback_solicitado` | `#FFC107` | conversation | |
| receptivo | `callback_horario_coletado` | `#4CAF50` | conversation | |
| receptivo | `aguardando_atendente` | `#FFC107` | conversation | |
| receptivo | `atendimento_humano` | `#F44336` | conversation | aplicada por IGOR_06 |
| campanha | `promo_eligivel` | `#7C4DFF` | conversation | |
| campanha | `promo_disparo` | `#7C4DFF` | conversation | |
| campanha | `promo_enviada` | `#7C4DFF` | conversation | |
| campanha | `promo_entregue` | `#7C4DFF` | conversation | |
| campanha | `promo_respondeu` | `#7C4DFF` | conversation | |
| campanha | `promo_interessado` | `#4CAF50` | conversation | |
| campanha | `promo_duvida` | `#FFC107` | conversation | |
| campanha | `promo_nao_interessado` | `#9E9E9E` | conversation | |
| campanha | `promo_optout` | `#F44336` | conversation | |
| campanha | `promo_handoff` | `#4CAF50` | conversation | |
| segurança | `optout` | `#F44336` | conversation | |
| segurança | `documento_clinico` | `#F44336` | conversation | |
| segurança | `imagem_sensivel` | `#F44336` | conversation | |
| segurança | `dados_sensiveis` | `#F44336` | conversation | |
| segurança | `compliance_humano` | `#F44336` | conversation | |
| segurança | `erro_envio` | `#F44336` | conversation | |

Total: **33 labels**. Criar via `POST /api/v1/accounts/{id}/labels` na Fase 3.

### 6.2 Custom attribute definitions

Escopo `conversation_attribute`:

| Key | Tipo | display_type | Opções |
|---|---|---|---|
| `automation_state` | list | dropdown | new, ai_after_hours, ai_campaign, handoff_pending, human_assigned, opt_out, compliance_hold |
| `owner_flow` | list | dropdown | after_hours, campaign_promo, manual |
| `ai_enabled` | checkbox | checkbox | — |
| `lead_status` | text | text | — |
| `callback_period` | text | text | — |
| `handoff_reason` | list | dropdown | after_hours_callback, documento_clinico_sensivel, imagem_sensivel, promo_interested, promo_doubt, human_request, mídia_desconhecida |
| `campaign_run_id` | text | text | UUID da campanha; nome `campaign_id` é reservado pelo Chatwoot |
| `campaign_offer` | text | text | — |
| `regular_price` | text | text | — |
| `promo_price` | text | text | — |
| `campaign_status` | list | dropdown | queued, sent, replied, interested, handoff_done, opt_out |

Escopo `contact_attribute`:

| Key | Tipo | display_type | Opções |
|---|---|---|---|
| `do_not_contact` | checkbox | checkbox | — |
| `consent_marketing` | checkbox | checkbox | — |
| `optout_at` | date | date | — |
| `external_lead_id` | text | text | (UUID do `leads` no Supabase) |

Total: **15 custom attribute definitions**. Criar via `POST /api/v1/accounts/{id}/custom_attribute_definitions` na Fase 3.

---

## 7. Credentials n8n

Criar manualmente no n8n com estes nomes canônicos antes de importar JSONs.

| Nome canônico | Tipo n8n | Escopo | Observação |
|---|---|---|---|
| `igor_supabase_service` | HTTP Header Auth | `apikey: <SERVICE_ROLE>` + `Authorization: Bearer <SERVICE_ROLE>` | Headers idênticos; usados por todos os nós HTTP Supabase |
| `igor_supabase_postgres` | Postgres | host/port/db do Supabase | usar **Session Pooler** (`pgbouncer`), porta 5432, **não** o pooler default do `.env` |
| `igor_chatwoot_api` | HTTP Header Auth | `api_access_token: <CHATWOOT_API_TOKEN>` | |
| `igor_evolution_api` | HTTP Header Auth | `apikey: <EVOLUTION_API_KEY>` | |
| `igor_openai` | OpenAI API | key | usado por IGOR_02 (transcrição), IGOR_03, IGOR_13 |
| `igor_gemini` | Google Gemini | key | fallback / áudio |
| `igor_redis_embedded` | Redis | embarcado no n8n via Portainer | **P2 — confirmar nome real** com o usuário |
| `igor_langsmith` | HTTP Header Auth | `Authorization: Bearer <LANGCHAIN_API_KEY>` | opcional, somente se LangSmith for usado |

**Nenhuma chave hardcoded em JSON de workflow.** Os JSONs referenciam credentials pelo nome.

---

## 8. Fixtures

Criar em `fixtures/` antes da Fase 6.

| Arquivo | Evento | Conteúdo mínimo |
|---|---|---|
| `evolution-text.json` | inbound texto | payload Evolution `MESSAGES_UPSERT` com `messageType:'conversation'`, texto puro |
| `evolution-audio.json` | inbound áudio | `messageType:'audioMessage'`, `audioMessage.url`/`.base64` |
| `evolution-image.json` | inbound imagem | `messageType:'imageMessage'`, com e sem `caption` (duas variantes) |
| `evolution-document.json` | inbound pdf | `messageType:'documentMessage'`, mimeType `application/pdf`, exemplo clínico e exemplo neutro (duas variantes) |
| `evolution-fromme.json` | mensagem enviada por nós | `key.fromMe: true` |
| `evolution-group.json` | mensagem de grupo | deve ser ignorada (`groupsIgnore=true`) |
| `chatwoot-message-created-incoming.json` | Chatwoot webhook | lead respondeu pelo Chatwoot |
| `chatwoot-message-created-outgoing-bot.json` | Chatwoot webhook | mensagem do agent_bot (Igor) — não trava |
| `chatwoot-message-created-outgoing-human.json` | Chatwoot webhook | atendente humana respondeu — TRAVA IA |
| `campaign-reply-text.json` | resposta de campanha | texto "Tenho interesse" |
| `campaign-reply-optout.json` | opt-out de campanha | texto "pare de me mandar" |
| `campaign-reply-price.json` | dúvida de preço | "quanto fica?" |
| `campaign-reply-sensitive.json` | mídia sensível em campanha | imagem de comprovante |

Cada fixture acompanhada de `<nome>.expected.md` com o resultado esperado (estado final em Supabase, labels aplicadas, mensagem enviada vs `dry_run_send`).

---

## 9. Scripts

Em `scripts/` (todos com `--dry-run` por padrão, leitura de `ALLOW_PRODUCTION_MUTATIONS`):

| Script | Função |
|---|---|
| `validate-env.sh` | Valida presença de keys obrigatórias; gera `reports/env-validation.md`. **Já implementado.** |
| `mask-secrets.sh` | Filtra stdin→stdout mascarando segredos. **Já implementado.** |
| `discover.sh` | Descoberta read-only HTTP nos 4 serviços; grava raw em `scripts/reports/raw/`. **Já implementado.** |
| `import-workflows.sh` | Importa JSONs de `n8n/workflows/` via API n8n (dry-run mostra payloads). |
| `export-workflows.sh` | Exporta workflows ativos para `n8n/backups/<timestamp>/`. |
| `apply-supabase-sql.sh` | **Não implementar** — migrations são manuais no SQL Editor. |
| `seed-chatwoot.sh` | Cria labels e custom_attribute_definitions via API Chatwoot. Idempotente. |
| `bind-evolution-chatwoot.sh` | Bind da instância `convert-teste` ao inbox do Chatwoot (via `POST /chatwoot/set/{instance}`). Exige `ALLOW_PRODUCTION_MUTATIONS=true`. |
| `set-evolution-webhook.sh` | Configura webhook da Evolution apontando para `IGOR_01`. Exige `ALLOW_PRODUCTION_MUTATIONS=true`. |
| `smoke-tests.sh` | Roda os 10 smoke tests obrigatórios contra `convert-teste`. |

---

## 10. Plano de testes (Fase 6)

Os 10 smoke tests obrigatórios do AGENTS.md, mapeados:

| # | Input | Asserção |
|---|---|---|
| 1 | `evolution-fromme.json` | `events('inbound_blocked','from_me')`; nenhuma chamada LLM; nenhuma mensagem enviada |
| 2 | `evolution-text.json` enviado às 10:00 BRT | `events('inbound_blocked','within_hours')`; nenhuma resposta |
| 3 | `evolution-text.json` enviado às 21:00 BRT | `conversations.state = ai_after_hours`; label `fora_expediente`; resposta gerada |
| 4 | `evolution-text.json` em conversa com `human_locked=true` | bloqueio; nenhuma resposta |
| 5 | `evolution-text.json` com texto "pare" | `contacts.do_not_contact=true`; label `optout`; nenhuma resposta |
| 6 | `evolution-audio.json` | transcrição populada em `messages.normalized_text`; agente usa o texto |
| 7 | `evolution-document.json` (variante clínica) | `events('compliance_handoff')`; chamada de `IGOR_05`; label `documento_clinico` |
| 8 | `IGOR_10` com lead `do_not_contact=true` | `campaign_contacts.status='skipped'`; nenhum envio |
| 9 | `IGOR_10` com `IGOR_DRY_RUN=true` | `events('dry_run_send')`; **sem** chamada à Evolution |
| 10 | `campaign-reply-text.json` (interesse) | `campaign_contacts.status='handoff_pending'`; chamada `IGOR_05`; nota privada criada |

Cada teste lê o estado de Supabase antes/depois e compara com `expected.md` do fixture.

---

## 11. Kill switches e feature flags

- `settings.ai_enabled_global` (boolean) — checado no nó 1 de cada workflow IGOR. False = silêncio total.
- `settings.workflows_enabled.IGOR_XX` (boolean por workflow) — granularidade fina.
- `settings.holiday_policy` (string) — `block` (default), `degraded`, `passthrough`. P1.
- Env vars (lidas no nó inicial via Supabase ou direto):
  - `IGOR_DRY_RUN`, `ALLOW_REAL_WHATSAPP_SEND`, `ALLOW_PRODUCTION_MUTATIONS`.

Todos os workflows IGOR começam com o seed `workflows_enabled.IGOR_XX = false` na migration 003 — eles **não vão executar** até o usuário ligar manualmente no SQL Editor.

---

## 12. Riscos e mitigações

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| 1 | Pooler Postgres do `.env` quebrado (senha contém `@`) | alta | alto | Usar Session Pooler, encodar senha; ou conexão direta na porta 5432 |
| 2 | DNS local não resolve domínio Supabase | média | médio | Em produção (VPS) o DNS é normal; só afeta scripts locais |
| 3 | Race condition no batching Redis (msgs <500ms) | média | alto | Lock `SET NX EX` por `phone`; mensagens subsequentes vão para `RPUSH igor:batch:{phone}` |
| 4 | Loop entre Evolution echo e Chatwoot integration | média | alto | IGOR_06 só trava se `sender.type === 'user'`; ignora `agent_bot` e `outgoing` do próprio Igor |
| 5 | RLS bloqueando service_role acidentalmente | baixa | alto | Não usar `FORCE ROW LEVEL SECURITY`; policies só restringem authenticated/anon |
| 6 | Custos LLM em loop (Alice respondendo a si mesma) | baixa | médio | IGOR_01 filtra `fromMe`; IGOR_06 não responde, só registra |
| 7 | Opt-out detectado erroneamente pela LLM | média | alto | Keyword-list determinística + LLM apenas confirma; nunca o inverso |
| 8 | Operador mexer na instância `dr.igor` (produção 13k+ msgs) por engano | média | crítico | Scripts validam `EVOLUTION_INSTANCE_NAME==='convert-teste'` antes de qualquer mutação |
| 9 | Workflow ativado por engano sem terminar de configurar | média | médio | `workflows_enabled.IGOR_XX = false` por padrão na migration; ativação manual no SQL |
| 10 | Token Chatwoot é de admin (acesso total) | alta | alto | Trocar por token de agent específico após Fase 3; documentar no RUNBOOK |
| 11 | LangSmith ativo sem key — tracing falha silencioso | baixa | baixo | Setar `LANGCHAIN_TRACING_V2=false` quando key vazia (já contemplado no `.env.example`) |
| 12 | Mídia armazenada em base64 inflando `messages` | média | médio | Nunca persistir base64 — só `media_url` + summary. P1 sobre Storage |

---

## 13. Decisões pendentes (P1)

1. ~~**Modelo de transcrição de áudio**~~ **Decidido em 2026-05-14**: `gpt-4o-transcribe` da OpenAI (id da API). Preço: $0.006/min. Substitui Whisper-1 (legado). Usado em `IGOR_02_Media_Normalizer`.
2. ~~**Política de feriados**~~ **Decidido em 2026-05-14**: feriado = mesmo comportamento de fora-de-expediente. Lista manual em `settings.holidays` (array de `YYYY-MM-DD`). Quando hoje ∈ `holidays`, IGOR_01 trata como after-hours; IGOR_10 não dispara campanha.
3. ~~**Fonte canônica de lista de campanha**~~ **Decidido em 2026-05-14**: CSVs do Kommo em `lista-leads/` (gitignored), carga inicial única via `scripts/import-kommo-csv.sh`. Detalhes em §2 IGOR_09.
4. ~~**Threshold de opt-out**~~ **Decidido em 2026-05-14**: regra simples. Tradução: se muita gente em sequência pedir para parar, a campanha auto-pausa para a gente não queimar a lista inteira. **Default**: 3 opt-outs nos últimos 20 envios → `IGOR_10` define `campaign_runs.status='pausado'` e gera evento `campaign_auto_paused`. Você reativa manualmente quando quiser.
5. ~~**Armazenamento de mídia**~~ **Decidido em 2026-05-14**: mídia vai para o **MinIO S3 já conectado à Evolution API**. `messages.media_url` guarda a URL do objeto S3 (sem copiar para Supabase Storage). Transcrição/descrição ficam em `messages.normalized_text` e `messages.media_summary`.
6. **Texto exato do consentimento PT-BR** (LGPD-friendly) para campanha. *Pode ficar como rodapé opcional na mensagem de campanha ou nota privada interna; não é bloqueante.*
7. ~~**LangSmith project ID e key**~~ **Decidido em 2026-05-14**: fora de escopo da v1. Reavaliar em v2 quando precisar de tracing/evals em produção. `LANGCHAIN_TRACING_V2` permanece `false`.
8. ~~**Política `holiday_policy`**~~ **Decidido em 2026-05-14**: feriado é tratado como after-hours (ver P1 #2 acima). Não há `holiday_policy` separada.
9. ~~**Mensagem final do handoff**~~ **Decididos em 2026-05-14**. 4 caminhos cobertos com defaults razoáveis (você pode ajustar depois em produção):

   **9.1 Handoff after-hours → callback (Opção A aprovada):**
   ```
   {nome}, perfeito. Já anotei tudo aqui e a equipe do Dr. Igor vai
   te chamar no período que você indicou ({callback_period}) para
   seguir o atendimento e ver os próximos passos. Até logo!
   ```
   Fallback se `{nome}` não coletado: substituir por `Obrigada`. Se `{callback_period}` não coletado: substituir por `o quanto antes`.

   **9.2 Handoff por compliance (documento clínico / imagem sensível):**
   ```
   Obrigada por compartilhar isso comigo. Para te orientar com a
   atenção que esse tipo de informação merece, vou pedir para a
   equipe do Dr. Igor analisar e te retornar pessoalmente. Aguarde,
   por favor — em breve alguém entra em contato.
   ```
   Sem `{nome}`, sem `{callback_period}`. Curto, sóbrio, sem opinião clínica.

   **9.3 Handoff por interesse em campanha:**
   ```
   Que ótimo, {nome}! Vou passar para a equipe do Dr. Igor para
   verificarmos os horários disponíveis e seguir com o agendamento.
   Eles entram em contato com você {callback_period} para alinhar
   o melhor horário. Até já!
   ```
   Fallback `{nome}` → "Que ótimo!". Fallback `{callback_period}` → "ainda hoje".

   **9.4 Confirmação de opt-out:**
   ```
   Tudo bem, {nome}. Vou parar de te enviar mensagens por aqui.
   Se um dia mudar de ideia ou quiser falar com a equipe do Dr.
   Igor, é só responder esta conversa. Cuide-se!
   ```
   Fallback `{nome}` → "Tudo bem".
10. ~~**Modelo LLM para Alice**~~ **Decidido em 2026-05-14**: `gpt-5.4-mini` (OpenAI). Usado em `IGOR_03_Agent_AfterHours` e `IGOR_13_Agent_Campaign`. Credential n8n: `igor_openai`.

---

## 14. Informações faltantes (P2)

1. `CHATWOOT_INBOX_ID`, `CHATWOOT_HUMAN_TEAM_ID`, `CHATWOOT_HUMAN_ASSIGNEE_ID`, `CHATWOOT_HUMAN_AGENT_NAME` — só são conhecidos após Fase 3 criar inbox/team/agent. `seed-chatwoot.sh` vai imprimi-los para preenchimento.
2. Nome da credential Redis embarcada já configurada no n8n via Portainer.
3. Número de WhatsApp de teste autorizado (o `TEST_WHATSAPP_NUMBER` no `.env` está SET — confirmar com o operador que é número próprio).
4. Texto do `support_email` do Chatwoot (atualmente `alma.lancamentos@gmail.com`) — manter ou trocar para um email da clínica?
5. Foto de perfil do agent_bot Alice no Chatwoot (opcional, melhora UX dos atendentes humanos).

---

## 15. Critérios para avançar à Fase 2 (Supabase)

Antes de aplicar `001..005` no SQL Editor, este IMPLEMENTATION_PLAN.md precisa receber **revisão explícita do usuário** nos pontos:

- [ ] DDL das 10 tabelas (especialmente colunas, FKs, CHECKs de estados).
- [ ] Lista de estados em `conversations.state`, `leads.status`, `campaign_contacts.status` — está completa?
- [ ] Política RLS proposta (RLS on, sem FORCE, leitura authenticated, escrita só service_role) — concorda?
- [ ] Seed da `settings` (`workflows_enabled.*` todas false, lista de palavras-chave opt-out PT-BR, etc.) — concorda?
- [ ] Lista de 33 labels e 15 custom_attribute_definitions — adicionar/remover algo?
- [ ] Lista de credentials n8n a criar.
- [ ] Decisões P1 — pelo menos as 4 primeiras (modelo de transcrição, política de feriados, fonte de lista de campanha, threshold opt-out) precisam ser decididas antes de IGOR_02/IGOR_10 serem construídos.

Quando estes 7 pontos estiverem aprovados, a próxima rodada gera os 5 arquivos SQL prontos para colar no SQL Editor, mais o `seed-chatwoot.sh` e o `import-workflows.sh`.
