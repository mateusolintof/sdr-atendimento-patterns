# Instituto Dr. Igor - Lógica do Fluxo do Agente Ativo de Promoção

> ⚠️ **Status de implementação (atualizado 2026-05-20)**: as **regras de negócio** (oferta, elegibilidade, opt-out, segmentação) seguem válidas. Mudanças arquiteturais importantes desde a redação original:
>
> 1. **NÃO existe "Alice Promotora" conversacional**. Quando lead responde à campanha, IGOR_Inbound detecta `block_reason='campaign_active'`, NÃO aciona IA. Atendente humana opera a partir daí. Tracking via `campaign_contacts.status = replied → converted` (quando atendente aplicar label `agendado`).
> 2. **Workflows planejados IGOR_10/IGOR_11/IGOR_12/IGOR_13 foram CANCELADOS**. Substituídos por `IGOR_Campaign_Sender` único (cron `*/7 * * * *` + 3 variantes anti-block + team assignment pós-send).
> 3. **`IGOR_09_Campaign_Importer` virou script Python local** (`scripts/import-kommo-csv.py`), não workflow n8n.
>
> Pra detalhes técnicos de implementação atual leia `docs/ARCHITECTURE.md`. Pra inventário ao vivo, `tasks.md`.
>
> ---
>
> Este documento descreve a lógica do fluxo ativo do Instituto Dr. Igor: como uma lista de leads qualificados anteriormente, mas que nunca agendaram, é importada, segmentada, personalizada e abordada via WhatsApp com uma oportunidade comercial. O fluxo usa Evolution API, Chatwoot, n8n, Supabase, Redis e subworkflows/tools para controle de disparo, resposta, opt-out, labels, custom attributes e handoff humano.

---

## 1. Objetivo do Sistema

O fluxo do agente ativo de promoção tem como objetivo **reengajar leads qualificados anteriormente que não concluíram agendamento**, oferecendo uma condição comercial específica e conduzindo os interessados para atendimento humano.

Este fluxo não é follow-up operacional de uma conversa em andamento. É uma campanha ativa, controlada, com segmentação, personalização, rastreamento e regras claras de opt-out.

### Oferta inicial prevista

```text
Primeiro atendimento:
De R$ 800,00 por R$ 600,00
Válido apenas este mês
```

A oferta deve ser configurável no Supabase, pois valor, validade, mídia e copy podem mudar.

### Objetivos principais

- Importar lista de leads qualificados que não agendaram.
- Validar se podem receber contato.
- Gerar abordagem personalizada com base no histórico real.
- Enviar mensagem de promoção pelo WhatsApp.
- Registrar envio, entrega, resposta e status da campanha.
- Responder dúvidas iniciais do lead.
- Coletar melhor horário/período para atendimento humano.
- Fazer handoff para a atendente quando houver interesse.
- Respeitar opt-out imediatamente.

### O que o fluxo NÃO faz

- Não dispara para leads sem base legítima de contato.
- Não envia mensagens para quem pediu para parar.
- Não envia para leads com atendimento humano ativo.
- Não finge que a mensagem foi escrita manualmente por uma pessoa.
- Não interpreta questões médicas.
- Não agenda diretamente.
- Não insiste após negativa clara.

---

## 2. Diferença Fundamental em Relação ao Receptivo Fora de Expediente

| | Receptivo fora de expediente | Agente ativo de promoção |
|---|---|---|
| Quem inicia | Lead envia mensagem | Sistema/IA inicia contato |
| Gatilho | Webhook Evolution | Importação + schedule/manual trigger |
| Objetivo | Não deixar lead sem resposta | Reativar lead qualificado sem agendamento |
| Mensagem inicial | Acolhimento | Oferta personalizada |
| Estado principal | `ai_after_hours` | `campaign_active` |
| Risco principal | IA responder após humano | Disparo indevido / opt-out / reputação WhatsApp |
| Final esperado | Melhor horário para atendente chamar | Interesse na oferta + handoff humano |

---

## 3. Stack Operacional

### Serviços

