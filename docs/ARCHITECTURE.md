# Instituto Dr. Igor — Lógica do Sistema (Source of Truth)

> Este documento descreve **como o sistema se comporta** — não como os workflows estão configurados node a node. Para isso, o n8n mostra os JSONs em tempo real. Aqui você lê a **jornada do lead**, as **decisões automáticas**, o **papel da Alice** em cada fluxo, e o que acontece em cada caso de borda.
>
> Versão: 2026-05-15 · Última atualização: rewrite narrativo + IGOR_11 deferido + IGOR_09-13 desenhados

---

## 1. Visão Geral do Sistema

O Instituto Dr. Igor opera **dois fluxos automatizados independentes** sobre o mesmo canal (WhatsApp):

- **Fluxo Receptivo Fora de Expediente** — lead manda mensagem espontânea após o horário comercial da equipe humana e a IA acolhe, qualifica em poucas perguntas e encaminha para a atendente continuar no próximo expediente.
- **Fluxo Campanha de Promoção Ativa** — uma vez por mês a equipe importa uma lista de leads antigos qualificados que nunca agendaram, e o sistema dispara uma oferta promocional via WhatsApp. Quem responde é tratado por uma versão "promotora" da IA até manifestar interesse e ser transferido para humano.

Os dois fluxos **compartilham** infraestrutura (handoff, labels, mídia, logger, health check), mas têm **papéis distintos** para a IA:

| | Receptivo (after-hours) | Campanha (promoção ativa) |
|---|---|---|
| **Quem inicia** | Lead manda mensagem | Sistema envia 1ª mensagem |
| **Quando a IA age** | Apenas após 18:30 (e fim de semana/feriado) | Apenas seg-sex 09:00-17:30 |
| **Papel da Alice** | Acolher e perguntar melhor horário | Apresentar oferta e coletar interesse |
| **Sai para humano em** | Quando coleta callback_period | Quando lead confirma interesse |
| **Status atual** | ✅ ativo em produção (smoke) | ⏳ apenas desenhado, zero código |

### O que o sistema NÃO faz

- Não agenda consulta nem consulta agenda real.
- Não interpreta exames, laudos, imagens clínicas ou documentos médicos.
- Não prescreve, diagnostica ou orienta clinicamente.
- Não insiste em venda quando o lead recusa.
- Não continua respondendo depois que a atendente humana assume.
- Não envia campanha para quem pediu opt-out (mesmo histórico antigo).

---

## 2. A Agente Alice

A Alice é a assistente virtual do Instituto Dr. Igor. Ela atua em **dois papéis distintos** conforme o fluxo do lead.

### 2.1 Alice Acolhedora (Fluxo Receptivo)

**Objetivo**: receber lead que chegou fora do expediente, acolher, entender o objetivo em poucas perguntas e coletar o melhor período pra equipe retornar.

- Comunicação calorosa, sem pressa.
- Faz **uma pergunta por vez**.
- Informa que a equipe encerrou o expediente, quando faz sentido.
- Coleta: **nome → objetivo principal → callback_period (manhã/tarde/noite)** → handoff.

### 2.2 Alice Promotora (Fluxo Campanha)

**Objetivo**: apresentar a oferta promocional ao lead, responder dúvidas comerciais sobre a oferta, coletar interesse e callback_period, e transferir para humano.

- Comunicação clara, leve, comercial **sem pressão**.
- Sabe da oferta concreta: **R$ 600 (era R$ 800), validade do mês, bônus T Sculptor**.
- Reforça a validade da oferta sem ser insistente.
- Aceita "não" como resposta — não tenta reverter.

### 2.3 Personalidade (ambos os papéis)

- Tom natural e conversacional, não robótico.
- Frases curtas, estilo WhatsApp (3-5 linhas).
- Sem emoji (a equipe prefere assim).
- **Sem jargão técnico** — nunca menciona workflow, label, score, IA, automação, tool, payload, custom attribute.
- PT-BR informal.

### 2.4 O que Alice NUNCA faz

- **Não diagnostica nada.** Mesmo se o lead pergunta "será que tenho hipotireoidismo?".
- **Não interpreta exame.** Se vier um PDF, foto de exame, prescrição → "a equipe vai analisar isso diretamente, vou encaminhar."
- **Não promete agenda.** Não diz "amanhã às 10h tem horário" — só pergunta período pra atendente confirmar.
- **Não inventa preço.** Na campanha, o valor é fixo R$ 600 (configurado em banco). No after-hours, só fala valor se for autorizado.
- **Não pede CPF, RG, dados sensíveis** desnecessários.
- **Não continua respondendo após o handoff.** Quando passa pra humano, encerra a participação.
- **Não simula agendamento.** Não fala "marquei pra você", "agendado", "confirmado".

---

## 3. Stack de Serviços

O sistema usa 6 serviços externos. Cada um faz uma coisa específica.

| Serviço | Papel | Onde roda |
|---|---|---|
| **WhatsApp** | Canal de origem das mensagens | Cliente |
| **Evolution API** | Conecta WhatsApp ↔ Chatwoot ↔ n8n. Faz envio (sendText), recebe webhook de mensagens entrantes, sincroniza contatos com Chatwoot automaticamente. | VPS Ubuntu via Portainer |
| **Chatwoot** | Inbox operacional onde a atendente humana lê e responde. Guarda labels, custom attributes, notas privadas, atribuições (team/agent). | VPS Ubuntu via Portainer |
| **n8n** | Orquestrador. Roda os workflows IGOR_* — webhooks, routers, agentes IA, tools, schedules. | VPS Ubuntu via Portainer |
| **Supabase Cloud** | Banco de dados. Guarda contacts, conversations, leads, messages, events, settings, campaign_runs, campaign_contacts. | Cloud |
| **Redis** (embarcado no n8n) | Locks distribuídos e batching temporário de mensagens fragmentadas do WhatsApp. | Em container n8n |
| **OpenAI** | Modelos LLM: gpt-5.4-mini (Alice conversacional), gpt-4o-transcribe (áudio→texto), gpt-4o-mini (imagem→descrição). | API |

### Integração crucial: Evolution ↔ Chatwoot

A Evolution API tem uma **integração nativa** com Chatwoot — quando habilitada, ela cria/atualiza automaticamente o contato e a conversa no Chatwoot **sem que o n8n precise fazer nada**. Em troca, ela **injeta** `chatwootConversationId` e `chatwootInboxId` em todos os webhooks que envia pro n8n.

Isso significa que o n8n nunca precisa criar contato no Chatwoot manualmente — só atualiza labels, custom attributes, private notes e assignments.

---

## 4. Fluxo Receptivo Fora de Expediente

Este é o fluxo que **está em produção** (com gates de segurança ativados — `dry_run_send=true` impede envio real até autorização).

### 4.1 Origem das mensagens

```
Lead manda mensagem no WhatsApp
    ↓
Evolution recebe + (via integração nativa) cria/atualiza
conversa no Chatwoot "Igor After Hours"
    ↓
Evolution dispara webhook MESSAGES_UPSERT → n8n /webhook/igor/inbound
    ↓
IGOR_01 começa a processar
```

### 4.2 Os 12 portões do router (em ordem)

Antes da Alice ser acionada, a mensagem passa por **12 verificações determinísticas em ordem**. Cada uma pode bloquear ou desviar o fluxo. A ideia é eliminar casos triviais **antes** de gastar recursos com LLM ou consultas pesadas.

#### Portão 1 — A mensagem é do próprio bot?

Se `fromMe=true`, a mensagem foi enviada por nós mesmos (Alice falando ou atendente humana via WhatsApp Web). A IA **nunca** responde a essas mensagens — senão criaria um loop infinito.

→ Bloqueia silenciosamente.

#### Portão 2 — A IA global está desligada?

Existe um **kill switch global** em `settings.ai_enabled_global`. Se a equipe quiser parar toda a IA por qualquer motivo (incidente, manutenção, política), basta marcar `false`.

→ Bloqueia silenciosamente.

#### Portão 3 — O workflow IGOR_01 está desligado?

Por baixo do kill switch global existe um **flag por workflow** (`settings.workflows_enabled.IGOR_01`). Permite desligar só o inbound sem mexer na campanha.

→ Bloqueia silenciosamente.

#### Portão 4 — O telefone é válido?

A Evolution às vezes envia mensagens com remetentes estranhos (números curtos, grupos, broadcasts). O sistema valida com regex `55+DDD+9XXXXXXXX` e normaliza 8 dígitos pra 9 quando aplicável.

→ Telefone inválido = log `invalid_phone` e descarta.

#### Portão 5 — Esse contato pediu opt-out?

Se na tabela `contacts` o campo `do_not_contact=true`, o lead pediu pra parar de receber mensagens em algum momento (talvez por outra campanha, talvez manualmente). **Opt-out tem prioridade máxima** — a IA não responde nem por after-hours.

→ Aplica label `optout` no Chatwoot (pra atendente ver) e bloqueia.

#### Portão 6 — A atendente humana já assumiu essa conversa?

Cada conversa tem `human_locked` (humano já enviou mensagem) e `ai_enabled` (IA pode atuar). Se qualquer um dos dois disser pra não responder, a IA recua. Isso garante que **a IA nunca compete com a atendente humana** na mesma conversa.

