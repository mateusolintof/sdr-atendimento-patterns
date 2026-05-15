# AGENTS.md — Instituto Dr. Igor

> **Single source of truth.** `CLAUDE.md` é um symlink para este arquivo; `CODEX.md` aponta para ele. Qualquer agente (Claude Code, Codex, Cursor) deve ler este documento. Edições feitas via atalho `#` em sessões Claude caem aqui.

## Missão

Você é o agente de engenharia responsável por implementar, validar e documentar o novo sistema de automação do Instituto Dr. Igor.

O projeto usa:

- n8n self-hosted em VPS Ubuntu via Portainer
- Chatwoot self-hosted em VPS Ubuntu via Portainer
- Evolution API em VPS Ubuntu via Portainer
- Supabase Cloud
- Redis disponível no ambiente do n8n
- APIs dos serviços para criação, auditoria, teste e validação

Não use Docker Compose como caminho de implementação. Os serviços reais já existem no Portainer e no Supabase Cloud. A implementação deve acontecer por workflows n8n, migrations SQL, scripts, fixtures, documentação e chamadas controladas às APIs.

## Quick start (comandos)

Todos os scripts são read-only por padrão. Mutações exigem flags em `.env`.

```bash
bash scripts/validate-env.sh                # valida presença das vars canônicas (sem imprimir valores)
bash scripts/discover.sh --dry-run          # descoberta read-only dos serviços; saída mascarada em scripts/reports/
bash scripts/discover.sh                    # mesmo, executando GETs reais (ainda read-only)
bash scripts/seed-chatwoot.sh               # cria/garante labels, custom_attrs e team_bot no Chatwoot
bash scripts/import-workflow.sh <file.json> # importa um IGOR_*.json para o n8n (workflow entra inativo)
bash scripts/test-workflow.sh <id>          # smoke test de um workflow já importado
bash scripts/test-block.sh                  # roda a bateria de fixtures contra workflows ativos
bash scripts/mask-secrets.sh <file>         # mascara segredos em qualquer arquivo de log/relatório
python scripts/import-kommo-csv.py          # importa leads do Kommo (lista-leads/*.csv) → Supabase
```

Para operações em n8n prefira o MCP server `n8n-mcp` (configurado em `.mcp.json`) — use `search_workflows`, `get_workflow_details`, `validate_workflow`, `create_workflow_from_code`, `update_workflow`. Para Supabase use as migrations versionadas em `supabase/migrations/`, aplicadas manualmente no Studio quando a execução direta estiver bloqueada.

## Estado atual da implementação

Antes de propor mudanças, consulte os documentos vivos:

- `docs/IMPLEMENTATION_PLAN.md` — plano operacional consolidado (workflows, migrations, fixtures, testes).
- `docs/VALIDATION_REPORT.md` — o que está implementado, IDs no n8n, falhas e pendências.
- `docs/RUNBOOK.md` — smoke runbook e procedimentos operacionais.
- `docs/WORKFLOW_PLAN.md` — sequência de waves e dependências dos workflows.
- `reports/api-discovery.md` — inventário read-only mais recente dos serviços.
- `docs/superpowers/debt/` — registro de débitos técnicos pendentes (simplificações a reverter, etc.).

## Fonte de verdade

A lógica funcional do projeto está exclusivamente nestes arquivos:

1. `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
2. `docs/logica-fluxo-igor-agente-ativo-promocao.md`

Este arquivo define como implementar, validar e proteger a execução.

As referências técnicas da ASX ficam em:

`docs/referencias/workflows-asx/`

Use essas referências apenas para entender padrões técnicos de stack:

- webhook Evolution API
- normalização de payload
- Redis batching
- workflows callable
- Agent Tools
- handoff
- labels
- custom attributes
- logger
- health check
- integração Chatwoot/Evolution/n8n/Supabase

**Para mais informações e conhecimento dos serviços e integrações, use o context7 para buscar a documentação referente às versões dos serviços implementados**

- Para integração Evolution API + Chatwoot, veja documentação no link: https://doc.evolution-api.com/v2/pt/integrations/chatwoot
- Para conhecimento do N8N, invoque as skills /n8n-expression-syntax e /n8n-workflow-patterns e /n8n-mcp-tools-expert, /n8n-validation-expert, /n8n-node-configuration  e use também a documentacao oficial caso as skills nao deem tudo que voce precisa de conhecimento.
    - Veja documentação oficial: https://docs.n8n.io/" 


## Nomes canônicos dos workflows

Use exatamente estes nomes. Marcadores indicam o status atual no repositório (verifique `docs/VALIDATION_REPORT.md` para o status no n8n).

**Receptivo fora de expediente — implementados (`n8n/workflows/IGOR_0*.json` + `*.sdk.ts`):**

- `IGOR_01_Inbound_AfterHours` ✅
- `IGOR_02_Media_Normalizer` ✅
- `IGOR_03_Agent_AfterHours` ✅
- `IGOR_04_Tool_Labels_Attributes` ✅
- `IGOR_05_Finalize_Handoff` ✅
- `IGOR_06_Chatwoot_Message_Logger` ✅
- `IGOR_07_Error_Logger` ✅
- `IGOR_08_Health_Check` ✅

**Campanha ativa — pendentes (fase 2):**

- `IGOR_09_Campaign_Importer` ⏳
- `IGOR_10_Campaign_Dispatcher` ⏳
- `IGOR_11_Campaign_Message_Generator` ⏳
- `IGOR_12_Campaign_Inbound_Handler` ⏳
- `IGOR_13_Agent_Campaign` ⏳

**Helpers internos (não canônicos, prefixo `IGOR_AUX_`/`IGOR_TEST_`):**

- `IGOR_AUX_save_lead_partial` — subworkflow callable para persistência parcial de leads.
- `IGOR_AUX_update_conversation_state` — subworkflow callable para atualizar estado da conversa.
- `IGOR_TEST_Failing_Workflow`, `IGOR_TEST_Trampoline` — fixtures para validar error logger e callable pattern. Nunca ativar em produção.

Use underscore em nomes técnicos. Não misture hífen e underscore.

## Princípio arquitetural

Implemente como Harness Engineering.

Regras determinísticas ficam em Code nodes, IF, Switch, SQL, Redis locks, validações explícitas e subworkflows callable.

A LLM pode ser usada para:

- resposta conversacional
- resumo
- extração semântica
- classificação estruturada
- geração de mensagem personalizada

A LLM não decide sozinha:

- se deve responder
- se está dentro ou fora do expediente
- se uma conversa está travada por humano
- se existe opt-out
- se pode enviar campanha
- se pode alterar labels
- se pode executar handoff
- se pode enviar WhatsApp real
- se pode alterar produção

## Segurança de credenciais e produção

O repositório deve conter:

- `.env.example`
- `.gitignore`
- documentação das variáveis
- scripts que mascarem segredos em logs e relatórios

O arquivo real de ambiente deve ficar fora do Git.

Nunca imprima tokens, API keys, passwords, connection strings completas ou service role keys.

Flags de segurança esperadas:

```env
IGOR_ENV=staging
IGOR_DRY_RUN=true
ALLOW_REAL_WHATSAPP_SEND=false
ALLOW_PRODUCTION_MUTATIONS=false
```

Comportamento padrão:

- não enviar WhatsApp real
- não ativar webhooks reais
- não ativar workflows em produção
- não apagar workflows existentes
- não sobrescrever recursos existentes sem backup
- não alterar workflows ASX
- não fazer update direto no banco interno do Chatwoot

Envio real de WhatsApp só pode acontecer quando `ALLOW_REAL_WHATSAPP_SEND=true` e houver número de teste autorizado pelo usuário.

Mutações em serviços reais só podem acontecer quando `ALLOW_PRODUCTION_MUTATIONS=true` e houver aprovação explícita do usuário para a fase em execução.

## Estrutura esperada do repositório

```text
.
├── README.md
├── AGENTS.md                # fonte de verdade para agentes
├── CLAUDE.md                # symlink → AGENTS.md
├── CODEX.md                 # pointer doc → AGENTS.md
├── .env / .env.example      # .env real fica fora do Git
├── .gitignore
├── .mcp.json                # config do n8n-mcp (sem segredos hardcoded; usar ${N8N_MCP_TOKEN})
├── docs/
│   ├── logica-fluxo-igor-receptivo-fora-expediente.md
│   ├── logica-fluxo-igor-agente-ativo-promocao.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── WORKFLOW_PLAN.md
│   ├── RUNBOOK.md
│   ├── VALIDATION_REPORT.md
│   ├── ENVIRONMENT.md
│   ├── referencias/workflows-asx/   # referência técnica — não copiar regras comerciais
│   ├── superpowers/                 # plans, debt registry, contracts
│   └── workflows/                   # specs por workflow
├── n8n/
│   ├── workflows/                   # IGOR_*.json + *.sdk.ts (single-file workflow SDK)
│   ├── exports/                     # exports gerados via API
│   └── backups/                     # snapshots antes de overwrite
├── supabase/migrations/             # SQL idempotente, aplicado no Supabase Studio
├── chatwoot/scripts/                # auxiliares de seeding
├── evolution/scripts/               # auxiliares de webhook
├── fixtures/                        # payloads de teste (texto, áudio, imagem, opt-out, campanha)
├── scripts/                         # validate-env, discover, import/export, smoke tests
├── tests/                           # suites contra fixtures
├── lista-leads/                     # CSVs do Kommo (input para import-kommo-csv.py)
├── reports/                         # saídas read-only (api-discovery.md, env-validation.md)
└── archives/                        # históricos imutáveis
```

A pasta `n8n/workflows/` deve conter apenas workflows novos do Igor. Workflows ASX, quando existirem na instância, são intocáveis.

## Fases de implementação

### Fase 0 — Auditoria inicial

1. Ler `AGENTS.md`, `CODEX.md`, `CLAUDE.md` e os dois arquivos de lógica.
2. Ler as referências técnicas da ASX em `docs/referencias/workflows-asx/`.
3. Validar estrutura do repositório.
4. Validar presença das variáveis de ambiente sem imprimir valores.
5. Fazer descoberta read-only nos serviços quando houver credenciais.
6. Criar ou atualizar `reports/api-discovery.md`.
7. Não executar mutações.

### Fase 1 — Plano

Criar `docs/IMPLEMENTATION_PLAN.md` com:

- resumo do objetivo
- arquitetura proposta
- workflows a criar
- subworkflows/tools
- migrations Supabase
- labels Chatwoot
- custom attributes Chatwoot
- fixtures
- scripts
- ordem de implementação
- riscos
- decisões pendentes
- informações faltantes
- plano de testes
- critérios para avançar de read-only para implementação

### Fase 2 — Supabase

Criar migrations SQL idempotentes em:

```text
supabase/migrations/
```

Arquivos existentes (aplicados em ordem; idempotentes):

```text
001_core_schema.sql
002_indexes_constraints.sql
003_settings_seed.sql
004_campaign_schema.sql
005_rls_policies.sql
006_campaign_seed_2026-05.sql      # seed dos contatos da campanha vigente
007_asserts_rpc.sql                # RPCs de validação usadas pelos workflows
008_messages_msgid_unique.sql      # constraint de unicidade para dedup de mensagens
```

Para novas migrations, mantenha numeração sequencial e idempotência (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

As migrations devem criar ou ajustar:

- `contacts`
- `conversations`
- `leads`
- `messages`
- `events`
- `settings`
- `conversation_summaries`
- `campaign_runs`
- `campaign_contacts`
- `assignments`

Use UUIDs, `created_at`, `updated_at`, índices, constraints, queries parametrizadas e comandos idempotentes.

Se a execução direta estiver bloqueada, gere o SQL e solicite que o usuário execute no Supabase. Depois valide o resultado por leitura.

### Fase 3 — Chatwoot

Configurar por API:

- labels
- custom attributes de contato
- custom attributes de conversa
- teams
- agents
- private notes
- assignment de conversa

Nunca apagar labels existentes.

Aplicação de labels deve buscar labels atuais, mesclar e reenviar o conjunto completo.

### Fase 4 — n8n

1. Criar JSONs dos workflows `IGOR_*`.
2. Criar todos os workflows inicialmente inativos.
3. Não sobrescrever workflows existentes sem backup.
4. Configurar credentials por nome.
5. Não hardcodar segredos.
6. Importar por API quando autorizado.
7. Exportar backup para `n8n/backups/`.

### Fase 5 — Evolution API

1. Verificar instância.
2. Validar integração com Chatwoot.
3. Validar webhook atual.
4. Configurar webhook novo após aprovação da fase.
5. Testar com fixtures antes de tráfego real.

### Fase 6 — Testes

Criar fixtures e smoke tests para:

- texto
- áudio
- imagem
- documento
- `fromMe=true`
- telefone inválido
- mensagem fora do expediente
- mensagem dentro do expediente
- `human_locked=true`
- `ai_enabled=false`
- opt-out
- handoff
- campanha elegível
- campanha bloqueada
- resposta interessada
- resposta negativa
- rota `unknown`
- mídia sensível
- documento clínico

### Fase 7 — Relatório final

Criar `docs/VALIDATION_REPORT.md` com:

- o que foi criado
- IDs dos workflows
- status ativo/inativo
- tabelas criadas
- labels criadas
- custom attributes criados
- webhooks configurados
- testes executados
- falhas encontradas
- pendências
- instruções para ativação em produção

## Regras críticas de negócio

### Receptivo fora de expediente

- IA responde apenas fora do expediente humano.
- IA faz acolhimento e qualificação curta.
- IA coleta melhor horário/período para retorno.
- IA não agenda diretamente.
- IA não promete disponibilidade.
- IA faz handoff para humano e para de responder.

### Campanha ativa

- Campanha só envia para leads elegíveis.
- Campanha respeita opt-out e `do_not_contact`.
- Campanha usa preço e validade configurados em banco.
- Campanha não afirma que a mensagem foi escrita manualmente por humano.
- Campanha não promete resultado clínico.
- Campanha faz handoff quando houver interesse, pedido de humano ou caso sensível.

### Opt-out

Opt-out tem prioridade máxima.

Ao detectar pedido de parada:

1. marcar `contacts.do_not_contact=true`
2. marcar `contacts.consent_marketing=false`
3. atualizar campanha, quando houver
4. aplicar labels de opt-out
5. registrar evento
6. responder confirmação curta
7. bloquear novos disparos

### Handoff

`IGOR_05_Finalize_Handoff` deve ser chamado antes da mensagem final ao lead.

Após handoff:

- `ai_enabled=false`
- `human_locked=true`
- aplicar `handoff_done`
- criar private note
- atribuir conversa ao time/atendente
- registrar evento
- IA não responde mais

### Mídia e saúde

O sistema não interpreta clinicamente exames, laudos, prescrições, imagens do corpo, antes/depois sensível ou documentos médicos.

Nesses casos:

- marcar compliance
- criar resumo seguro
- fazer handoff
- parar IA após handoff

## Informações que você deve solicitar se faltarem

Solicite objetivamente:

- `N8N_BASE_URL`
- `N8N_API_KEY`
- `CHATWOOT_BASE_URL`
- `CHATWOOT_API_TOKEN`
- `CHATWOOT_ACCOUNT_ID`
- `CHATWOOT_INBOX_ID`
- `CHATWOOT_HUMAN_TEAM_ID`
- `CHATWOOT_HUMAN_ASSIGNEE_ID`
- nome da atendente humana
- `EVOLUTION_BASE_URL`
- `EVOLUTION_API_KEY`
- `EVOLUTION_INSTANCE_NAME`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- string de conexão Postgres
- Redis host/credential quando não estiver disponível no n8n
- OpenAI/Gemini keys para áudio, imagem, documento e geração conversacional
- horário oficial do atendimento humano
- timezone
- preço regular e promocional vigentes
- validade da campanha
- limites de envio
- número de WhatsApp de teste autorizado
- mídia aprovada para campanha
- política final de opt-out/consentimento

## Critérios de aceite

A implementação está pronta quando:

1. Todos os workflows `IGOR_*` existem em JSON no repositório.
2. Workflows foram importados ou há instrução exata de importação.
3. Migrations Supabase existem e foram validadas.
4. Labels e custom attributes Chatwoot foram criados ou há script pronto.
5. Evolution webhook está documentado e testado em modo seguro.
6. Dry-run impede envio real.
7. Fixtures cobrem texto, áudio, imagem, documento, fromMe, opt-out, handoff e campanha.
8. Handoff desliga IA.
9. Health check identifica falhas críticas.
10. Nenhum segredo foi commitado.
11. Nenhum recurso ASX foi alterado.
12. Foi entregue relatório final com pendências e próximos passos.

## Condutas proibidas

Não faça:

- commitar `.env` real
- imprimir segredos
- apagar workflows existentes
- alterar workflows ASX
- enviar WhatsApp real sem autorização
- ativar campanha real sem autorização
- configurar webhook real sem autorização
- atualizar banco interno do Chatwoot diretamente
- criar nova conversa se já existe conversa ativa
- deixar rota `unknown` sem tratamento
- usar SQL dinâmico inseguro
- permitir IA responder após humano
- permitir IA responder após opt-out
- interpretar exames ou documentos clínicos

## Primeira ação obrigatória

Antes de qualquer mutação:

1. Ler `docs/logica-fluxo-igor-receptivo-fora-expediente.md` e `docs/logica-fluxo-igor-agente-ativo-promocao.md`.
2. Verificar estado atual em `docs/VALIDATION_REPORT.md` e `docs/IMPLEMENTATION_PLAN.md` — não duplicar trabalho já feito.
3. Rodar `bash scripts/validate-env.sh` para confirmar presença das variáveis em `.env`.
4. Rodar `bash scripts/discover.sh --dry-run` (ou sem flag) para inventariar serviços de forma read-only — saída mascarada em `scripts/reports/`.
5. Listar informações faltantes (ver seção "Informações que você deve solicitar se faltarem") e apresentar o plano antes de tocar produção.

Mutações em serviços reais só após `ALLOW_PRODUCTION_MUTATIONS=true` em `.env` **e** aprovação explícita do usuário para a fase em execução.