- **WhatsApp**: canal de envio e resposta.
- **Evolution API**: envio de mensagens e integração com Chatwoot.
- **Chatwoot**: inbox operacional, labels, notas privadas e handoff.
- **n8n**: importação, segmentação, geração de mensagens, envio, agente e tools.
- **Supabase Cloud**: banco de contatos, campanhas, estados, mensagens e eventos.
- **Redis**: rate limit, locks, batching e controle temporário.
- **LangSmith**: tracing/evals para qualidade da campanha e segurança.

---

## 4. Regras de Elegibilidade

Um lead só pode entrar na campanha se atender às condições abaixo.

### Critérios positivos

- Lead já teve contato anterior com o Instituto Dr. Igor.
- Lead foi qualificado anteriormente.
- Lead não agendou.
- Lead não está em atendimento humano ativo.
- Lead não tem `do_not_contact = true`.
- Lead não tem opt-out.
- Lead não recebeu campanha recente dentro da janela de bloqueio.
- Lead possui telefone válido.

### Critérios negativos

O lead deve ser excluído se:

- pediu para parar;
- está em conversa ativa com humano;
- já agendou;
- já converteu na mesma campanha;
- recebeu promoção recentemente;
- tem bloqueio manual;
- possui mensagem recente sensível/compliance;
- não existe contexto mínimo para personalização segura.

### Janela de bloqueio sugerida

```text
Não enviar nova campanha para o mesmo lead por pelo menos 30 dias.
```

---

## 5. Estados da Campanha

### `campaign_contact.status`

| Status | Significado |
|---|---|
| `queued` | Lead elegível aguardando disparo |
| `skipped` | Lead não elegível após validação |
| `scheduled` | Lead programado para envio |
| `sent` | Mensagem enviada |
| `delivered` | Entrega confirmada, se disponível |
| `replied` | Lead respondeu |
| `interested` | Lead demonstrou interesse |
| `not_interested` | Lead recusou |
| `handoff_pending` | Handoff deve ser executado |
| `handoff_done` | Conversa transferida para humano |
| `converted` | Lead agendou/converteu após campanha |
| `opt_out` | Lead pediu para parar |
| `send_failed` | Falha no envio |
| `blocked` | Bloqueio manual ou regra de segurança |

### `conversation_state`

| Estado | Significado |
|---|---|
| `campaign_active` | Lead recebeu campanha e a IA pode tratar resposta |
| `campaign_replied` | Lead respondeu à campanha |
| `campaign_interested` | Lead demonstrou interesse |
| `campaign_collecting_callback` | IA está pedindo melhor horário/período |
| `campaign_handoff_pending` | Handoff pendente |
| `campaign_handoff_done` | Handoff concluído |
| `campaign_opt_out` | Lead pediu remoção |
| `human_locked` | Humano assumiu, IA desligada |

---

## 6. Dados da Campanha

### Tabela `campaign_runs`

Campos sugeridos:

```text
id
name
offer_name
regular_price
promo_price
starts_at
ends_at
status
media_url
media_type
max_daily_sends
send_window_start
send_window_end
created_at
updated_at
```

### Tabela `campaign_contacts`

Campos sugeridos:

```text
id
campaign_id
contact_id
lead_id
phone
status
eligibility_reason
skip_reason
personalized_context
message_variant
sent_message
sent_at
delivered_at
replied_at
interest_classification
callback_period
handoff_at
optout_at
created_at
updated_at
```

---

## 7. Fluxo de Importação - `IGOR_10_Campaign_Importer`

### Tipo

Manual trigger, upload CSV, Google Sheets ou Supabase table.

### Entrada

Lista de contatos com pelo menos:

```text
nome
telefone
contexto opcional
origem opcional
observacao opcional
```

### Sequência completa