→ Bloqueia silenciosamente.

#### Portão 7 — Esse lead está em uma campanha ativa?

Se o telefone aparece em `campaign_contacts` com status `sent | delivered | replied | interested`, significa que recebeu uma campanha promocional recente e está respondendo a ela. Nesse caso, a mensagem **não** é tratada pelo fluxo after-hours — vai pro fluxo de campanha (IGOR_12).

> Hoje, como IGOR_12 ainda não foi construído, o sistema apenas registra o evento `campaign_routed_pending_IGOR_12` no banco. Quando IGOR_12 existir, esse portão chamará o workflow.

→ Roteia para fluxo de campanha (ou registra placeholder por enquanto).

#### Portão 8 — Estamos dentro do horário comercial?

Aqui está a regra central do fluxo after-hours: **a IA só age fora do expediente humano**. Se a mensagem chega em horário comercial, a Alice **não responde** — fica no Chatwoot pra atendente tratar normalmente.

A janela é configurável em `settings`:
- `after_hours_start = "18:30"` (fim do expediente humano)
- `after_hours_end = "07:30"` (início do expediente do dia seguinte)
- `timezone = "America/Sao_Paulo"`

> **Dívida conhecida**: hoje esse portão está com **BYPASS em código** pra permitir smoke test. O nó "Check Business Hours + Holiday" do IGOR_01 força `inside_business_hours=false` sempre. **Antes de prod real, reverter.**

→ Em horário comercial: bloqueia silenciosamente. Fora do expediente: continua.

#### Portão 9 — É feriado?

Feriados são configurados em `settings.holidays` (array de datas `YYYY-MM-DD`). A política `holiday_policy` define o comportamento:
- `after_hours_force`: trata o dia todo como after-hours (IA age o dia inteiro).
- `block_completely`: IA não responde no feriado nem em horário comercial.

Hoje a configuração é `after_hours_force` — a equipe não trabalha em feriados, então a Alice acolhe leads o dia inteiro nessas datas.

→ Apenas registra evento (não bloqueia, é só log).

#### Portão 10 — Tenho o lock dessa conversa?

O WhatsApp tem um comportamento chato: quando o lead digita uma frase longa, o app frequentemente quebra em **vários webhooks separados** ("Oi" + "tudo bem?" + "queria saber sobre"). Se a Alice respondesse a cada fragmento, daria 3 respostas confusas.

A solução é um **lock distribuído no Redis** por telefone:

```
Primeira mensagem chega:
  - INCR igor:lock:inbound:{phone} → retorna 1 → "ganhou o lock"
  - Espera 3 segundos
  - Recolhe TODAS as mensagens acumuladas em igor:batch:{phone}
  - Junta e processa como UMA conversa
  - DEL igor:lock:inbound:{phone}

Segunda/terceira mensagem (dentro dos 3s):
  - INCR retorna 2, 3 → "lock já tomado"
  - Empilha o fragmento em igor:batch:{phone}
  - Responde 200 e some — quem tem o lock vai processar
```

→ Quem tem o lock continua. Quem não tem, vira fragmento na fila.

#### Portão 11 — É texto ou mídia?

Mensagens de texto seguem direto. Mensagens com áudio, imagem ou documento precisam ser **normalizadas em texto** antes da Alice ler. Esse é o papel do IGOR_02 (vide §6).

→ Texto: passthrough. Mídia: chama IGOR_02 e recebe `normalized_text + safety_flags`.

#### Portão 12 — Compliance Fast-Path

Se o IGOR_02 marcou alguma `safety_flag` (mídia clínica, imagem sensível, comprovante de pagamento, documento médico) ou se de alguma forma `should_handoff=true` chegou, a Alice **não conversa** — o sistema bypassa direto pro handoff humano via IGOR_05.

Exemplo: lead manda PDF de exame de sangue → IGOR_02 detecta "hemograma" no texto extraído → `safety_flags.clinical=true` → IGOR_03 nem conversa, manda direto pro humano com uma nota tipo "lead enviou documento clínico, equipe precisa analisar".

→ Compliance: pula Alice, chama IGOR_05.

### 4.3 Por que essa ordem importa

A ordem dos portões não é arbitrária — é otimização e segurança:

- **fromMe é primeiro** porque é o caso mais comum (todo bot vê seus próprios envios).
- **Opt-out vem antes de business hours** porque opt-out tem prioridade máxima — nem mesmo fora do expediente o sistema viola um pedido de parar.
- **Campaign check vem antes de business hours** porque uma resposta de campanha pode chegar às 14h (horário comercial), e ela deve ir pro fluxo de campanha, não ser bloqueada.
- **Phone invalid vem antes de contact lookup** porque sem phone normalizado o SELECT não bate.
- **Lock vem antes da Alice** porque sem isso ela responderia 3 vezes a uma frase fragmentada.

### 4.4 Diagrama do roteamento

```
                Lead manda WhatsApp
                       │
                       ▼
                 Webhook IGOR_01
                       │
            ┌──────────┴──────────┐
            │  Normalize Payload  │
            └──────────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        │  12 portões em ordem        │
        │  (qualquer um pode bloquear │
        │   ou desviar)               │
        ├─────────────────────────────┤
        │  P1: fromMe?       → bloqueia│
        │  P2: ai_disabled?  → bloqueia│
        │  P3: wf_disabled?  → bloqueia│
        │  P4: phone invalid?→ bloqueia│
        │  P5: opt_out?      → bloqueia│
        │  P6: human_locked? → bloqueia│
        │  P7: campanha?     → roteia  │
        │  P8: horário cml?  → bloqueia│
        │  P9: feriado       → log     │
        │  P10: tem lock?    → batchea │
        │  P11: mídia?       → IGOR_02 │
        │  P12: compliance?  → IGOR_05 │
        └──────────────┬──────────────┘
                       │ passou tudo
                       ▼
              ┌────────────────┐
              │ Chama Alice    │
              │ Acolhedora     │
              │ (IGOR_03)      │
              └────────────────┘
```

### 4.5 Por que 3 segundos de espera no lock

3 segundos é a janela típica em que um humano termina de digitar uma frase fragmentada no WhatsApp. Mais curto que isso (1-2s) perde fragmentos. Muito mais longo (5-10s) faz o lead sentir que o sistema "está pensando demais". Empiricamente 3s funciona bem — herdado do pattern ASX em produção.

---

## 5. A Conversa com a Alice Acolhedora

Depois que passa pelos 12 portões, a Alice entra. Ela usa um agente LangChain (gpt-5.4-mini) com **memória persistente no Postgres** (cada conversa tem session key `after_hours_{phone}`, mantém últimas 25 mensagens em contexto).

### 5.1 Sequência ideal de coleta

A Alice tenta seguir essa ordem, sem rigidez:

| Etapa | O que faz | Quando avança |
|---|---|---|
| **1. Saudação** | Apresenta-se, informa que a equipe encerrou o expediente, pergunta o nome se ainda não souber | Lead responde algo |
| **2. Nome** | Confirma o nome captado | Lead confirma ou corrige |
| **3. Objetivo** | "O que você está buscando hoje com o Dr. Igor?" | Lead responde |
| **4. Callback** | "Qual o melhor período pra atendente te chamar amanhã: manhã ou tarde?" | Lead escolhe período |
| **5. Handoff** | Alice chama tool `request_handoff` → envia mensagem final de encerramento | — |

### 5.2 As 4 tools da Alice Acolhedora

A Alice tem 4 ferramentas que ela pode chamar durante a conversa. Ela decide quando usar cada uma com base no contexto.

| Tool | Quando ela chama | O que faz |
|---|---|---|
| **save_lead_partial** | Sempre que captura nome, objetivo, cidade ou callback | Persiste em `contacts` + `leads` no Supabase |
| **update_conversation_state** | Quando muda o estado da conversa (ex: `collecting_name` → `collecting_callback`) | Atualiza `conversations.state` no Supabase |
| **set_label_and_attr** | Quando precisa marcar algo no Chatwoot (label, atributo) | Aplica via IGOR_04 |
| **request_handoff** | Quando tem dados mínimos OU quando detecta caso sensível | Chama IGOR_05 (encerra conversa, transfere pra humano) |

### 5.3 Comportamento sob ambiguidade

A Alice **não força** nenhuma etapa. Se o lead pula pra outra coisa, ela vai junto:

- Lead manda só "Oi" → Alice pergunta nome.
- Lead se apresenta com nome e objetivo na mesma mensagem → Alice pula direto pra callback.
- Lead pergunta valor antes de Alice perguntar callback → Alice responde valor (se autorizado) e tenta voltar pra callback.
- Lead diz "quero falar com pessoa" → Alice chama handoff imediato (não força coleta).

### 5.4 Limite de turnos

A Alice tem **máximo 6 iterações** por mensagem do lead (configurado no agent node). Isso evita loops infinitos onde ela chamaria tools sem parar. Na prática, raramente passa de 2-3 iterações.

---

## 6. Tratamento de Mídia (IGOR_02)

