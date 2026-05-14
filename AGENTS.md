# AGENTS.md — Instituto Dr. Igor

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

Não copie regras comerciais, prompts, nomes, IDs, tabelas específicas, credenciais, mensagens reais, telefones reais ou problemas conhecidos da ASX.

## Nomes canônicos dos workflows

Use exatamente estes nomes:

- `IGOR_01_Inbound_AfterHours`
- `IGOR_02_Media_Normalizer`
- `IGOR_03_Agent_AfterHours`
- `IGOR_04_Tool_Labels_Attributes`
- `IGOR_05_Finalize_Handoff`
- `IGOR_06_Chatwoot_Message_Logger`
- `IGOR_07_Error_Logger`
- `IGOR_08_Health_Check`
- `IGOR_09_Campaign_Importer`
- `IGOR_10_Campaign_Dispatcher`
- `IGOR_11_Campaign_Message_Generator`
- `IGOR_12_Campaign_Inbound_Handler`
- `IGOR_13_Agent_Campaign`

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
├── AGENTS.md
├── CLAUDE.md
├── CODEX.md
├── .env.example
├── .gitignore
├── docs/
│   ├── logica-fluxo-igor-receptivo-fora-expediente.md
│   ├── logica-fluxo-igor-agente-ativo-promocao.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── RUNBOOK.md
│   ├── VALIDATION_REPORT.md
│   ├── ENVIRONMENT.md
│   └── referencias/
│       └── workflows-asx/
├── n8n/
│   ├── workflows/
│   ├── exports/
│   └── backups/
├── supabase/
│   └── migrations/
├── chatwoot/
│   └── scripts/
├── evolution/
│   └── scripts/
├── fixtures/
├── scripts/
└── reports/
```

A pasta `n8n/workflows/` deve conter apenas workflows novos do Igor.

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

Arquivos esperados:

```text
001_core_schema.sql
002_indexes_constraints.sql
003_settings_seed.sql
004_campaign_schema.sql
005_rls_policies.sql
```

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

Comece lendo os documentos, validando o repositório e criando ou atualizando:

1. `docs/IMPLEMENTATION_PLAN.md`
2. `reports/api-discovery.md`
3. `.env.example`
4. `.gitignore`
5. estrutura de pastas

Depois apresente o plano e a lista de informações faltantes antes de executar mutações reais nos serviços.