```text
1. Manual Trigger / Upload CSV / Google Sheets
   └── Recebe lista de contatos

2. Normalize Rows
   └── Padroniza nome, telefone, origem, observações

3. Normalize Phone
   └── Converte para padrão 55DDDNNNNNNNNN

4. Validate Phone
   ├── inválido → status skipped / invalid_phone
   └── válido → continua

5. Upsert Contact
   └── Cria ou atualiza contato no Supabase

6. Lookup Lead History
   └── Busca histórico do lead, status, agendamento, opt-out e conversas

7. Eligibility Check
   ├── não elegível → campaign_contacts.status = skipped
   └── elegível → campaign_contacts.status = queued

8. Enrich Campaign Context
   └── Gera resumo curto do histórico para personalização

9. Apply Chatwoot Labels
   └── label `promo_eligivel`, quando aplicável

10. Log Event
   └── campaign_imported / campaign_contact_queued / campaign_contact_skipped
```

### Saídas

- Leads elegíveis em `queued`.
- Leads não elegíveis em `skipped`, com motivo.
- Eventos registrados.

---

## 8. Fluxo de Disparo - `IGOR_11_Campaign_Dispatcher`

### Tipo

Schedule ou manual trigger.

### Janela de envio sugerida

```text
Segunda a sexta
09:00 até 17:30
```

A campanha ativa não deve enviar mensagens de madrugada ou em horários que possam gerar má percepção.

### Sequência completa

```text
1. Schedule / Manual Trigger
   └── Inicia lote da campanha

2. Load Active Campaign
   └── Busca campanha ativa em `campaign_runs`

3. Check Sending Window
   ├── fora da janela → FIM
   └── dentro da janela → continua

4. Rate Limit Check
   └── Verifica limite diário, limite por minuto e locks

5. Fetch Queued Contacts
   └── Busca próximos contatos com status queued

6. Revalidate Eligibility
   ├── opt_out / humano ativo / já agendado → skipped
   └── elegível → continua

7. Build Personalization Context
   └── Usa histórico real, resumo e motivo anterior

8. Generate Message
   └── Agente/callable gera mensagem personalizada dentro da política

9. Optional Human Review
   └── Se score de risco alto, segurar para revisão

10. Send WhatsApp
   └── Envia pela Evolution API

11. Update Campaign Contact
   └── status = sent, sent_at, sent_message

12. Update Chatwoot
   └── labels, custom attributes e private note, se necessário

13. Log Event
   └── campaign_message_sent
```

---

## 9. Mensagem de Campanha

### Regras de copy

A mensagem deve:

- ser curta;
- usar histórico real quando existir;
- mencionar a oportunidade de forma clara;
- não parecer lista genérica;
- não ser enganosa;
- oferecer opção simples de parar;
- conduzir para conversa, não para pressão.

### Template base

```text
Oi, {nome}. Tudo bem?

Vi aqui que você já tinha conversado com a gente sobre {objetivo/contexto}.

Este mês o Dr. Igor liberou uma condição especial para o primeiro atendimento: de R$ 800,00 por R$ 600,00.

Faz sentido eu ver com a equipe um horário para você aproveitar essa condição?

Se não quiser receber esse tipo de aviso, é só me falar que eu paro por aqui.
```

### Se a objeção anterior foi preço

```text
Oi, {nome}. Tudo bem?

Na última conversa, você comentou que queria se organizar melhor por causa do valor.

Por isso estou te avisando: este mês o primeiro atendimento com o Dr. Igor está com uma condição especial, de R$ 800,00 por R$ 600,00.

Quer que eu veja com a equipe um horário para você aproveitar essa condição?

Se não quiser receber esse tipo de aviso, é só me falar que eu paro por aqui.
```

### Se o contexto anterior foi emagrecimento

```text
Oi, {nome}. Tudo bem?

Vi aqui que você tinha conversado com a gente sobre acompanhamento para emagrecimento.

Este mês o Dr. Igor liberou uma condição especial para o primeiro atendimento: de R$ 800,00 por R$ 600,00.

Quer que eu peça para a equipe te chamar e ver um horário?

Se não quiser receber esse tipo de aviso, é só me falar que eu paro por aqui.
```

### Mensagem com mídia

Se houver imagem ou vídeo aprovado pela equipe:

```text
Oi, {nome}. Tudo bem?

Estou te enviando porque você já tinha conversado com a gente sobre {contexto}.

Este mês o primeiro atendimento com o Dr. Igor está com condição especial: de R$ 800,00 por R$ 600,00.

[imagem/vídeo aprovado]

Quer que eu veja com a equipe um horário para você?

Se não quiser receber esse tipo de aviso, é só me falar que eu paro por aqui.
```

---

## 10. Agente de Campanha

Nome provisório: **Alice - Campanha**.

### Papel

Alice conduz apenas respostas relacionadas à campanha. Ela esclarece a condição, identifica interesse, coleta melhor período para contato humano e transfere para atendimento.

### Personalidade

- Clara e leve.
- Comercial sem pressão.
- Respeitosa.
- Frases curtas.
- Uma pergunta por vez.
- Não usa jargões internos.

### O que pode fazer

- Explicar a condição da campanha.
- Reforçar que é por tempo limitado.
- Perguntar se o lead quer que a equipe veja um horário.
- Coletar melhor período para retorno.
- Responder dúvidas comerciais básicas.
- Registrar opt-out.
- Encaminhar para humano.

### O que não pode fazer

- Diagnosticar ou orientar clinicamente.
- Prometer resultados.
- Insistir após negativa.
- Inventar disponibilidade de agenda.
- Alterar o preço da campanha sem configuração.
- Continuar depois do handoff.

---

## 11. Fluxo de Resposta - `IGOR_12_Campaign_Inbound_Handler`

### Entrada

Mensagem recebida pela Evolution API, após o router identificar `campaign_active` ou `campaign_id` associado ao contato.

### Sequência completa

```text
1. Webhook Evolution
   └── Recebe resposta do lead

2. Normalize Payload
   └── Extrai phone, msgId, fromMe, messageType, chatwoot ids

3. IF fromMe
   ├── true → No Op
   └── false → continua

4. Media Normalizer
   └── Texto/áudio/imagem/documento → normalized_text

5. Redis Batching
   └── Agrupa múltiplas mensagens do lead

6. Lookup Campaign State
   └── Busca campaign_contact ativo pelo phone/conversation_id

7. Deterministic Guards
   ├── opt_out → processar opt-out
   ├── human_locked → No Op
   ├── ai_disabled → No Op
   └── campaign_active → Agent Campaign

8. Classify Response
   └── interessado / dúvida / preço / agenda / negativo / opt-out / humano / sensível

9. Agent Campaign
   └── Responde conforme intenção e usa tools

10. Handoff, se aplicável
   └── finalize_handoff antes de mensagem final

11. Persist Messages and Events
```

---

## 12. Classificação de Resposta

A classificação pode ser feita por node determinístico + LLM estruturado em subworkflow.

### Categorias

| Categoria | Exemplos | Ação |
|---|---|---|
| `interested` | “quero”, “tenho interesse”, “pode ver” | Pedir melhor horário/período ou handoff |
| `price_question` | “quanto fica?”, “é 600 mesmo?” | Confirmar valor configurado |
| `scheduling` | “tem horário amanhã?” | Coletar período e handoff |
| `doubt` | “como funciona?” | Explicar brevemente |
| `not_interested` | “não quero”, “agora não” | Encerrar sem insistir |
| `opt_out` | “pare”, “remover”, “não me mande” | Marcar do_not_contact |
| `human_request` | “quero falar com atendente” | Handoff imediato |
| `sensitive_medical` | exames, sintomas complexos, pedido médico | Compliance/handoff |
| `unknown` | resposta ambígua | Perguntar de forma simples |

---

## 13. Regras Conversacionais

### Lead interessado

```text
Lead: Tenho interesse.

Alice: Perfeito. Qual melhor período para a atendente te chamar: manhã ou tarde?
```

Depois de coletar o período:

```text
Lead: Tarde.

[Tool finalize_handoff executada]

Alice: Combinado. Vou deixar registrado para a equipe te chamar no período da tarde e ver os horários disponíveis para você aproveitar a condição.
```