Quando o lead manda algo que não é texto puro, o IGOR_02 entra em ação **antes** da Alice ver a mensagem.

### 6.1 O que faz cada tipo

| Tipo de mídia | O que o sistema faz |
|---|---|
| **Texto** | Passthrough — usa o texto direto. |
| **Áudio** | Baixa o arquivo, manda pra OpenAI `gpt-4o-transcribe` em PT-BR, recebe a transcrição como texto. |
| **Imagem com legenda** | Usa a legenda como texto principal. A imagem em si **não é analisada** pela IA. |
| **Imagem sem legenda** | Manda pra OpenAI `gpt-4o-mini` (visão) com um prompt **estritamente restritivo**: descreve a imagem brevemente + classifica o tipo (selfie, exame, comprovante, outro) + marca safety_flags. **Nunca diagnostica.** |
| **Documento PDF** | Extrai o texto do PDF, roda heurística regex em PT-BR procurando termos clínicos (exame, laudo, prescrição, CRM, diagnóstico, hemograma, raio-X, ressonância). Se encontrar → marca `safety_flags.clinical=true`. |
| **Documento outro** | Registra o envio, marca como "documento não analisado". |
| **Tipo desconhecido** | Marca `should_handoff=true` — não tenta entender. |

### 6.2 Safety flags possíveis

O IGOR_02 emite até 4 flags de segurança:

- **clinical** — texto clínico em PDF, foto de exame, prescrição médica.
- **sensitive_image** — corpo nu, ferida, antes/depois clínico.
- **payment_proof** — comprovante de transferência/pagamento.
- **financial** — boleto, extrato.

Quando qualquer flag está `true`, o IGOR_03 detecta isso no Compliance Fast-Path (Portão 12) e **bypassa a Alice** — manda direto pro humano com uma mensagem segura.

### 6.3 Por que não a IA não interpreta exames

Decisão de compliance: **o Instituto Dr. Igor é um consultório médico**. A IA emitir qualquer opinião sobre um exame ("seu colesterol está alto", "esse laudo parece OK") seria exercício ilegal da medicina. Por isso o prompt do vision model tem instrução **explícita** de não interpretar clinicamente, só descrever o objeto.

---

## 7. Sistema de Handoff (IGOR_05)

O handoff é o momento em que a Alice **encerra a participação** e transfere a conversa pra atendente humana. Tudo precisa acontecer **antes** de ela enviar a mensagem final de despedida pro lead — porque depois que avisa "vou te passar pra equipe", ela não pode mais ter erro de virar atrás.

### 7.1 Sequência obrigatória (em ordem)

```
1. Lead chega em estado pronto pro handoff (callback coletado OU compliance)
   │
   ▼
2. Alice chama request_handoff (com motivo + summary + callback_period)
   │
   ▼
3. IGOR_05 começa o ritual:
   │
   ├─ a) UPDATE conversations.human_locked=true, ai_enabled=false
   ├─ b) UPDATE leads.status='aguardando_atendente', handoff_at=now()
   ├─ c) Aplica labels: handoff_done, ai_disabled, aguardando_atendente
   ├─ d) Cria private note no Chatwoot com resumo do lead
   ├─ e) Atribui a conversa pro team "Atendimento Humano" (id=1)
   ├─ f) Se houver atendente específico configurado, atribui a ela também
   ├─ g) Registra evento handoff_complete em events
   │
   ▼
4. IGOR_05 envia a mensagem final ao lead via WhatsApp (gated)
   │
   ▼
5. Alice silencia. Próxima mensagem do lead será respondida pela atendente.
```

### 7.2 Por que UPDATE conversations.human_locked vem ANTES de tudo

Se o `human_locked=true` fosse setado **depois** das chamadas Chatwoot, haveria uma janela curta em que o lead poderia mandar nova mensagem e a Alice voltaria a responder. A ordem rigorosa protege contra essa race condition.

### 7.3 Private note no Chatwoot (a equipe vê isso quando abre a conversa)

```markdown
🔔 Handoff de Alice (IA) para atendimento humano

**Motivo:** {handoff_reason}
**Período preferido pra retorno:** {callback_period}
**Fluxo origem:** {owner_flow}  (after_hours ou campaign_promo)
**Resumo:** {summary do que aconteceu na conversa}

Próxima ação: chamar o lead no período informado e continuar o atendimento comercial.
```

### 7.4 Mensagem final ao lead (varia por motivo)

| Motivo do handoff | Mensagem que o lead recebe |
|---|---|
| Callback coletado | "Combinado. Deixei registrado pra equipe te chamar [período] e continuar seu atendimento." |
| Compliance (documento clínico) | "Recebi o documento. Pra sua segurança, a equipe precisa analisar diretamente. Vou encaminhar sua conversa pro atendimento humano." |
| Lead pediu pessoa | "Claro. Vou deixar sua conversa encaminhada pra equipe te chamar assim que retornar o atendimento." |
| Sensitive medical (campanha) | "Recebi sua mensagem. Vou deixar registrado pra equipe humana conversar com você sobre isso com atenção." |

### 7.5 Atendente específica vs. team-only

A configuração `settings.chatwoot_human_assignee_id` controla isso:
- Se for um **integer** (ex: `42`), o IGOR_05 atribui a conversa pra essa atendente específica + ao team.
- Se for **null** (default), atribui só ao team — qualquer atendente livre pega.

A flexibilidade existe porque em alguns períodos o instituto tem uma atendente fixa cuidando dos retornos noturnos, em outros é distribuído.

---

## 8. Fluxo Campanha de Promoção Ativa

Este fluxo **ainda não foi construído**. O que existe hoje:
- A spec funcional completa em `docs/logica-fluxo-igor-agente-ativo-promocao.md`.
- O schema de banco aplicado (`campaign_runs`, `campaign_contacts`).
- 137 leads já importados no banco (66 humano + 73 IA).
- Zero JSON em `n8n/workflows/IGOR_09*-13*.json`.

Esta seção descreve **como o fluxo vai se comportar quando for construído** — baseado na spec, no IMPLEMENTATION_PLAN e nas decisões arquiteturais tomadas em 2026-05-14 e 2026-05-15.

### 8.1 A oferta vigente

```
Serviço: Primeiro atendimento com Dr. Igor
Preço normal: R$ 800,00
Preço promocional: R$ 600,00 (válido este mês)
Taxa de agendamento: R$ 180,00 (abatida integralmente no valor da consulta)
Bônus: 1 sessão de T Sculptor (tecnologia de fortalecimento muscular, não invasiva)
```

A oferta fica em `campaign_runs.message_template + .regular_price + .promo_price + .valid_until + .media_url`. Pode mudar entre campanhas sem mexer em workflow.

### 8.2 Decisão arquitetural: 4 workflows (IGOR_11 foi deferido)

Originalmente o desenho previa 5 workflows (IGOR_09–13). Em **2026-05-15** decidiu-se **consolidar IGOR_11 inline no IGOR_10**:

| Workflow planejado | Status | Motivo |
|---|---|---|
| IGOR_09 Campaign_Importer | ⏳ Será **script Python local** (`scripts/import-kommo-csv.py`), não workflow n8n | Setup operator-driven, one-shot. Não justifica overhead de workflow. |
| IGOR_10 Campaign_Dispatcher | ⏳ Workflow n8n com cron | Disparo automatizado por janela. |
| ~~IGOR_11 Message_Generator~~ | ⛔ **Deferido — não será construído** | Sem LLM + sem variantes A/B = só uma string interpolation (`template.replace('{nome}', name)`). Consolida no IGOR_10 via Edit Fields. Se LLM ou A/B forem adicionados depois, separa. |
| IGOR_12 Campaign_Inbound_Handler | ⏳ Workflow n8n | Recebe respostas e roteia. |
| IGOR_13 Agent_Campaign | ⏳ Workflow n8n | Alice Promotora. |

### 8.3 Como leads entram na campanha (IGOR_09)

O processo é **manual**, disparado pelo operador (você):

```
1. Operador exporta CSV de leads qualificados do Kommo
   (66 leads humanos + 73 leads IA já importados em 2026-05-14)
   ↓
2. Operador roda: python scripts/import-kommo-csv.py
   ↓
3. Script processa cada linha:
   a. Valida campos mínimos (nome, telefone, objetivo)
   b. Normaliza telefone pro padrão 55+DDD+9XXXXXXXX
   c. Faz dedup pelo ID Kommo (evita duplicar se rodar 2x)
   d. UPSERT em contacts (reusa contact_id existente se phone bater)
   e. UPSERT em leads (com external_id + source='kommo_csv_YYYY-MM-DD')
   f. Roda checklist de elegibilidade:
      ✗ Já tem do_not_contact=true → skip 'opt_out'
      ✗ Já agendou (leads.scheduled_at preenchido) → skip 'ja_agendado'
      ✗ Recebeu campanha nos últimos 30 dias → skip 'campanha_recente'
      ✗ kommo_data->>'Etapa do lead' = 'AGENDADO' → skip 'ja_agendado_kommo'
      ✓ Passou tudo → status='queued'
   g. Monta personalized_context (resumo do Objetivo + Motivo não agendamento)
   h. INSERT em campaign_contacts
   i. Aplica labels no Chatwoot: 'promo_eligivel' (queued) ou 'optout' (skipped)
   ↓
4. Script imprime relatório:
   - Total processado: 139
   - Queued: 128
   - Skipped: 11 (com breakdown por motivo)
```

