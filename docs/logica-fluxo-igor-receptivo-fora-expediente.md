# Instituto Dr. Igor - Lógica do Fluxo Receptivo Fora de Expediente

> ⚠️ **Status de implementação**: as **regras de negócio** (seções 1–8) seguem válidas. **Os nomes de workflow citados nas seções 9+** (`IGOR_01_Inbound_AfterHours`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_05_Finalize_Handoff`, `IGOR_06_*`, `IGOR_AUX_*`) **foram arquivados** no refator 2026-05-18. A topologia atual consolida tudo em `IGOR_Inbound` + `IGOR_Handoff` + `IGOR_Chatwoot_Logger`. Pra detalhes técnicos de implementação atual, leia `docs/ARCHITECTURE.md`. Pra inventário ao vivo, `tasks.md`.
>
> **Lição pós-incident 2026-05-18**: o gate "lead novo" via `journey_started_at IS NULL` é insuficiente em isolamento — pacientes existentes sem row em `conversations` foram falsamente identificados como leads novos. Veja seção 8 deste doc + AGENTS.md (defesa em profundidade).
>
> ---
>
> Este documento descreve a lógica do fluxo receptivo do Instituto Dr. Igor: como mensagens recebidas no WhatsApp fora do horário de expediente são processadas pela Evolution API, registradas no Chatwoot, orquestradas pelo n8n, persistidas no Supabase e conduzidas por um agente de IA até a coleta de um melhor horário/período para retorno humano.

---

## 1. Objetivo do Sistema

O fluxo receptivo fora de expediente tem um objetivo específico: **não deixar leads que chegam pelo WhatsApp fora do horário comercial sem atendimento inicial**.

Diferente do fluxo antigo do Instituto Dr. Igor, que conduzia praticamente toda a jornada até a intenção de agendamento, o novo fluxo deve ser mais curto e operacional. O agente atua como uma camada de acolhimento e triagem rápida, não como finalizador da venda.

### Objetivos principais

- Receber mensagens que chegam pelo WhatsApp quando a atendente humana não está disponível.
- Responder rapidamente com tom humanizado.
- Coletar dados mínimos para a equipe continuar no próximo expediente.
- Entender o objetivo principal do lead em poucas perguntas.
- Solicitar o melhor horário ou período para a atendente retornar.
- Fazer handoff para atendimento humano no Chatwoot.
- Desligar a IA após o handoff para evitar conflito com o atendimento humano.

### O que o fluxo NÃO faz

- Não agenda consulta diretamente.
- Não consulta disponibilidade real de agenda.
- Não faz anamnese completa.
- Não interpreta exames, imagens clínicas ou documentos médicos.
- Não prescreve, diagnostica ou dá orientação médica.
- Não insiste em venda quando o lead não quer seguir.
- Não continua respondendo depois que o atendimento humano assume.

---

## 2. Diferença Fundamental em Relação ao Fluxo Antigo

| | Fluxo antigo com Kommo | Novo fluxo fora de expediente |
|---|---|---|
| Canal/proxy | Kommo via WhatsApp Lite | Evolution API + Chatwoot |
| CRM principal | Kommo | Supabase + Chatwoot |
| Papel da IA | Conduzir quase toda a jornada comercial | Acolher, qualificar rapidamente e coletar horário de retorno |
| Etapa final da IA | Intenção de agendamento | Melhor horário/período para atendente chamar |
| Handoff | Mudança de pipeline no Kommo | Labels/custom attributes + assignment/team no Chatwoot + estado no Supabase |
| Fonte de verdade | Campos/pipeline Kommo | Supabase |
| Orquestração | Orquestrador LLM + subagentes | Router determinístico + agente com tools |

---

## 3. Stack Operacional

### Serviços

- **WhatsApp**: canal de origem das mensagens.
- **Evolution API**: conexão com WhatsApp e integração com Chatwoot.
- **Chatwoot**: inbox operacional, labels, custom attributes, notas privadas, atribuição humana.
- **n8n**: orquestração, agentes, tools, subworkflows, logs e regras determinísticas.
- **Supabase Cloud**: banco principal para contatos, leads, estados, mensagens, campanhas e eventos.
- **Redis**: batching/agrupamento de mensagens e locks temporários.
- **LangSmith**: tracing/evals, quando habilitado no n8n self-hosted.

### Ambiente

- n8n, Chatwoot e Evolution API rodam em containers via Portainer em VPS Ubuntu.
- Supabase roda na versão cloud.
- Os workflows serão importados via JSON no n8n, não via Docker Compose.

---

## 4. Horário de Funcionamento

O fluxo deve responder apenas fora do expediente humano.

### Configuração inicial sugerida

```text
Horário IA ativa: 18:30 até 07:30
Horário humano ativo: 07:30 até 18:30
Timezone: America/Sao_Paulo
```

Esses valores devem ficar em tabela de configuração no Supabase ou em variables/env vars do n8n, não hardcoded em prompts.

### Regra

```text
Mensagem chega
↓
Está fora do expediente humano?
├── SIM → avaliar se IA pode responder
└── NÃO → não responder; deixar no Chatwoot para humano
```

### Exceções

- Feriados.
- Finais de semana.
- Pausas internas da atendente.
- Plantões ou dias com atendimento estendido.
- Conversas marcadas como `human_locked` ou `ai_disabled`.

---

## 5. O Agente de Atendimento Fora de Expediente

Nome provisório: **Alice**.

### Papel

Alice é a assistente virtual do Instituto Dr. Igor. Ela atende o lead fora do expediente, acolhe a mensagem inicial e adianta informações básicas para que a atendente humana continue depois.

### Personalidade

- Natural e conversacional.
- Frases curtas, estilo WhatsApp.
- Uma pergunta por vez.
- Tom acolhedor, seguro e profissional.
- Não usa termos internos como workflow, lead_status, label, handoff, IA, automação ou prompt.
- Não força venda.
- Não promete resultado.

### Conduta obrigatória

- Informar que a equipe já encerrou o expediente quando fizer sentido.
- Ajudar de forma breve.
- Coletar nome, se ainda não houver.
- Entender objetivo principal do lead.
- Solicitar melhor horário/período para a atendente continuar.
- Após coletar horário/período, chamar `finalize_handoff` antes de enviar a mensagem final de transferência.
- Encerrar sua atuação após o handoff.

### Conduta proibida

- Diagnosticar.
- Prescrever.
- Interpretar exames.
- Solicitar dados sensíveis desnecessários.
- Fazer anamnese extensa.
- Simular disponibilidade real de agenda.
- Dizer que “marcou” consulta.
- Seguir respondendo após `ai_enabled = false`.

---

## 6. Dados Mínimos da Qualificação Rápida

O fluxo fora de expediente deve coletar apenas o necessário para a atendente continuar.

| Campo | Obrigatório? | Observação |
|---|---:|---|
| `nome` | Sim, se ainda não existir | Pode ser extraído da mensagem ou perguntado |
| `objetivo_principal` | Sim | Ex.: emagrecimento, performance, reposição hormonal, estética, saúde geral |
| `callback_preference` | Sim | Melhor horário/período para retorno |
| `callback_period` | Sim | Manhã, tarde, noite, horário específico |
| `cidade` | Opcional | Coletar apenas se surgir naturalmente ou se for necessário para atendimento |
| `canal_origem` | Automático | WhatsApp / Meta Ads / site / desconhecido |
| `observacoes` | Automático | Resumo curto para a atendente |

---

## 7. Estados do Fluxo

### `conversation_state`

| Estado | Significado |
|---|---|
| `new` | Conversa nova, ainda sem classificação |
| `after_hours_candidate` | Mensagem chegou fora do expediente e pode ser atendida pela IA |
| `ai_after_hours` | IA está conduzindo o atendimento inicial |
| `collecting_name` | IA precisa obter nome |
| `quick_qualification` | IA está entendendo objetivo principal |
| `collecting_callback_time` | IA está pedindo melhor horário/período para retorno |
| `handoff_pending` | IA já tem dados mínimos e deve transferir |
| `human_assigned` | Conversa atribuída ao atendimento humano |
| `human_locked` | IA proibida de responder porque humano assumiu |
| `closed` | Conversa finalizada |
| `opt_out` | Lead pediu para não receber mensagens/automação |
| `compliance_hold` | Caso sensível que exige humano |

### `lead_status`

| Status | Significado |
|---|---|
| `novo` | Lead recém-identificado |
| `em_atendimento_ia_fora_expediente` | IA está atendendo fora do expediente |
| `qualificacao_rapida` | Lead passou por triagem rápida |
| `callback_solicitado` | IA pediu horário de retorno |
| `callback_horario_coletado` | Lead informou melhor período/horário |
| `aguardando_atendente` | Handoff feito, aguardando humano |
| `humano_em_atendimento` | Atendente assumiu |
| `agendado` | Lead agendou depois pelo humano |
| `nao_interessado` | Lead não quis seguir |
| `opt_out` | Lead pediu remoção/não contato |

---

## 8. Roteamento Determinístico

A decisão sobre responder ou não responder não deve ficar com a LLM. O router do n8n deve decidir antes do agente.

### Regras em ordem de prioridade

```text
Mensagem recebida pela Evolution API
↓
Normalize Payload
↓
fromMe = true?
├── SIM → No Op
└── NÃO
    ↓
Telefone válido?
├── NÃO → log_event invalid_phone → FIM
└── SIM
    ↓
Contato está em do_not_contact/opt_out?
├── SIM → No Op
└── NÃO
    ↓
Conversa tem ai_enabled = false ou human_locked = true?
├── SIM → Log message → No Op
└── NÃO
    ↓
Mensagem pertence a campanha ativa?
├── SIM → encaminhar para fluxo de campanha
└── NÃO
    ↓
Está fora do expediente?
├── SIM → fluxo after_hours
└── NÃO → registrar e deixar no Chatwoot para humano
```

### Observações

- `fromMe = true` nunca deve acionar agente.
- Se a conversa tiver label `ai_disabled`, `human_locked`, `handoff_done` ou `atendimento_humano`, a IA não responde.
- Se a mensagem for resposta de campanha ativa, ela deve ir para o fluxo de campanha, não para o fluxo fora de expediente.
- Se chegar documento clínico, imagem sensível ou pedido de orientação médica, o fluxo deve ir para `compliance_hold` e handoff.

---

## 9. Workflow Principal - `IGOR_01_Inbound_AfterHours`

### Tipo

Webhook Evolution API.

### Entrada

Evento de mensagem recebida pela Evolution API, preferencialmente `MESSAGES_UPSERT`.

### Sequência completa

```text
1. Webhook Evolution
   └── Recebe mensagem do WhatsApp

2. Normalize Payload
   └── Extrai phone, msgId, fromMe, text, messageType, timestamp,
       chatwootConversationId, chatwootInboxId, instance, raw_payload

3. IF fromMe
   ├── true → No Op
   └── false → continua

4. Normalize Phone
   └── Normaliza telefone para padrão 55DDDNNNNNNNNN

5. Validate Phone
   ├── inválido → log_event invalid_phone → FIM
   └── válido → continua

6. Media Normalizer
   └── Texto, áudio, imagem e documento convergem em `normalized_text`

7. Redis Batching
   └── Agrupa mensagens por telefone/conversation_id durante janela curta

8. Persist User Message
   └── Salva mensagem em `messages` ou `ia_messages`

9. Lookup Conversation State
   └── Busca contato, conversa, estado, labels, opt_out e ai_enabled no Supabase

10. Deterministic Router
   ├── human_locked / ai_disabled → No Op
   ├── opt_out → No Op
   ├── campaign_active → chamar fluxo campanha
   ├── inside_business_hours → No Op / humano
   └── outside_business_hours → Agent After Hours

11. Agent After Hours
   └── Responde com tools conectadas

12. Send Message
   └── Envia resposta pelo canal configurado

13. Persist Assistant Message
   └── Salva mensagem da IA

14. Tracing/Evals
   └── Envia metadata para LangSmith quando habilitado
```

---

## 10. Processamento de Mídia

O fluxo deve usar um subworkflow único para padronizar mídia antes de qualquer agente.

### Subworkflow: `IGOR_02_Media_Normalizer`

#### Entrada

```json
{
  "raw_payload": {},
  "source": "evolution",
  "instance": "dr_igor",
  "chatwoot_conversation_id": "...",
  "chatwoot_inbox_id": "..."
}
```

#### Saída

```json
{
  "phone": "55...",
  "msg_id": "...",
  "from_me": false,
  "message_type": "text|audio|image|document|unknown",
  "text": "texto final para o agente",
  "media_summary": "resumo curto da mídia",
  "safety_flags": [],
  "should_handoff": false,
  "handoff_reason": null
}
```

### Tratamento por tipo

| Tipo | Tratamento |
|---|---|
| Texto | Usar texto diretamente |
| Áudio | Baixar mídia/base64 e transcrever |
| Imagem com legenda | Usar legenda + classificar imagem |
| Imagem sem legenda | Gerar descrição curta e flags de segurança |
| Documento PDF | Classificar tipo; se clínico/sensível, handoff |
| Documento não PDF | Registrar envio e encaminhar se relevante |
| Unknown | Logar e seguir rota conservadora |

### Regra de segurança para mídia

Se imagem/documento parecer conter exame, laudo, prescrição, corpo, antes/depois sensível ou informação clínica, o agente não interpreta. Ele deve responder apenas que a equipe irá analisar e transferir para humano.

---

## 11. Batching de Mensagens - Redis

Quando o lead envia várias mensagens seguidas, o sistema deve aguardar uma janela curta para processar tudo junto.

### Janela sugerida

```text
10 segundos
```

### Chave Redis

```text
igor:after_hours:batch:{phone}
```

### Payload de cada item

```json
{
  "msg_id": "...",
  "phone": "55...",
  "conversation_id": "...",
  "message_type": "audio",
  "text": "transcrição ou texto final",
  "media_summary": "",
  "safety_flags": [],
  "should_handoff": false,
  "created_at": "..."
}
```

### Comportamento

```text
Msg 1 → Redis PUSH → Wait 10s
Msg 2 → Redis PUSH → timer em andamento
Msg 3 → Redis PUSH → timer em andamento
Timer expira → Redis GET ALL → Parse → IF Last Message → Merge → Processar
```

A deduplicação deve usar `msg_id`, não o texto da mensagem.

---

## 12. Jornada Conversacional

### 12.1 Lead sem nome

```text
Lead: Oi, queria saber sobre consulta

Alice: Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.

A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.

Qual seu nome?
```

### 12.2 Lead com nome identificado

```text
Alice: Perfeito, Ana.

Pra eu deixar tudo certinho para a equipe, o que você está buscando hoje com o Dr. Igor?
```

### 12.3 Lead informa objetivo

```text
Lead: Quero emagrecer e entender se ele acompanha com exames.

Alice: Entendi. O Dr. Igor trabalha com acompanhamento individualizado e a equipe consegue te explicar os próximos passos certinho.

Qual o melhor período para a atendente te chamar: manhã ou tarde?
```

### 12.4 Lead informa horário/período

Antes de enviar a resposta final, o agente deve chamar `finalize_handoff`.

```text
Lead: Pode ser amanhã de manhã.

[Tool finalize_handoff executada]

Alice: Combinado. Deixei registrado para a equipe te chamar amanhã de manhã pelo WhatsApp e continuar seu atendimento.
```

---

## 13. Condicionais Conversacionais

### Lead pergunta valor

O agente pode informar o valor vigente se estiver configurado e autorizado.

```text
Lead: Qual o valor?

Alice: O primeiro atendimento hoje é informado pela equipe conforme a condição vigente. Posso deixar registrado para a atendente te chamar e passar os detalhes certinhos.

Qual melhor período para ela falar com você?
```

Se a política comercial permitir informar preço:

```text
Alice: O primeiro atendimento costuma ser R$ 800,00. A equipe confirma as condições atualizadas e formas de pagamento com você.

Qual melhor período para ela te chamar?
```

### Lead pede agendamento direto

```text
Lead: Quero agendar.

Alice: Perfeito. A equipe finaliza os horários disponíveis e próximos passos.

Qual o melhor período para a atendente te chamar amanhã?
```

### Lead pede humano

```text
Lead: Quero falar com alguém.

Alice: Claro. Vou deixar sua conversa encaminhada para a equipe te chamar assim que retornar o atendimento.

Qual o melhor período para falarem com você?
```

Se insistir ou houver urgência comercial, fazer handoff mesmo sem horário.

### Lead envia áudio

```text
[Áudio transcrito]
Lead: Estou procurando ajuda para emagrecer, mas tenho algumas dúvidas.

Alice: Entendi. Vou deixar isso registrado para a equipe.

Qual melhor período para a atendente te chamar amanhã: manhã ou tarde?
```

### Lead envia exame/documento clínico

```text
Lead: [envia PDF de exame]

Alice: Recebi o documento. Para sua segurança, a equipe do Dr. Igor precisa analisar isso diretamente.

Vou encaminhar sua conversa para atendimento humano e deixar registrado que você enviou o documento.
```

Nesse caso, `finalize_handoff` deve ser chamado com `handoff_reason = documento_clinico_sensivel`.

### Lead diz que não quer seguir

```text
Lead: Vou deixar para depois.

Alice: Tudo bem. Vou deixar seu contato registrado por aqui. Quando quiser retomar, é só chamar pelo WhatsApp.
```

Aplicar status `nao_interessado` ou `nurture`, conforme regra comercial.

---

## 14. Tools do Agente Fora de Expediente

O agente deve ter poucas tools, com contratos simples.

### 14.1 `get_lead_context`

**Quando:** Antes de responder, para recuperar dados do lead.

**Retorna:**

```json
{
  "contact": {},
  "conversation": {},
  "lead": {},
  "labels": [],
  "current_state": "ai_after_hours",
  "last_summary": ""
}
```

### 14.2 `update_lead_fields`

**Quando:** Sempre que nome, objetivo, cidade ou callback forem identificados.

**Campos permitidos:**

- `nome`
- `objetivo_principal`
- `cidade`
- `callback_preference`
- `callback_period`
- `observacoes`

### 14.3 `set_labels_merge`

**Quando:** Para aplicar labels no Chatwoot sem apagar labels existentes.

**Regra:** buscar labels atuais, mesclar e salvar a lista completa.

### 14.4 `create_private_note`

**Quando:** Antes ou durante o handoff.

**Conteúdo mínimo:**

```text
Lead atendido pela IA fora do expediente.
Nome:
Objetivo:
Melhor horário/período para contato:
Resumo:
Próxima ação:
```

### 14.5 `finalize_handoff`

**Quando:** Assim que houver dados mínimos ou quando houver motivo de compliance.

**Importante:** deve ser chamado antes de avisar o lead que a equipe vai assumir.

**Entrada via agente:**

```json
{
  "handoff_reason": "after_hours_callback",
  "summary": "...",
  "callback_period": "amanhã de manhã",
  "priority": "normal"
}
```

**Campos preenchidos pelo contexto determinístico:**

- `phone`
- `contact_id`
- `conversation_id`
- `chatwoot_conversation_id`
- `chatwoot_inbox_id`
- `source`
- `current_flow = after_hours`
- `team_id`
- `labels`

### 14.6 `log_event`

**Quando:** Em decisões importantes.

Eventos comuns:

- `after_hours_started`
- `after_hours_name_collected`
- `after_hours_objective_collected`
- `callback_collected`
- `handoff_complete`
- `compliance_handoff`
- `agent_error`

---

## 15. Handoff para Atendimento Humano

### Sequência obrigatória

```text
1. Coletar nome, objetivo e melhor período/horário, quando possível
2. Atualizar Supabase
3. Atualizar custom attributes do Chatwoot
4. Aplicar labels com merge
5. Criar private note com resumo
6. Atribuir conversa para time/atendente humana no Chatwoot
7. Definir ai_enabled = false
8. Definir human_locked = true
9. Registrar event handoff_complete
10. Enviar mensagem final para o lead
11. IA para de responder
```

### Labels aplicadas no handoff

```text
fora_expediente
qualificacao_rapida
callback_solicitado
callback_horario_coletado
handoff_done
ai_disabled
aguardando_atendente
```

### Custom attributes de conversa

```json
{
  "automation_state": "human_assigned",
  "owner_flow": "after_hours",
  "ai_enabled": false,
  "lead_status": "aguardando_atendente",
  "handoff_reason": "after_hours_callback",
  "callback_period": "amanhã de manhã"
}
```

### Mensagem interna para a atendente

```text
Lead atendido pela IA fora do expediente.

Nome: {nome}
Telefone: {phone}
Objetivo: {objetivo_principal}
Melhor período para retorno: {callback_period}
Resumo: {summary}

Próxima ação: chamar o lead no período informado e continuar o atendimento comercial.
```

---

## 16. Labels do Chatwoot

### Origem

- `origem_whatsapp`
- `origem_meta_ads`
- `origem_site`
- `origem_desconhecida`

### Automação

- `ai_after_hours`
- `ai_disabled`
- `human_locked`
- `handoff_pending`
- `handoff_done`

### Receptivo fora de expediente

- `fora_expediente`
- `qualificacao_rapida`
- `callback_solicitado`
- `callback_horario_coletado`
- `aguardando_atendente`

### Segurança/compliance

- `compliance_humano`
- `documento_clinico`
- `imagem_sensivel`
- `dados_sensiveis`
- `optout`

---

## 17. Banco de Dados - Supabase

### Tabelas principais

| Tabela | Propósito |
|---|---|
| `contacts` | Registro único do contato |
| `conversations` | Estado da conversa por Chatwoot conversation_id |
| `leads` | Dados comerciais do lead |
| `messages` | Histórico de mensagens normalizadas |
| `events` | Log universal do sistema |
| `settings` | Horários, nomes, IDs e configs |
| `conversation_summaries` | Resumos acumulados por conversa |

### Campos importantes em `conversations`

```text
id
contact_id
chatwoot_conversation_id
chatwoot_inbox_id
state
ai_enabled
human_locked
current_flow
last_message_at
last_ai_message_at
last_human_message_at
assigned_team_id
assigned_agent_id
```

### Campos importantes em `leads`

```text
id
contact_id
conversation_id
source
status
objective
city
callback_preference
callback_period
qualified_at
handoff_at
scheduled_at
```

---

## 18. Message Logger do Chatwoot

### Workflow: `IGOR_06_Chatwoot_Message_Logger`

Papel:

- Receber eventos do Chatwoot.
- Salvar mensagens humanas.
- Atualizar `last_human_message_at`.
- Se humano respondeu, definir `ai_enabled = false` e `human_locked = true`.
- Evitar que a IA volte a responder depois da atendente.

### Regra crítica

Se qualquer mensagem de agente humano for detectada na conversa, a IA deve parar para aquela conversa, exceto se um operador reativar manualmente a automação.

---

## 19. Error Logger

### Workflow: `IGOR_07_Error_Logger`

Registra erros de todos os workflows em `events`.

Campos mínimos:

```text
workflow_name
node_name
error_message
phone
chatwoot_conversation_id
severity
payload_summary
created_at
```

---

## 20. Health Check

### Workflow: `IGOR_08_Health_Check`

Rodar a cada 5 ou 10 minutos.

### Sinais monitorados

- Evolution API conectada.
- Webhook Evolution ativo.
- Chatwoot API autenticada.
- Inbox existe.
- Labels críticas existem.
- Team/atendente existe.
- Supabase aceita inserts/selects.
- Redis sem batches presos.
- Conversas em `handoff_pending` há tempo demais.
- Conversas com `ai_enabled = true` e `human_locked = true`.
- Erros recentes no n8n.

### Alertas críticos

- `evolution_disconnected`
- `chatwoot_api_down`
- `supabase_write_failed`
- `redis_batch_stuck`
- `handoff_pending_stuck`
- `ai_responded_after_handoff`

---

## 21. Evals e Tracing

### Evals determinísticas

- `outside_business_hours_only`: IA só responde fora do expediente.
- `from_me_ignored`: mensagens enviadas por nós não acionam IA.
- `ai_disabled_respected`: IA não responde após handoff.
- `callback_collected`: callback salvo quando informado.
- `handoff_done`: handoff finalizado antes da mensagem final.
- `labels_applied`: labels obrigatórias aplicadas.
- `private_note_created`: nota interna criada no Chatwoot.

### Evals LLM-as-judge

- `tone_humanizado`
- `conciseness`
- `task_completion_after_hours`
- `medical_safety`
- `handoff_quality`
- `answer_relevance`

---

## 22. Métricas e KPIs

| Métrica | Fonte | Uso |
|---|---|---|
| Leads fora de expediente recebidos | `messages/events` | Volume de demanda |
| Leads respondidos pela IA | `messages` | Cobertura da automação |
| Callback coletado | `leads` | Efetividade da triagem |
| Handoffs concluídos | `events` | Conversão operacional |
| Tempo até primeira resposta | `messages` | Velocidade |
| IA respondeu após humano | eval/event | Falha crítica |
| Leads sem resposta no dia seguinte | `conversations` | Gargalo humano |
| Agendamentos derivados do fluxo | `leads` | Resultado comercial |

---

## 23. Exemplos de Conversa

### 23.1 Caminho feliz

```text
Lead: Oi, queria saber sobre consulta.

Alice: Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.
A equipe já encerrou o expediente, mas posso adiantar seu atendimento por aqui.
Qual seu nome?

Lead: Ana.

Alice: Perfeito, Ana. O que você está buscando hoje com o Dr. Igor?

Lead: Quero emagrecer e entender melhor o acompanhamento.

Alice: Entendi. Vou deixar isso registrado para a equipe continuar com você.
Qual o melhor período para a atendente te chamar amanhã: manhã ou tarde?

Lead: Manhã.

Alice: Combinado. Deixei registrado para a equipe te chamar amanhã de manhã pelo WhatsApp e continuar seu atendimento.
```

### 23.2 Lead pede humano direto

```text
Lead: Quero falar com atendente.

Alice: Claro. A equipe já encerrou o expediente, mas vou encaminhar sua conversa para retornarem assim que possível.
Qual o melhor período para te chamarem amanhã?
```

### 23.3 Documento clínico

```text
Lead: [envia exame]

Alice: Recebi o documento. Para sua segurança, a equipe precisa analisar diretamente.
Vou encaminhar sua conversa para atendimento humano e deixar registrado que você enviou o documento.
```

---

## 24. Arquitetura dos Workflows

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 01 | `IGOR_01_Inbound_AfterHours` | Webhook | Receber mensagens, rotear e acionar agente fora de expediente |
| 02 | `IGOR_02_Media_Normalizer` | Callable | Normalizar texto, áudio, imagem e documento |
| 03 | `IGOR_03-Agent-AfterHours` | Agent | Atendimento inicial fora de expediente |
| 04 | `IGOR_04-Tool-Labels-Attributes` | Callable | Labels e custom attributes no Chatwoot |
| 05 | `IGOR_05-Finalize-Handoff` | Callable | Transferir para atendimento humano |
| 06 | `IGOR_06-Chatwoot-Message-Logger` | Webhook | Registrar mensagens humanas e travar IA |
| 07 | `IGOR_07-Error-Logger` | Error Handler | Registrar erros |
| 08 | `IGOR_08-Health-Check` | Schedule | Monitorar serviços e estados |

### Dependências

```text
01-Inbound_AfterHours ──usa──→ 02-Media_Normalizer
                       ──usa──→ 03-Agent-AfterHours
                       ──usa──→ 04-Labels-Attributes
                       ──usa──→ 05-Finalize-Handoff
                       ──usa──→ 07-Error-Logger

03-Agent-AfterHours ──tools──→ get_lead_context
                      ──tools──→ update_lead_fields
                      ──tools──→ set_labels_merge
                      ──tools──→ create_private_note
                      ──tools──→ finalize_handoff
                      ──tools──→ log_event

06-Chatwoot-Logger ← Webhook Chatwoot message_created
08-Health-Check ← Schedule
```

---

## 25. Pendências de Configuração

- Nome da atendente humana.
- Horário final de expediente.
- Feriados e finais de semana.
- IDs reais do Chatwoot: `account_id`, `inbox_id`, `team_id`, `agent_id`.
- Labels definitivas no Chatwoot.
- Custom attributes definitivos.
- Política comercial sobre informar ou não valor no fluxo fora de expediente.
- Texto institucional oficial do Dr. Igor.

---

## 26. Glossário

| Termo | Significado |
|---|---|
| Lead | Pessoa interessada que entrou em contato |
| Handoff | Transferência da IA para atendimento humano |
| Callback | Melhor horário/período para a equipe retornar |
| Inbox | Caixa de entrada no Chatwoot |
| Label | Etiqueta aplicada na conversa do Chatwoot |
| Custom attribute | Campo personalizado no Chatwoot |
| Callable | Workflow auxiliar chamado por outro workflow |
| Batching | Agrupamento de mensagens em uma janela curta |
| Evolution API | Middleware de conexão com WhatsApp |
| Supabase | Banco de dados principal do fluxo |
| Redis | Sistema usado para fila temporária, batching e locks |
| `ai_enabled` | Flag que permite ou bloqueia resposta da IA |
| `human_locked` | Flag que indica atendimento humano ativo |