### Lead pergunta preço

```text
Lead: O valor é quanto?

Alice: Este mês o primeiro atendimento está com condição especial: de R$ 800,00 por R$ 600,00.

Quer que eu peça para a equipe te chamar e ver um horário?
```

### Lead pergunta como funciona

```text
Lead: Como funciona o atendimento?

Alice: A equipe te explica os detalhes certinhos, mas o primeiro atendimento é uma consulta individual para entender seu objetivo e orientar os próximos passos.

A condição especial deste mês é de R$ 800,00 por R$ 600,00.

Quer que eu veja com a equipe um horário para você?
```

### Lead diz que não quer

```text
Lead: Não quero agora.

Alice: Tudo bem. Obrigada por responder. Não vou insistir por aqui.
```

Status: `not_interested`.

### Lead pede para parar

```text
Lead: Para de me mandar mensagem.

Alice: Claro. Vou registrar para você não receber mais esse tipo de mensagem.
```

Status: `opt_out`, `do_not_contact = true`.

### Lead pede humano

```text
Lead: Pode pedir para alguém me chamar.

Alice: Claro. Qual o melhor período para a atendente te chamar: manhã ou tarde?
```

Se não responder período, ainda pode fazer handoff com `callback_period = não informado`.

---

## 14. Opt-out

Opt-out é prioridade máxima.

### Frases que acionam opt-out

- “pare”
- “parar”
- “não me mande”
- “remover”
- “sair”
- “não quero receber”
- “cancele”

### Ações obrigatórias

```text
1. Definir contacts.do_not_contact = true
2. Definir contacts.consent_marketing = false, se existir
3. Atualizar campaign_contacts.status = opt_out
4. Aplicar label `promo_optout` e `optout`
5. Definir conversation_state = campaign_opt_out
6. Registrar event `campaign_opt_out`
7. Responder confirmação curta
8. Bloquear futuros disparos
```

---

## 15. Tools do Agente de Campanha

### 15.1 `get_campaign_context`

**Quando:** antes de responder a qualquer resposta de campanha.

Retorna:

```json
{
  "campaign": {},
  "campaign_contact": {},
  "contact": {},
  "lead": {},
  "last_summary": "",
  "labels": [],
  "conversation_state": "campaign_active"
}
```

### 15.2 `classify_campaign_response`

**Quando:** após a resposta do lead.

Retorna:

```json
{
  "intent": "interested|price_question|doubt|not_interested|opt_out|human_request|sensitive_medical|unknown",
  "confidence": 0.87,
  "reason": "..."
}
```

### 15.3 `update_campaign_contact`

Atualiza:

- `status`
- `interest_classification`
- `callback_period`
- `replied_at`
- `handoff_at`
- `optout_at`

### 15.4 `set_labels_merge`

Aplica labels sem apagar labels já existentes.

### 15.5 `update_custom_attributes`

Atualiza atributos de conversa/contato no Chatwoot.

### 15.6 `create_private_note`

Cria nota para a atendente com contexto da campanha.

### 15.7 `finalize_handoff`

**Quando:** lead interessado, pedido humano, agendamento ou caso sensível.

**Entrada via agente:**

```json
{
  "handoff_reason": "promo_interested",
  "summary": "Lead respondeu à campanha e demonstrou interesse.",
  "callback_period": "tarde",
  "priority": "high"
}
```

**Campos preenchidos pelo contexto determinístico:**

- `phone`
- `contact_id`
- `campaign_id`
- `campaign_contact_id`
- `chatwoot_conversation_id`
- `source = campaign_promo`
- `offer_name`
- `regular_price`
- `promo_price`
- `valid_until`

### 15.8 `register_opt_out`

Tool determinística para opt-out. O agente não decide tecnicamente como bloquear; ele só chama a tool.

### 15.9 `log_event`

Eventos:

- `campaign_imported`
- `campaign_contact_queued`
- `campaign_message_generated`
- `campaign_message_sent`
- `campaign_replied`
- `campaign_interested`
- `campaign_not_interested`
- `campaign_opt_out`
- `campaign_handoff_complete`
- `campaign_send_failed`