### 8.4 Disparo (IGOR_10)

O dispatcher é um cron que **roda a cada 1 minuto, de segunda a sexta**. Cada execução envia **no máximo 1 mensagem** (ou nenhuma, se algum gate barrar).

#### Os 7 gates do dispatcher

Antes de enviar **uma única mensagem**, o dispatcher passa por 7 verificações:

1. **`workflows_enabled.IGOR_10`** é true? — Senão, fim.
2. **`ai_enabled_global`** é true? — Senão, fim (kill switch global aplica também à campanha).
3. **Janela de envio aberta**? — `09:00 ≤ agora < 17:30` no timezone PT-BR? Senão, fim.
4. **É dia útil**? — Segunda a sexta? Senão, fim.
5. **Não é feriado**? — Não está em `settings.holidays`? Senão, fim.
6. **Limite diário não atingido**? — `COUNT(campaign_contacts WHERE sent_at::date=hoje) < settings.campaign_daily_limit`? Senão, fim.
7. **Throttle de envio**? — Já passaram pelo menos `60s / per_minute_limit` segundos desde o último envio (controlado por Redis key `igor:campaign:lastSentAt`)? Senão, fim.

Só depois desses 7 gates é que o dispatcher **busca 1 contato `queued`** no banco e tenta enviar.

#### Ramp-up sugerido de envios

Mesmo com a Evolution conectada e a lista pronta, **não disparar 137 mensagens de uma vez**. WhatsApp pune disparo em massa rápido — banimentos de número, queda de entregabilidade, marcação como spam.

```
Dia 1:    20 envios (testar entregabilidade)
Dia 2:    50 envios (se métricas saudáveis)
Dia 3+: 100 envios (se opt-out < 3 a cada 20)
```

A configuração fica em `settings.campaign_daily_limit` — basta UPDATE pra mudar.

#### Revalidação no momento do envio

Mesmo que o lead estava `queued` quando o importer rodou ontem, antes de enviar **agora** o dispatcher revalida:
- O lead pediu opt-out desde então? (`contacts.do_not_contact=true`)
- O lead agendou nesse meio tempo? (`leads.scheduled_at` preenchido)
- A conversa já está com humano? (`conversations.human_locked=true`)
- O status mudou de `queued`? (alguém marcou manual como `blocked`?)

Se qualquer um falhar → marca como `skipped` e pula pra fim. O cron vai pegar outro contato no próximo minuto.

#### Como a mensagem é montada (IGOR_11 inline)

O template fica em `campaign_runs.message_template`. O node Edit Fields no IGOR_10 faz:

```javascript
sent_message = template.replace(/{nome}/g, contact.name || 'Olá')
```

Sem LLM, sem variantes — é literalmente substituição de string. Se `contact.name` está vazio, troca por "Olá" pra não ficar com `{nome}` no texto.

#### Envio condicional (dry_run gate)

Mesmo passando por todos os gates, o envio real só acontece se:
```
allow_real_whatsapp_send == true  AND  dry_run_send == false
```

Em smoke test: `dry_run_send=true` → o sistema marca como "enviado" no banco mas **não chama Evolution**. Apenas registra `dry_run_send` em events. Permite testar todo o pipeline sem WhatsApp real.

### 8.5 Resposta do lead: como IGOR_12 classifica

Quando o lead responde à mensagem promocional, o webhook chega no **IGOR_01** primeiro (mesmo entry point do inbound). No portão 7, o IGOR_01 detecta que esse telefone tem `campaign_contacts.status IN (sent, delivered, replied, interested)` → **roteia pro IGOR_12** em vez de chamar a Alice Acolhedora.

O IGOR_12 faz **classificação de intenção** em duas camadas:

#### Camada 1 — Determinística (regex PT-BR)

Antes de gastar tokens de LLM, regex em PT-BR pega os casos óbvios:

| Padrão regex | Intent | Por que determinístico |
|---|---|---|
| `pare\|parar\|não me mande\|remover\|sair\|não quero receber\|cancele\|remova\|bloqueia` | **opt_out** | Crítico legalmente — não pode depender de LLM acertar |
| `tenho interesse\|quero\|pode ver\|faz sentido\|sim claro` | **interested** | Caso comum, vale acelerar |
| `quanto\|valor\|custa\|preço\|600\|800` | **price_question** | Pergunta direta sobre preço |
| `não quero\|agora não\|depois\|sem interesse` | **not_interested** | Recusa clara |

Se nenhum match → vai pra LLM.

#### Camada 2 — LLM (gpt-5.4-mini com confidence score)

A LLM recebe um prompt estruturado: contexto da campanha + mensagem do lead → retorna JSON `{intent, confidence, reason}`. As 9 intents possíveis:

| Intent | Roteamento |
|---|---|
| **interested** | → IGOR_13 (Alice Promotora pergunta período) |
| **price_question** | → IGOR_13 (Alice confirma valor + bônus) |
| **scheduling** | → IGOR_13 (Alice pergunta período pra atendente) |
| **doubt** | → IGOR_13 (Alice explica brevemente) |
| **human_request** | → IGOR_13 → handoff |
| **not_interested** | Mensagem polida + label `promo_nao_interessado` + status `not_interested` |
| **opt_out** | Rota opt-out determinística |
| **sensitive_medical** | → IGOR_05 (compliance handoff imediato) |
| **unknown** | Alice pergunta "pode me dizer com outras palavras?" |

### 8.6 Opt-out determinístico (prioridade máxima)

Quando regex detecta uma frase de opt-out **OU** quando a LLM classifica como `opt_out`, o sistema executa este ritual obrigatório:

```
1. UPDATE contacts SET do_not_contact=true, consent_marketing=false WHERE phone=...
2. UPDATE campaign_contacts SET status='opt_out', optout_at=now() WHERE id=...
3. UPDATE conversations SET state='campaign_opt_out'
4. Aplica labels no Chatwoot: ['promo_optout', 'optout'], remove 'promo_eligivel'
5. Registra event campaign_opt_out
6. Responde ao lead: "Claro. Vou registrar pra você não receber mais esse tipo de mensagem."
7. Para. A IA não responde nunca mais nessa conversa (a menos que a equipe reative manualmente).
```

A partir desse momento, esse phone está bloqueado **em todos os fluxos futuros** — outras campanhas, ou até mesmo o fluxo after-hours, vão pular esse contato no portão 5.

### 8.7 A Alice Promotora (IGOR_13)

Mesma "Alice" do fluxo receptivo, mas com **system prompt completamente diferente** + memória isolada.

#### Diferenças vs. Alice Acolhedora

| | Alice Acolhedora (IGOR_03) | Alice Promotora (IGOR_13) |
|---|---|---|
| **Session key da memória** | `after_hours_{phone}` | `campaign_{phone}` |
| **System prompt sabe da oferta?** | Não (after-hours geral) | Sim — preço, validade, bônus T Sculptor |
| **Mood** | Calmo, acolhedor | Comercial educado |
| **Coleta** | nome + objetivo + callback | callback (objetivo já veio do Kommo) |
| **Temperature LLM** | 0.4 | 0.3 (mais determinístico) |

#### Comportamento obrigatório

1. Se lead pergunta preço → confirma **R$ 600 + validade + bônus T Sculptor**. Nunca inventa desconto extra.
2. Se lead demonstra interesse → **SEMPRE** pergunta período (manhã/tarde).
3. Depois de coletar período → chama `request_handoff` (mesmo IGOR_05 do outro fluxo).
4. Nunca diagnostica, nunca promete agenda, nunca muda preço.
5. Se lead menciona termo clínico/sensível → handoff imediato com motivo `sensitive_medical`.

### 8.8 Memórias isoladas (importante)

Cada Alice tem session key separada. Se um mesmo telefone passar pelos dois fluxos (improvável mas possível — ex: o lead recebeu campanha em maio, mas em julho mandou uma mensagem espontânea após-expediente), **as duas conversas não se misturam**. A Alice Acolhedora não tem acesso ao histórico da Promotora e vice-versa.

### 8.9 Diagrama end-to-end da campanha

```
DIA 0 — Operador roda script
  python scripts/import-kommo-csv.py
        │
        ▼
  Supabase: 137 contatos importados, 128 queued + 11 skipped

DIA 1+ — Automático
  Cron a cada minuto (seg-sex, 09:00-17:30)
        │
        ▼
  IGOR_10 passa por 7 gates → pega 1 queued → revalida → envia
        │ (rate-limited)
        ▼
  Lead recebe WhatsApp com oferta personalizada

LEAD RESPONDE
        │
        ▼
  Webhook → IGOR_01 → portão 7 detecta campanha → roteia pra IGOR_12
        │
        ▼
  IGOR_12 classifica intent
        │
        ├─ opt_out → ritual de opt-out → fim
        ├─ not_interested → mensagem polida + label → fim
        ├─ sensitive_medical → IGOR_05 compliance → fim
        ├─ unknown → Alice pede pra reformular → aguarda
        └─ interested / price / scheduling / doubt / human_request
              │
              ▼
        IGOR_13 (Alice Promotora)
              │ responde dúvida, coleta callback_period
              ▼
        Chama request_handoff
              │
              ▼
        IGOR_05 → labels handoff_done, atribui pra atendente,
                  human_locked=true, ai_enabled=false,
                  envia mensagem final ao lead
              │
              ▼
        Atendente humana lê private note no Chatwoot e liga no período combinado
```