---

## 16. Handoff da Campanha

### Quando fazer handoff

- Lead demonstrou interesse.
- Lead pediu horário.
- Lead pediu humano.
- Lead enviou informação sensível.
- Lead quer aproveitar a condição.

### Sequência obrigatória

```text
1. Identificar interesse
2. Coletar melhor horário/período, se possível
3. Atualizar campaign_contacts
4. Atualizar lead_status
5. Aplicar labels
6. Atualizar custom attributes
7. Criar private note no Chatwoot
8. Atribuir conversa para time/atendente
9. Definir ai_enabled = false
10. Definir human_locked = true
11. Registrar event campaign_handoff_complete
12. Enviar mensagem final ao lead
13. IA para de responder
```

### Nota privada para atendente

```text
Lead respondeu à campanha promocional.

Campanha: {campaign_name}
Oferta: {offer_name}
Preço regular: R$ 800,00
Preço promocional: R$ 600,00
Validade: {valid_until}

Contexto anterior: {personalized_context}
Resposta do lead: {last_user_message}
Melhor período para contato: {callback_period}

Próxima ação: chamar o lead e verificar horários disponíveis.
```

---

## 17. Labels do Chatwoot

### Campanha

- `promo_eligivel`
- `promo_disparo`
- `promo_enviada`
- `promo_entregue`
- `promo_respondeu`
- `promo_interessado`
- `promo_duvida`
- `promo_nao_interessado`
- `promo_optout`
- `promo_handoff`

### Automação

- `ai_campaign`
- `ai_disabled`
- `human_locked`
- `handoff_pending`
- `handoff_done`

### Origem

- `origem_lista_promocao`
- `origem_retorno_antigo`
- `origem_whatsapp`

### Segurança

- `compliance_humano`
- `dados_sensiveis`
- `optout`
- `erro_envio`

---

## 18. Custom Attributes

### Conversation attributes

```json
{
  "owner_flow": "campaign_promo",
  "automation_state": "campaign_active",
  "ai_enabled": true,
  "campaign_id": "...",
  "campaign_offer": "Primeiro atendimento promocional",
  "regular_price": "800.00",
  "promo_price": "600.00",
  "campaign_status": "sent",
  "handoff_reason": null,
  "callback_period": null
}
```

### Contact attributes

```json
{
  "phone_normalized": "55...",
  "consent_marketing": true,
  "do_not_contact": false,
  "last_campaign_id": "...",
  "last_campaign_sent_at": "...",
  "last_campaign_status": "sent"
}
```

---

## 19. Rate Limit e Segurança de Disparo

### Regras sugeridas

```text
Máximo inicial: 20 contatos no primeiro dia
Depois: 50 contatos no segundo dia
Depois: 100 contatos no terceiro dia, se métricas estiverem saudáveis
```

### Limites operacionais

- Limite diário por campanha.
- Limite por minuto.
- Intervalo aleatório entre envios.
- Bloqueio por telefone se já enviado recentemente.
- Bloqueio se o Chatwoot tiver conversa aberta com humano.

### Sinais para pausar campanha

- Alta taxa de opt-out.
- Reclamações.
- Falhas de envio em massa.
- Evolution instável.
- Aumento de mensagens negativas.
- Conversas humanas acumuladas sem resposta.

---

## 20. Processamento de Mídia na Campanha

### Envio de mídia

A mídia promocional deve ser aprovada e armazenada com URL ou file reference.

Campos sugeridos em `campaign_runs`:

```text
media_type = image|video|none
media_url
media_caption
```

### Resposta com mídia do lead

Se o lead enviar imagem, áudio ou documento:

| Tipo | Ação |
|---|---|
| Áudio | Transcrever e classificar intenção |
| Imagem | Classificar de forma segura |
| Documento clínico | Handoff humano |
| Documento genérico | Registrar e avaliar necessidade |
| Comprovante/pagamento | Handoff humano imediato |

---