---

## 9. Comportamento com Mensagens do Chatwoot (IGOR_06)

Toda mensagem que aparece no Chatwoot (não importa quem mandou) dispara o webhook `/igor/chatwoot` → IGOR_06. Esse workflow tem dois papéis:

### 9.1 Espelhar tudo no Supabase

Toda mensagem é copiada pra tabela `messages` no Supabase. Isso garante que existe um **audit trail completo** independente do Chatwoot. Se um dia a equipe precisar exportar histórico, está tudo no banco.

### 9.2 Detectar takeover humano

Quando o sender é `outgoing+user` (atendente humana enviou mensagem pelo Chatwoot Web), o IGOR_06 executa:

```
1. UPDATE conversations SET human_locked=true, ai_enabled=false, state='human_assigned'
2. Aplica labels no Chatwoot: atendimento_humano, ai_disabled
3. Registra evento human_assumed
```

A partir desse momento, **qualquer nova mensagem do lead nessa conversa é bloqueada no portão 6 do IGOR_01** — a Alice nunca mais responde nessa conversa (a menos que a equipe reative).

### 9.3 Os 3 ramos de noop

Nem toda mensagem do Chatwoot precisa de ação. O IGOR_06 distingue 3 casos onde só **registra e segue**:

| Quem mandou | Ação |
|---|---|
| `outgoing + agent_bot` (Alice falou) | NoOp — já registramos no IGOR_03. |
| `incoming + contact` (lead falou) | NoOp — já processamos via Evolution → IGOR_01. |
| `outgoing + user` (atendente humana) | **HUMAN TAKEOVER** — trava IA. |

Sem esses distinguidores, qualquer mensagem da Alice causaria um update redundante e qualquer mensagem do lead seria processada 2 vezes (uma pelo Evolution, outra pelo Chatwoot).

---

## 10. Comportamentos Especiais (casos de borda)

### 10.1 Lead em handoff_done envia nova mensagem

A conversa está com `human_locked=true`. No portão 6 do IGOR_01, a mensagem é bloqueada. A atendente humana é quem vai responder (vê a mensagem nova no Chatwoot).

### 10.2 Lead em opt-out envia nova mensagem espontânea

A conversa está com `contacts.do_not_contact=true`. No portão 5 do IGOR_01, a mensagem é bloqueada. A atendente humana ainda pode responder se quiser — o opt-out só impede a IA, não a humana.

### 10.3 Lead em campanha (status `sent`) envia mensagem fora do escopo

Cenário: o lead recebeu a oferta de manhã, e à noite manda "Oi, tudo bem?" sem mencionar a campanha. No portão 7 do IGOR_01, o sistema detecta `status='sent'` → roteia pro IGOR_12. O IGOR_12 vai tentar classificar e provavelmente cair em `unknown` → Alice pergunta "pode me dizer com outras palavras?".

### 10.4 Documento clínico enviado por lead

O IGOR_02 detecta `safety_flags.clinical=true`. No portão 12 do IGOR_01, o Compliance Fast-Path é acionado → IGOR_03 nem chama a Alice, manda direto pro IGOR_05 com motivo `documento_clinico_sensivel`. O lead recebe uma mensagem segura: "Recebi o documento. Pra sua segurança, a equipe vai analisar diretamente." E pronto.

### 10.5 Race condition — IA respondendo enquanto humano também responde

Cenário hipotético: a atendente envia uma mensagem no Chatwoot **exatamente** no momento em que a Alice está montando uma resposta no n8n. O IGOR_06 vai registrar o `human_assumed`, mas a Alice já está enviando.

Esse é o evento que o IGOR_08 (health check) procura ativamente: a cada 10 minutos roda `Race Detection` — `SELECT count(*) FROM conversations c JOIN messages m WHERE c.ai_enabled=true AND m.role IN ('agent_human', 'agent') AND m.created_at > now() - 10min`. Se encontrar > 0, dispara `health_alert`. É um sinal pra equipe investigar.

Mitigação real: o lock Redis no IGOR_01 já reduz muito a janela porque a Alice só responde fora do expediente (quando, em teoria, a humana não está logada). Mas em horário comercial extendido isso pode acontecer.

### 10.6 Lead manda áudio em vez de texto

O IGOR_02 transcreve com `gpt-4o-transcribe` em PT-BR. A Alice trata como se fosse texto. Não há acknowledgment "recebi seu áudio" — o sistema age direto sobre o conteúdo transcrito.

### 10.7 Lead envia stickers, emojis, GIFs

Esses caem em `messageType='unknown'` → IGOR_02 marca `should_handoff=true, handoff_reason='midia_desconhecida'`. Compliance Fast-Path → IGOR_05 → mensagem segura ao lead.

### 10.8 Evolution disconectou no meio de uma conversa

Se o WhatsApp desconecta da Evolution (banimento, queda de servidor), todos os envios passam a falhar. O IGOR_08 detecta isso a cada 10 minutos via ping `GET /instance/connectionState/convert-teste` — se `body.instance.state != 'open'`, marca service como `fail` no health snapshot. Se 2+ services falharem simultaneamente → `overall_status = 'critical'` + dispara `health_alert`.

A Alice não tem como detectar isso sozinha — confia que o sistema vai re-tentar e que o operador acompanha o health.

---

## 11. Tools do Sistema (Comportamento)

Esta seção descreve **quando cada workflow callable é chamado e o que ele faz** — não a config interna.

### 11.1 IGOR_02 — Media Normalizer

**Quando**: IGOR_01 chama no portão 11 sempre que `messageType ≠ 'text'`. IGOR_12 chama quando lead em campanha responde com mídia.

**O que faz**: converte qualquer tipo de mídia (áudio, imagem, documento) em `{normalized_text, media_summary, safety_flags, should_handoff, handoff_reason}`. Roda regex pra detectar conteúdo clínico em PDFs. Envia imagens pra `gpt-4o-mini` com prompt restritivo. Áudios pra `gpt-4o-transcribe`.

**Retorna**:
```json
{
  "normalized_text": "[audio transcrito] olá quero saber sobre consulta",
  "media_summary": "[audio transcrito] olá quero saber sobre consulta",
  "safety_flags": {"clinical": false, "sensitive_image": false, "payment_proof": false, "financial": false},
  "should_handoff": false,
  "handoff_reason": null
}
```

### 11.2 IGOR_04 — Tool Labels & Attributes

**Quando**: chamado por IGOR_01 (label `optout` em opt-out, `fora_expediente` em routing), IGOR_05 (labels de handoff), IGOR_06 (label `atendimento_humano` em takeover), IGOR_03/13 tools (Alice aplicando labels durante conversa).

**O que faz**: aplica labels e custom attributes no Chatwoot. **Labels usam merge semantics** (busca labels atuais → soma novas - remove pedidas → POST array completo) porque o Chatwoot tem `POST /labels` com semântica de replace. Custom attributes são additive por padrão.

**Retorna**:
```json
{
  "ok": true,
  "labels_added": ["fora_expediente"],
  "labels_removed": [],
  "attrs_conversation_keys": ["automation_state", "lead_status"],
  "attrs_contact_keys": []
}
```

### 11.3 IGOR_05 — Finalize Handoff

**Quando**: chamado por IGOR_03 (Alice Acolhedora completou callback OU detectou compliance), IGOR_13 (Alice Promotora confirmou interesse + callback), IGOR_12 (intent=sensitive_medical).

**O que faz**: executa o ritual de handoff (§7.1) — UPDATE banco, labels Chatwoot, private note, assignment, mensagem final ao lead via Evolution (gated por `dry_run_send` + `allow_real_whatsapp_send`).

**Retorna**:
```json
{
  "ok": true,
  "lead_updated": true,
  "labels_applied": true,
  "message_sent": "real",
  "send_mode": "real",
  "handoff_reason": "after_hours_callback"
}
```

### 11.4 IGOR_AUX_save_lead_partial

**Quando**: tool callable usada pela Alice (IGOR_03/13) durante a conversa, sempre que captura `nome`, `objetivo`, `cidade` ou `callback_period`.

**O que faz**: UPSERT em `contacts` (por phone) e `leads` (por source + external_id) no Supabase. Idempotente — pode chamar 20 vezes com os mesmos dados sem duplicar nada.

### 11.5 IGOR_AUX_update_conversation_state

**Quando**: tool callable usada pela Alice quando muda de estado conversacional (ex: terminou de coletar nome → próximo estado é `quick_qualification`; coletou callback → `handoff_pending`).

**O que faz**: UPDATE `conversations.state` no Supabase, mantendo audit trail no `events` table.