## 21. Message Logger do Chatwoot

### Workflow: `IGOR_06_Chatwoot_Message_Logger`

Papel:

- Registrar mensagens humanas.
- Detectar se atendente assumiu.
- Definir `ai_enabled = false`.
- Atualizar `human_locked = true`.
- Atualizar campanha para `handoff_done` quando humano responde.

---

## 22. Error Logger

### Workflow: `IGOR_07_Error_Logger`

Eventos de erro comuns:

- `campaign_import_failed`
- `campaign_send_failed`
- `campaign_generation_failed`
- `campaign_context_missing`
- `evolution_send_error`
- `chatwoot_update_error`
- `supabase_update_error`
- `optout_register_error`

---

## 23. Health Check

### Workflow: `IGOR_08_Health_Check`

Sinais monitorados:

- Evolution API conectada.
- Chatwoot API funcional.
- Supabase funcional.
- Redis sem locks presos.
- Campanhas com status ativo.
- Contatos `queued` travados.
- Mensagens `send_failed` acima do limite.
- Opt-outs registrados corretamente.
- Handoffs pendentes há tempo demais.
- Conversas com humano e `ai_enabled = true`.

### Alertas críticos

- `campaign_send_failed_spike`
- `campaign_optout_spike`
- `campaign_handoff_stuck`
- `ai_responded_after_human`
- `do_not_contact_violation`

---

## 24. Evals e Tracing

### Evals determinísticas

- `eligible_only`: campanha só enviou para leads elegíveis.
- `do_not_contact_respected`: nenhum envio para opt-out.
- `offer_exact`: preço regular e promocional corretos.
- `validity_exact`: validade da campanha correta.
- `human_locked_respected`: IA não respondeu após humano.
- `handoff_when_interested`: interessados foram transferidos.
- `optout_registered`: opt-out salvo e confirmado.

### Evals LLM-as-judge

- `personalization_quality`
- `sales_pitch_quality`
- `no_deceptive_language`
- `tone_appropriate`
- `optout_clarity`
- `medical_safety`
- `conciseness`

---

## 25. Métricas e KPIs

| Métrica | Fonte | Uso |
|---|---|---|
| Contatos importados | `campaign_contacts` | Volume da lista |
| Elegíveis | `campaign_contacts.status = queued` | Qualidade da base |
| Enviados | `status = sent` | Execução |
| Responderam | `status = replied` | Engajamento |
| Interessados | `status = interested` | Conversão intermediária |
| Handoffs | `status = handoff_done` | Conversão operacional |
| Agendados | `status = converted` / `leads.scheduled_at` | Resultado final |
| Opt-outs | `status = opt_out` | Saúde da campanha |
| Falhas de envio | `status = send_failed` | Saúde técnica |
| Tempo até resposta humana | `messages/events` | Operação da equipe |

---

## 26. Exemplos de Conversa

### 26.1 Lead interessado

```text
Alice: Oi, Ana. Tudo bem?

Vi aqui que você tinha conversado com a gente sobre acompanhamento para emagrecimento.

Este mês o Dr. Igor liberou uma condição especial para o primeiro atendimento: de R$ 800,00 por R$ 600,00.

Quer que eu peça para a equipe te chamar e ver um horário?

Se não quiser receber esse tipo de aviso, é só me falar que eu paro por aqui.

Ana: Quero sim.

Alice: Perfeito. Qual melhor período para a atendente te chamar: manhã ou tarde?

Ana: Tarde.

Alice: Combinado. Vou deixar registrado para a equipe te chamar no período da tarde e ver os horários disponíveis para você aproveitar a condição.
```

### 26.2 Lead pergunta preço

```text
Lead: Quanto está?

Alice: Este mês o primeiro atendimento está com condição especial: de R$ 800,00 por R$ 600,00.

Quer que eu peça para a equipe te chamar e ver um horário?
```

### 26.3 Lead não quer

```text
Lead: Agora não tenho interesse.

Alice: Tudo bem. Obrigada por responder. Não vou insistir por aqui.
```