### 11.6 IGOR_07 — Error Logger (universal errorWorkflow)

**Quando**: automaticamente quando qualquer workflow IGOR_* dispara erro não tratado.

**O que faz**: capta o erro (workflow name, execution id, last node, error message, stack), registra em `events` como `infra_error`. Permite que o operador veja todos os erros num único lugar via query SQL.

### 11.7 IGOR_08 — Health Check

**Quando**: cron a cada 10 minutos.

**O que faz**: testa em paralelo os 5 services externos (n8n, Chatwoot, Evolution, OpenAI, Supabase). Conta eventos das últimas 24h (`infra_error`, `opt_out`, mensagens, leads, campanha). Detecta race conditions (IA + humano respondendo simultâneo) e batches órfãos no Redis (sintoma de lock falhando em ser liberado).

Calcula `overall_status`:
- **healthy** — tudo verde.
- **degraded** — 1 service falhou OU eventos infra elevados OU opt-outs altos.
- **critical** — 2+ services falharam OU race detectado OU >5 orphan batches.

Se critical → registra `health_alert` em events.

---

## 12. Smoke Test (IGOR_TEST_Smoke_Trigger)

Workflow manual com 1 botão "Execute". Quando você clica:

1. Lê `settings.smoke_test_phone` e `settings.smoke_test_message`.
2. Valida o phone (regex 55+DDD+9XXXXXXXX).
3. Registra evento `smoke_trigger_sent`.
4. Envia WhatsApp via Evolution pro phone configurado, com a mensagem configurada.

**Questionamento pendente** (2026-05-15): você apontou que o smoke deveria **simular um inbound** (POST direto no webhook `/igor/inbound` com payload Evolution fake), não enviar ping pro operador. O design atual é "ping pro operador" — você confirma se trocar pro padrão simulador.

---

## 13. Exemplos de Conversa

Esta seção mostra **conversas reais** que o sistema deve produzir. Cada exemplo é canônico — não é improviso, é o comportamento esperado.

### 13.1 Inbound — Caminho Feliz (lead sem nome)

```
[Lead manda WhatsApp às 22:30]

Lead: Oi, queria saber sobre consulta.

Alice: Oi, tudo bem? Sou a Alice, assistente do Dr. Igor.

       A equipe já encerrou o expediente, mas posso adiantar
       seu atendimento por aqui.

       Qual seu nome?

Lead: Ana.

Alice: Perfeito, Ana. O que você está buscando hoje com o Dr. Igor?

Lead: Quero emagrecer e entender melhor o acompanhamento.

Alice: Entendi. Vou deixar isso registrado pra equipe continuar
       com você.

       Qual o melhor período pra atendente te chamar amanhã:
       manhã ou tarde?

Lead: Manhã.

[Tool request_handoff executada — IGOR_05 entra]

Alice: Combinado. Deixei registrado pra equipe te chamar amanhã
       de manhã pelo WhatsApp e continuar seu atendimento.

[Alice silencia. No dia seguinte, atendente liga 9h.]
```

### 13.2 Inbound — Lead pede pessoa direto

```
Lead: Quero falar com alguém.

Alice: Claro. A equipe já encerrou o expediente, mas vou
       encaminhar sua conversa pra retornarem assim que
       possível.

       Qual o melhor período pra te chamarem amanhã?

Lead: Pode ser tarde.

[Tool request_handoff executada]

Alice: Combinado. Vou deixar registrado pra equipe te chamar
       à tarde.
```

### 13.3 Inbound — Documento clínico (compliance)

```
Lead: [envia PDF de exame de sangue]

[IGOR_02 extrai texto → encontra "hemograma" + "CRM" → marca
 safety_flags.clinical=true → should_handoff=true]

[IGOR_03 Compliance Fast-Path bypassa Alice]
[IGOR_05 executa handoff com motivo 'documento_clinico_sensivel']

Alice: Recebi o documento. Pra sua segurança, a equipe do
       Dr. Igor precisa analisar isso diretamente.

       Vou encaminhar sua conversa pro atendimento humano e
       deixar registrado que você enviou o documento.

[Private note pra atendente:
 "Lead enviou PDF de exame contendo hemograma + referência CRM.
  Equipe deve analisar e retornar."]
```

### 13.4 Inbound — Lead manda áudio

```
Lead: [áudio de 30s]

[IGOR_02 transcreve via gpt-4o-transcribe →
 "olá tudo bem? eu queria saber sobre o acompanhamento
  pra emagrecimento, ouvi falar do Dr. Igor por uma amiga
  e estou interessada"]

Alice: Oi, Carla! Sou a Alice, assistente do Dr. Igor.

       Vi aqui que você ouviu falar da gente por uma amiga.
       A equipe já encerrou o expediente, mas posso adiantar
       seu atendimento por aqui.

       Pra começar, qual seu nome completo?

[continua normalmente]
```

### 13.5 Campanha — Caminho Feliz (interesse → handoff)

```
[Dia 1, 10h da manhã — IGOR_10 envia a 1ª mensagem]

Alice: Oi, Ana. Tudo bem?

       Vi aqui que você tinha conversado com a gente sobre
       acompanhamento pra emagrecimento.

       Este mês o Dr. Igor liberou uma condição especial pro
       primeiro atendimento: de R$ 800,00 por R$ 600,00.

       Quer que eu peça pra equipe te chamar e ver um horário?

       Se não quiser receber esse tipo de aviso, é só me falar
       que eu paro por aqui.

[Lead recebe e lê. 2h depois responde.]

Lead: Quero sim.

[IGOR_12 classifica intent='interested' → roteia pra IGOR_13]

Alice: Perfeito. Qual melhor período pra atendente te chamar:
       manhã ou tarde?

Lead: Tarde.

[Tool request_handoff executada — IGOR_05 entra]

Alice: Combinado. Vou deixar registrado pra equipe te chamar
       no período da tarde e ver os horários disponíveis pra
       você aproveitar a condição.

[Atendente recebe notification com private note completa.]
```

### 13.6 Campanha — Lead pergunta preço

```
[Mensagem da campanha já foi enviada]

Lead: Quanto está?

[IGOR_12 classifica intent='price_question' → IGOR_13]

Alice: Este mês o primeiro atendimento está com condição
       especial: de R$ 800,00 por R$ 600,00.

       Vale lembrar que tem um bônus de 1 sessão de T Sculptor
       junto.

       Quer que eu peça pra equipe te chamar e ver um horário?

Lead: Acho que sim.

Alice: Perfeito. Qual melhor período: manhã ou tarde?

Lead: Manhã.

[Handoff executado]

Alice: Combinado. Vou deixar registrado pra equipe te chamar
       no período da manhã.
```

### 13.7 Campanha — Lead não quer

```
Lead: Agora não tenho interesse.

[IGOR_12 classifica intent='not_interested']
[UPDATE campaign_contacts.status='not_interested']
[Aplica label 'promo_nao_interessado']

Alice: Tudo bem. Obrigada por responder. Não vou insistir
       por aqui.

[Conversa encerra. Sem handoff. Sem futuras campanhas
 automáticas pra esse lead nas próximas semanas.]
```

### 13.8 Campanha — Lead pede opt-out

```
Lead: Para de me mandar mensagem.

[Regex determinístico detecta "para de" → match opt-out]
[Ritual de opt-out:
 - UPDATE contacts SET do_not_contact=true
 - UPDATE campaign_contacts SET status='opt_out', optout_at=now()
 - Aplica labels promo_optout + optout, remove promo_eligivel
 - UPDATE conversations SET state='campaign_opt_out'
 - Registra event campaign_opt_out]

Alice: Claro. Vou registrar pra você não receber mais esse
       tipo de mensagem.

[A partir desse momento, esse phone está bloqueado em todos
 os fluxos. IGOR_01 portão 5 vai sempre filtrar.]
```

### 13.9 Campanha — Lead envia exame após receber oferta

```
[Mensagem da campanha foi enviada de manhã]
[À tarde, lead responde com PDF de exame]

Lead: [envia PDF — colesterol alterado]

[IGOR_12: messageType='document' → chama IGOR_02]
[IGOR_02 detecta termos clínicos → safety_flags.clinical=true]
[IGOR_12 classifica intent='sensitive_medical' → IGOR_05]

Alice: Recebi sua mensagem. Vou deixar registrado pra equipe
       humana conversar com você sobre isso com atenção.

[Handoff com priority='high', owner_flow='campaign_promo',
 handoff_reason='sensitive_medical']

[Private note enriquecida:
 "Lead respondeu à campanha promocional com PDF clínico.
  ATENÇÃO: revisar documento antes de contato comercial."]
```

### 13.10 Lead pula entre fluxos (caso raro)

```
[Maio 2026 — lead recebeu campanha, respondeu opt-out]

Lead: para de me mandar
Alice: Claro. Vou registrar pra você não receber mais...

[Julho 2026 — mesmo lead, mensagem espontânea às 23h]

Lead: Oi, mudei de ideia, gostaria de marcar consulta agora.

[IGOR_01 portão 5: contacts.do_not_contact=true → BLOQUEIA]
[Mensagem fica no Chatwoot mas Alice NÃO responde.]
[Atendente humana vê a mensagem nova quando entrar no
 expediente — ela decide se quer reabrir o contato manualmente.]
```

---

## 14. Mapa dos Workflows

### 14.1 Workflows existentes (✅ produção)

| # | Workflow | Tipo | Função | n8n ID |
|---|---|---|---|---|
| 01 | IGOR_01_Inbound_AfterHours | Webhook | Roteador de 12 portões pro fluxo receptivo | `nC6ZhCVNn1fQiKfB` |
| 02 | IGOR_02_Media_Normalizer | Callable | Normaliza áudio/imagem/PDF em texto + safety_flags | `GBmG9WZzW2p8Nn6f` |
| 03 | IGOR_03_Agent_AfterHours | Agent | Alice Acolhedora (LangChain + memória Postgres) | `iQCVbe1P8dC0vhay` |
| 04 | IGOR_04_Tool_Labels_Attributes | Callable | Aplica labels + custom attributes no Chatwoot | `AJF7dhGrqJEXMLqz` |
| 05 | IGOR_05_Finalize_Handoff | Callable | Ritual de handoff pra humano | `N31QcdrNVE5AOZdu` |
| 06 | IGOR_06_Chatwoot_Message_Logger | Webhook | Espelha mensagens + detecta human takeover | `xpXRENR7Hoo2W5p3` |
| 07 | IGOR_07_Error_Logger | ErrorTrigger | Captura erros de todos os workflows | `ZrsbaSTlW5bqMEaS` |
| 08 | IGOR_08_Health_Check | Schedule | Ping de saúde a cada 10min | `cDpDA1QdIH9wHAlN` |
| — | IGOR_AUX_save_lead_partial | Callable (tool) | UPSERT contacts + leads — tool da Alice | `hRogDlGsgQxGwnD8` |
| — | IGOR_AUX_update_conversation_state | Callable (tool) | UPDATE conversation.state — tool da Alice | `mFuRPrGGt7yWVqEw` |
| — | IGOR_TEST_Smoke_Trigger | Manual | Envia ping WhatsApp pro operador | `G8pMteuirc2yZgq5` |

### 14.2 Workflows pendentes (⏳ campanha)

| # | Workflow | Tipo | Função |
|---|---|---|---|
| 09 | IGOR_09_Campaign_Importer | Script Python | `python scripts/import-kommo-csv.py` — importa lista Kommo |
| 10 | IGOR_10_Campaign_Dispatcher | Schedule cron | Envio rate-limited com 7 gates |
| ~~11~~ | ~~IGOR_11_Campaign_Message_Generator~~ | ⛔ **Deferido** | Consolidado inline no IGOR_10 via Edit Fields |
| 12 | IGOR_12_Campaign_Inbound_Handler | Callable | Classifica intent + roteia respostas de campanha |
| 13 | IGOR_13_Agent_Campaign | Agent | Alice Promotora |

### 14.3 Dependências

```
IGOR_01 (router) ─usa→ IGOR_02 (mídia)
                ─usa→ IGOR_03 (Alice Acolhedora)
                ─usa→ IGOR_04 (labels)
                ─usa→ IGOR_12 (quando construído)

IGOR_03 ─tools→ IGOR_04, IGOR_AUX_save_lead_partial,
                IGOR_AUX_update_conversation_state, IGOR_05

IGOR_05 ─usa→ IGOR_04 (labels handoff)

IGOR_06 (Chatwoot webhook) ─usa→ IGOR_04 (label atendimento_humano)

IGOR_07 ← errorTrigger universal (todos os IGOR_*)

IGOR_10 (futuro) ─usa→ IGOR_04 (labels promo_enviada)
                 ─uses→ Evolution sendText (gated)

IGOR_12 (futuro) ─usa→ IGOR_02 (mídia), IGOR_13, IGOR_05

IGOR_13 (futuro) ─tools→ IGOR_04, IGOR_AUX_*, IGOR_05
```

---

## 15. Banco de Dados (Supabase)

### 15.1 Tabelas e quando usar

| Tabela | O que guarda | Quando é tocada |
|---|---|---|
| `contacts` | Registro único de cada pessoa que entrou em contato (phone único) | UPSERT no primeiro contato + qualquer mudança de nome/email |
| `conversations` | Estado de cada conversa (1 por chatwoot_conversation_id) | UPSERT no IGOR_01 + UPDATE em handoff/takeover |
| `leads` | Dados comerciais (objetivo, cidade, callback_period, status comercial) | UPSERT pela tool save_lead_partial da Alice |
| `messages` | Audit trail de toda mensagem (inbound + outbound + agent + human) | UPSERT em todo passo do IGOR_01, IGOR_03, IGOR_06 |
| `events` | Log universal — toda decisão importante vira event | INSERT em ~50 pontos diferentes do sistema |
| `settings` | Configuração runtime (gates, horários, feriados, IDs) | Leitura no início de cada workflow |
| `conversation_summaries` | Resumos cumulativos por conversa (futuro) | Não usado ainda |
| `campaign_runs` | Cabeçalho de cada campanha (oferta, validade, template) | INSERT manual quando lança campanha |
| `campaign_contacts` | 1 linha por (campanha, contato) — guarda status do disparo | INSERT por IGOR_09 + UPDATE por IGOR_10/12 |
| `assignments` | Vínculo lead ↔ atendente (round-robin futuro) | INSERT em handoff (futuro) |

### 15.2 Estados de `conversations.state`

```
new → after_hours_candidate → ai_after_hours → collecting_name →
quick_qualification → collecting_callback_time → handoff_pending →
human_assigned (terminal)

ou

campaign_active → campaign_replied → campaign_interested →
campaign_collecting_callback → campaign_handoff_pending →
campaign_handoff_done (terminal)

terminais especiais: closed, opt_out, compliance_hold
```

### 15.3 Estados de `campaign_contacts.status`

```
queued → sent → delivered → replied → interested → handoff_pending → handoff_done
       ↘                                                              ↗
        skipped     not_interested     opt_out     send_failed
```

---

## 16. Configuração Externa

### 16.1 Onde os valores ficam

| Tipo | Onde fica | Por quê |
|---|---|---|
| URLs (Chatwoot, Evolution, n8n) | **Hardcoded** nos workflows | Container n8n bloqueia env vars; pattern ASX já validado |
| Tokens/API keys | **Credentials no UI n8n** com nomes canônicos | n8n liga automaticamente por nome |
| Gates operacionais (dry_run_send, etc) | Tabela `settings` no Supabase | Mudança sem re-deploy |
| Janela de horário, feriados, holiday_policy | Tabela `settings` | Configurável pela equipe |
| Oferta da campanha (preço, validade) | Tabela `campaign_runs` | Muda entre campanhas |
| Workflow IDs (pra executeWorkflow) | Hardcoded nos JSONs | n8n IDs são estáveis |

### 16.2 As 5 credenciais canônicas

| Nome | Tipo | Usada por |
|---|---|---|
| `igor_chatwoot_api` | httpHeaderAuth | IGOR_04, IGOR_05, IGOR_06, IGOR_08 |
| `igor_evolution_api` | httpHeaderAuth | IGOR_03, IGOR_05, IGOR_08, IGOR_TEST_Smoke, futuro IGOR_10 |
| `igor_openai` | openAiApi | IGOR_02 (audio+vision), IGOR_03 (chat), IGOR_08 (ping), futuro IGOR_13 |
| `igor_supabase_postgres` | postgres | TODOS os workflows |
| `igor_redis_embedded` | redis | IGOR_01 (lock+batch), IGOR_08, futuro IGOR_10 (throttle) |

### 16.3 Chaves importantes em `settings`

| Chave | Default | Significado |
|---|---|---|
| `ai_enabled_global` | true | Kill switch global de IA |
| `workflows_enabled.IGOR_01` | true | Liga/desliga workflow individual |
| `dry_run_send` | true | Bloqueia envio real do Evolution |
| `allow_real_whatsapp_send` | false | Toggle prod/teste |
| `after_hours_start` | "18:30" | Início após-expediente (HH:MM) |
| `after_hours_end` | "07:30" | Fim após-expediente |
| `timezone` | "America/Sao_Paulo" | Pra cálculo de horário |
| `holidays` | [] | Array YYYY-MM-DD |
| `holiday_policy` | "after_hours_force" | Comportamento em feriado |
| `human_team_id` | 1 | Team Chatwoot pra handoff |
| `chatwoot_human_assignee_id` | null | Atendente fixa (null = team-only) |
| `campaign_daily_limit` | 20 | Máximo de disparos campanha por dia |
| `campaign_per_minute_limit` | 1 | Throttle |
| `smoke_test_phone` | null | Phone pro IGOR_TEST_Smoke |

---

## 17. Princípios Arquiteturais Inegociáveis

1. **Harness Engineering** — Decisões críticas (responder ou não, horário, opt-out, handoff) ficam em código determinístico (Code/IF/Switch/SQL/Redis). LLM só para: resposta conversacional, transcrição de áudio, descrição de imagem, classificação semântica de intenção.

2. **NO SIMPLIFICATIONS** — Os specs em `docs/logica-fluxo-igor-*.md` são literais. Se um agente acha que "X é overengineering, vou simplificar", deve **perguntar antes**. Vide débitos históricos em `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md`.