### 26.4 Lead pede opt-out

```text
Lead: Não quero receber mensagens.

Alice: Claro. Vou registrar para você não receber mais esse tipo de mensagem.
```

### 26.5 Lead pede humano

```text
Lead: Uma pessoa pode falar comigo?

Alice: Claro. Qual o melhor período para a atendente te chamar: manhã ou tarde?
```

---

## 27. Arquitetura dos Workflows

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 09 | `IGOR_09-Campaign-Importer` | Manual/CSV/Sheets | Importar lista e validar elegibilidade |
| 10 | `IGOR_10-Campaign-Dispatcher` | Schedule/Manual | Enviar campanhas em lote controlado |
| 11 | `IGOR_11-Campaign-Message-Generator` | Callable | Gerar mensagem personalizada |
| 12 | `IGOR_12-Campaign-Inbound-Handler` | Webhook/Router | Tratar respostas de campanha |
| 13 | `IGOR_13-Agent-Campaign` | Agent | Conversar sobre a oferta e coletar callback |
| 04 | `IGOR_04-Tool-Labels-Attributes` | Callable | Labels e custom attributes no Chatwoot |
| 05 | `IGOR_05-Finalize-Handoff` | Callable | Transferir para atendimento humano |
| 02 | `IGOR_02-Media-Normalizer` | Callable | Normalizar texto, áudio, imagem e documento |
| 06 | `IGOR_06-Chatwoot-Message-Logger` | Webhook | Registrar mensagens humanas e travar IA |
| 07 | `IGOR_07-Error-Logger` | Error Handler | Registrar erros |
| 08 | `IGOR_08-Health-Check` | Schedule | Monitorar serviços e campanha |

### Dependências

```text
09-Campaign-Importer ──usa──→ 04-Labels-Attributes
                      ──usa──→ 07-Error-Logger

10-Campaign-Dispatcher ──usa──→ 11-Message-Generator
                       ──usa──→ 04-Labels-Attributes
                       ──usa──→ send_message
                       ──usa──→ log_event

12-Campaign-Inbound ──usa──→ 02-Media-Normalizer
                    ──usa──→ 13-Agent-Campaign
                    ──usa──→ 05-Finalize-Handoff
                    ──usa──→ 04-Labels-Attributes

13-Agent-Campaign ──tools──→ get_campaign_context
                   ──tools──→ classify_campaign_response
                   ──tools──→ update_campaign_contact
                   ──tools──→ register_opt_out
                   ──tools──→ finalize_handoff
                   ──tools──→ log_event
```

---

## 28. Pendências de Configuração

- Critérios finais de elegibilidade.
- Fonte da lista: CSV, Sheets ou Supabase.
- Texto final da oferta.
- Validade real da campanha.
- Mídia aprovada, se houver.
- Limites de envio por dia.
- Janela de disparo.
- Nomes/IDs do time humano no Chatwoot.
- Termos comerciais autorizados.
- Política de opt-out e consentimento.
- Métrica oficial de conversão: callback, agendamento ou pagamento.

---

## 29. Glossário

| Termo | Significado |
|---|---|
| Campanha ativa | Disparo controlado para leads antigos |
| Lead qualificado | Lead que já demonstrou potencial comercial anteriormente |
| Opt-out | Pedido para não receber mensagens |
| Handoff | Transferência da IA para atendimento humano |
| Callback | Melhor horário/período para a equipe retornar |
| Campaign run | Execução de uma campanha |
| Campaign contact | Lead dentro de uma campanha |
| Rate limit | Limite de envio para evitar abuso/risco |
| Inbox | Caixa de entrada no Chatwoot |
| Callable | Workflow auxiliar chamado por outro workflow |
| Batching | Agrupamento de mensagens antes de responder |
| Evolution API | Middleware de conexão com WhatsApp |
| Supabase | Banco de dados principal |
| Redis | Sistema usado para locks, filas e batching |
| `ai_enabled` | Flag que permite ou bloqueia resposta da IA |
| `human_locked` | Flag que indica atendimento humano ativo |