3. **Workflow inativo por padrão** — Todo IGOR_* nasce com `active=false`. Só vai pra produção depois de smoke verde.

4. **errorWorkflow universal** — Todo workflow IGOR_* tem `settings.errorWorkflow = ZrsbaSTlW5bqMEaS` (IGOR_07).

5. **Gates de segurança em settings** — `dry_run_send=true` + `allow_real_whatsapp_send=false` são defaults. Mudança requer UPDATE explícito + confirmação.

6. **Edit Fields > Code node** — Pra transformações declarativas (rename, default, projection, concat), preferir Set node. Code só com justificativa real (regex, parsing JSON com try/catch, APIs específicas como Intl.DateTimeFormat).

7. **JSON canonical é source of truth** — Os `*.sdk.ts` em `n8n/workflows/` são scripts geradores, podem estar dessincronizados. Quem manda é o JSON publicado no n8n.

---

## 18. Estado Atual e Dívida (2026-05-15)

### 18.1 O que está funcionando

- ✅ 7 workflows inbound (IGOR_01-08) publicados e ativos no n8n
- ✅ 2 AUX callables + IGOR_TEST_Smoke ativos
- ✅ 12 migrations Supabase aplicadas
- ✅ Chatwoot configurado (34 labels + 15 custom attrs + team + bot)
- ✅ Evolution Chatwoot Integration habilitada em `convert-teste`
- ✅ Webhook Evolution → /webhook/igor/inbound funcionando
- ✅ Credenciais wired corretamente em todos os workflows
- ✅ 137 leads Kommo importados na base

### 18.2 Dívida conhecida (resolver antes de prod real)

1. **BYPASS de business hours no IGOR_01** — o portão 8 está forçando `inside_business_hours=false` pra smoke. Comentário inline: `/* BYPASS smoke test 2026-05-15 */`. Reverter antes de ligar IA real.

2. **SDK files dessincronizados** com JSON canonical em IGOR_03 e IGOR_05 (subagent não adicionou node "Load Gates" ao SDK). JSON é source of truth — o SDK precisa ser regerado ou removido.

3. **IGOR_TEST_Smoke pattern questionado** — você sugeriu trocar de "ping pro operador" pra "simular inbound" (POST direto no /webhook/igor/inbound com payload Evolution fake). Refazer se for o caso.

4. **Migration 010** (settings_gates) — não confirmada aplicada, mas não bloqueia (Load Gates tem COALESCE com defaults seguros).

5. **Fluxo Campanha (IGOR_09-13)** — zero código. Só desenho. IGOR_11 oficialmente deferido (consolidado em IGOR_10).

### 18.3 Próximos passos (sugeridos)

```
1. Reverter BYPASS do portão 8 (vai ficar fora-de-uso em horário comercial)
2. Smoke real com dry_run_send=true + lead de teste (você)
3. Confirmar dry_run flow funciona end-to-end
4. UPDATE settings: allow_real_whatsapp_send=true em ambiente test
5. Smoke real com WhatsApp send → checa Chatwoot, Supabase, labels
6. Migrar Evolution instance pra dr.igor (prod) com find/replace nos JSONs
7. Construir IGOR_09 (script Python) → executar com 5 leads de teste
8. Construir IGOR_10, IGOR_12, IGOR_13 em sequência
```

---

## 19. Glossário

| Termo | Significado |
|---|---|
| **Lead** | Pessoa que entrou em contato com o Instituto Dr. Igor (espontâneo ou via campanha) |
| **Alice** | Nome da assistente virtual. Dois papéis: Acolhedora (inbound) e Promotora (campanha) |
| **Handoff** | Transferência da conversa da Alice pra atendente humana |
| **Callback period** | Melhor período pra atendente retornar (manhã/tarde/noite) |
| **Opt-out** | Lead pediu pra parar de receber mensagens. Prioridade máxima |
| **Compliance Fast-Path** | Bypass da Alice quando IGOR_02 detecta mídia clínica/sensível |
| **Human takeover** | Atendente humana enviou mensagem → IA é travada nessa conversa |
| **Inbox** | Caixa de entrada do Chatwoot. "Igor After Hours" é a única ativa (id=1) |
| **Label** | Etiqueta aplicada na conversa do Chatwoot (ex: `handoff_done`, `optout`) |
| **Custom attribute** | Campo personalizado no Chatwoot (separado pra conversation e contact) |
| **Private note** | Nota interna no Chatwoot — atendente vê, lead não vê |
| **Callable** | Workflow auxiliar acionado por `executeWorkflow` (não tem webhook próprio) |
| **Batching** | Agrupamento de mensagens fragmentadas do WhatsApp em uma janela de 3s |
| **Lock distribuído** | Redis INCR + EXPIRE 30s pra garantir só 1 processamento por phone |
| **Dry run** | Modo seguro — IA executa todo o pipeline mas NÃO chama Evolution sendText. Só loga |
| **Gates** | Flags em `settings` que controlam comportamento (dry_run, allow_real, etc) |
| **Evolution API** | Middleware que conecta WhatsApp ↔ Chatwoot ↔ n8n |
| **Chatwoot** | CRM operacional onde a atendente humana trabalha |
| **Supabase** | Banco de dados principal (Postgres cloud) |
| **Redis** | Sistema de filas/locks temporários, embarcado no container n8n |
| **`ai_enabled`** | Flag que permite ou bloqueia resposta da IA na conversa |
| **`human_locked`** | Flag que indica atendimento humano ativo nessa conversa |
| **`do_not_contact`** | Flag no contato que indica opt-out global |
| **session_key** | Identifica memória persistente da Alice no Postgres (ex: `after_hours_{phone}`) |
| **Score** | Pontuação 0-100 do lead (futuro, não usado ainda no Igor) |

---

## 20. Apêndice Técnico (Referência Curta)

### 20.1 IDs canônicos n8n + tamanho

| Workflow | n8n ID | Nodes |
|---|---|---|
| IGOR_01_Inbound_AfterHours | `nC6ZhCVNn1fQiKfB` | 59 |
| IGOR_02_Media_Normalizer | `GBmG9WZzW2p8Nn6f` | 27 |
| IGOR_03_Agent_AfterHours | `iQCVbe1P8dC0vhay` | 26 |
| IGOR_04_Tool_Labels_Attributes | `AJF7dhGrqJEXMLqz` | 21 |
| IGOR_05_Finalize_Handoff | `N31QcdrNVE5AOZdu` | 24 |
| IGOR_06_Chatwoot_Message_Logger | `xpXRENR7Hoo2W5p3` | 17 |
| IGOR_07_Error_Logger | `ZrsbaSTlW5bqMEaS` | 2 |
| IGOR_08_Health_Check | `cDpDA1QdIH9wHAlN` | 21 |
| IGOR_AUX_save_lead_partial | `hRogDlGsgQxGwnD8` | 6 |
| IGOR_AUX_update_conversation_state | `mFuRPrGGt7yWVqEw` | 6 |
| IGOR_TEST_Smoke_Trigger | `G8pMteuirc2yZgq5` | 6 |

### 20.2 URLs hardcoded

```
Chatwoot:  https://chat.almaconvert.com.br/api/v1/accounts/2/...
Evolution: https://evo.almaconvert.com.br/{message|chat|instance}/.../convert-teste
n8n:       https://n8n.almaconvert.com.br
OpenAI:    https://api.openai.com/v1/{audio/transcriptions|chat/completions|models}
```

### 20.3 Chaves Redis usadas

```
igor:lock:inbound:{phone}     # 30s — lock distribuído IGOR_01
igor:batch:{phone}             # 60s — fila de fragmentos
igor:batch:marker:{phone}      # 60s — proxy de TTL pra LIST
igor:campaign:lastSentAt       # rolling — throttle do IGOR_10 (futuro)
```

### 20.4 Documentos relacionados

- **Spec funcional inbound**: `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
- **Spec funcional campanha**: `docs/logica-fluxo-igor-agente-ativo-promocao.md`
- **Plano operacional**: `docs/IMPLEMENTATION_PLAN.md`
- **Runbook**: `docs/RUNBOOK.md`
- **Status atual**: `docs/VALIDATION_REPORT.md`
- **Apresentação visual**: `docs/ARCHITECTURE.html` (renderização interativa deste doc)
- **Referência ASX**: `docs/referencias/workflows-asx/` (pattern técnico, não copiar regras)

---

## 21. Changelog

| Data | Evento |
|---|---|
| 2026-05-14 | Fase 0+1+2: audit, plan, 7 migrations, Chatwoot seed, Kommo CSV import (137 leads) |
| 2026-05-15 manhã | Fase A reset + Fase B rebuild 7 workflows inbound |
| 2026-05-15 tarde | Fase C wiring + reviews + IGOR_TEST_Smoke + migration 012 |
| 2026-05-15 noite | Decisão: IGOR_11 deferido (consolidado em IGOR_10) |
| 2026-05-15 noite | Rewrite deste documento em estilo narrativo (jornada + comportamento + exemplos), abandonando formato node-by-node |
