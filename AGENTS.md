# AGENTS.md — Instituto Dr. Igor

> **Single source of truth para regras de trabalho.** `CLAUDE.md` é um symlink para este arquivo; `CODEX.md` aponta para ele. Qualquer agente (Claude Code, Codex, Cursor) deve ler este documento. Edições feitas via atalho `#` em sessões Claude caem aqui.
>
> Para arquitetura técnica (topologia, IDs, fluxos detalhados), leia `docs/ARCHITECTURE.md`.

## Missão

Você é o agente de engenharia responsável por implementar, validar e documentar o sistema de automação do Instituto Dr. Igor.

O projeto usa:

- n8n self-hosted em VPS Ubuntu via Portainer
- Chatwoot self-hosted em VPS Ubuntu via Portainer
- Evolution API em VPS Ubuntu via Portainer
- Supabase Cloud
- Redis embarcado no n8n
- APIs dos serviços para criação, auditoria, teste e validação

Não use Docker Compose como caminho de implementação. Os serviços já existem no Portainer e no Supabase Cloud. A implementação acontece por workflows n8n, migrations SQL, scripts e chamadas controladas às APIs.

## Quick start (comandos)

```bash
bash scripts/discover.sh --dry-run          # descoberta read-only dos serviços
bash scripts/discover.sh                    # mesmo, executando GETs reais
bash scripts/seed-chatwoot.sh               # cria/garante labels, custom_attrs, team_bot no Chatwoot
bash scripts/import-workflow.sh <file.json> # importa um IGOR_*.json para o n8n (workflow entra inativo)
bash scripts/test-workflow.sh <id>          # smoke test de um workflow já importado
bash scripts/mask-secrets.sh <file>         # mascara segredos em qualquer arquivo de log/relatório
python scripts/import-kommo-csv.py          # importa leads do Kommo (lista-leads/*.csv) → Supabase
```

Para operações em n8n prefira o MCP server `n8n-mcp` — use `search_workflows`, `get_workflow_details`, `validate_workflow`, `create_workflow_from_code`, `update_workflow`, `publish_workflow`, `unpublish_workflow`. Para Supabase use as migrations versionadas em `supabase/migrations/`, aplicadas manualmente no Studio.

## Estado atual da implementação

Consulte sempre antes de propor mudanças:

- `docs/ARCHITECTURE.md` — fonte de verdade arquitetural (topologia, IDs n8n, fluxos node-by-node, dívida).
- `docs/IMPLEMENTATION_PLAN.md` — contratos por workflow IGOR_*.
- `docs/VALIDATION_REPORT.md` — status real (workflows, migrations, integrações, dívida).
- `docs/RUNBOOK.md` — procedimentos operacionais.
- `docs/logica-fluxo-igor-receptivo-fora-expediente.md` — spec funcional do inbound.
- `docs/logica-fluxo-igor-agente-ativo-promocao.md` — spec funcional do disparo.

## Credenciais

**Credenciais reais vivem em `.claude/CREDENCIAIS.md`** (gitignored). O agente consulta esse arquivo para saber URLs, tokens e instâncias. Nenhuma aplicação carrega o conteúdo dele — é referência visual.

**n8n credentials** (API keys, tokens) são criadas via UI do n8n com nomes canônicos. Workflows referenciam por nome — n8n liga automaticamente.

| Nome canônico | Tipo | Header / Conn |
|---------------|------|---------------|
| `igor_chatwoot_api` | httpHeaderAuth | `api_access_token` |
| `igor_evolution_api` | httpHeaderAuth | `apikey` |
| `igor_openai` | openAiApi | Bearer |
| `igor_supabase_postgres` | postgres | session pooler |
| `igor_redis_embedded` | redis | local |

## Fonte de verdade funcional

A lógica funcional do projeto está exclusivamente em:

1. `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
2. `docs/logica-fluxo-igor-agente-ativo-promocao.md`

Em caso de conflito entre código e esses documentos, o documento prevalece (exceto para nomes canônicos dos workflows, fixados aqui).

Referências técnicas da ASX ficam em `docs/referencias/workflows-asx/` — use apenas para entender padrões de stack (webhook Evolution, Redis batching, callables, agent tools, handoff, labels, Chatwoot integration). **Não copie regras comerciais, prompts, IDs, telefones ou problemas conhecidos da ASX.**

**Para conhecimento técnico atualizado**:
- Integração Evolution + Chatwoot: https://doc.evolution-api.com/v2/pt/integrations/chatwoot
- n8n: skills `n8n-expression-syntax`, `n8n-workflow-patterns`, `n8n-mcp-tools-expert`, `n8n-validation-expert`, `n8n-node-configuration` + https://docs.n8n.io/
- Use `context7` MCP para fetch da doc de qualquer biblioteca/SDK quando necessário.

## Nomes canônicos dos workflows

**Receptivo fora de expediente — implementados (`n8n/workflows/IGOR_0*.json` + `*.sdk.ts`):**

- `IGOR_01_Inbound_AfterHours` ✅
- `IGOR_02_Media_Normalizer` ✅
- `IGOR_03_Agent_AfterHours` ✅
- `IGOR_04_Tool_Labels_Attributes` ✅
- `IGOR_05_Finalize_Handoff` ✅
- `IGOR_06_Chatwoot_Message_Logger` ✅
- `IGOR_07_Error_Logger` ✅
- `IGOR_08_Health_Check` ✅

**Campanha ativa — pendentes (Frente Campanha):**

- `IGOR_09_Campaign_Importer` — script Python local (já existe em `scripts/import-kommo-csv.py`)
- `IGOR_10_Campaign_Dispatcher` ⏳
- `IGOR_11_Campaign_Message_Generator` — **deferido**, consolidado inline no IGOR_10 via Edit Fields (decisão 2026-05-15)
- `IGOR_12_Campaign_Inbound_Handler` ⏳
- `IGOR_13_Agent_Campaign` ⏳

**Helpers internos:**

- `IGOR_AUX_save_lead_partial` — callable usado como tool pelo IGOR_03.
- `IGOR_AUX_update_conversation_state` — callable usado como tool pelo IGOR_03.
- `IGOR_TEST_Failing_Workflow`, `IGOR_TEST_Trampoline` — fixtures para validar IGOR_07 (errorTrigger pattern). Nunca ativar em produção.
- `IGOR_TEST_Smoke_Trigger` — manual trigger que dispara WhatsApp pro número configurado em `settings.smoke_test_phone` (usado em smoke real).

Use underscore em nomes técnicos. Não misture hífen e underscore.

## Princípio arquitetural

**Harness Engineering.** Regras determinísticas em Code/IF/Switch/SQL/Redis-locks/callables. A LLM pode ser usada para:

- resposta conversacional
- resumo
- extração semântica
- classificação estruturada
- geração de mensagem personalizada

**A LLM não decide sozinha** se deve responder, se está dentro ou fora do expediente, se uma conversa está travada por humano, se existe opt-out, se pode enviar campanha, se pode alterar labels, se pode executar handoff, se pode enviar WhatsApp real, se pode alterar produção.

**Preferência por Edit Fields (Set) sobre Code node** para transformações declarativas (rename, default, projeção, concatenação). Code só com justificativa real (regex, parsing JSON com try/catch, manipulação de arrays, APIs n8n não expostas em Set como `Intl.DateTimeFormat`).

## ⚠️ PROIBIDO em workflows n8n

1. **`={{ $env.X }}`** — container n8n bloqueia por `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`. Em runtime aparece `[ERROR: access to env vars denied]` → workflow falha.
2. **`={{ $vars.X }}`** — Variables é feature Enterprise-only; não funciona em self-hosted Community.

**Onde os valores vão:**

| Tipo de valor | Onde fica |
|---------------|-----------|
| Credentials (API keys, tokens) | UI do n8n → referenciado por nome no node |
| URLs / IDs / instance names | Hardcoded no node parameter (pattern ASX em produção) |
| Gates operacionais (`dry_run_send`, `allow_real_whatsapp_send`) | Tabela `settings` no Supabase — `Postgres "Load Gates"` no início do workflow |
| Configs de negócio (business hours, holidays, workflows_enabled) | Tabela `settings` no Supabase |

Para prod/test swap (instância Evolution): find/replace no JSON local + re-PUT via REST ou via `mcp__n8n-mcp__update_workflow`.

**Antes de declarar qualquer workflow pronto**: grep por `$env\.` no JSON e SDK. Hits = bug.

## Segurança e gates

- `.claude/CREDENCIAIS.md` é gitignored. Nunca commitar segredos.
- Workflows nascem inativos (`active: false`). Ativação após smoke verde.
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07) em todos os workflows IGOR_*.
- Gates seguros default em `settings`:
  - `dry_run_send=true` → bloqueia Evolution `sendText`.
  - `allow_real_whatsapp_send=false` → impede envio real.
  - `ai_enabled_global=true` por padrão; kill switch em `false` pausa Igor inteiro.
  - `workflows_enabled.IGOR_XX` controla cada workflow individual.

Envio real de WhatsApp só ocorre quando `settings.allow_real_whatsapp_send=true` AND `settings.dry_run_send=false`, e o número de teste autorizado pelo usuário está confirmado.

## Estrutura do repositório

```text
.
├── README.md
├── AGENTS.md                # fonte de verdade para regras (este arquivo)
├── CLAUDE.md                # symlink → AGENTS.md
├── CODEX.md                 # pointer doc → AGENTS.md
├── .gitignore
├── .mcp.json                # config do n8n-mcp
├── .claude/
│   ├── CREDENCIAIS.md       # credenciais (gitignored)
│   ├── settings.json
│   └── settings.local.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── RUNBOOK.md
│   ├── VALIDATION_REPORT.md
│   ├── logica-fluxo-igor-receptivo-fora-expediente.md
│   ├── logica-fluxo-igor-agente-ativo-promocao.md
│   ├── referencias/workflows-asx/     # referência técnica
│   └── workflows/                     # audit doc por workflow IGOR_*
├── n8n/
│   └── workflows/                     # IGOR_*.json + *.sdk.ts
├── supabase/migrations/               # SQL idempotente
├── scripts/                           # discover, import-workflow, mask-secrets, kommo CSV
└── lista-leads/                       # CSVs do Kommo (gitignored)
```

A pasta `n8n/workflows/` contém apenas workflows do Igor. Workflows ASX, quando existirem na instância, são intocáveis.

## Migrations Supabase aplicadas

Numeração sequencial idempotente em `supabase/migrations/`:

```text
001_core_schema.sql
002_indexes_constraints.sql
003_settings_seed.sql
004_campaign_schema.sql
005_rls_policies.sql
006_campaign_seed_2026-05.sql
007_asserts_rpc.sql
008_messages_msgid_unique.sql        # partial UNIQUE em msg_id (UPSERT IGOR_02/06)
009_settings_fase_c_activation.sql   # chaves separadas after_hours_*, timezone, holiday_policy + workflows_enabled IGOR_01-08
010_settings_gates.sql               # dry_run_send + allow_real_whatsapp_send
011_chatwoot_assignee_optional.sql   # chatwoot_human_assignee_id (default null)
012_smoke_test_phone.sql             # smoke_test_phone + smoke_test_message
```

Para novas migrations, mantenha numeração sequencial e idempotência (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING/UPDATE`).

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

### Opt-out (prioridade máxima)

Ao detectar pedido de parada:

1. marcar `contacts.do_not_contact=true`
2. marcar `contacts.consent_marketing=false`
3. atualizar campanha, quando houver
4. aplicar labels de opt-out
5. registrar evento
6. responder confirmação curta
7. bloquear novos disparos

### Handoff

`IGOR_05_Finalize_Handoff` deve ser chamado antes da mensagem final ao lead. Após handoff:

- `conversations.ai_enabled=false`
- `conversations.human_locked=true`
- aplicar label `handoff_done`
- criar private note no Chatwoot
- atribuir conversa ao time/atendente
- registrar `events('handoff_complete')`
- IA não responde mais

### Mídia e saúde

O sistema não interpreta clinicamente exames, laudos, prescrições, imagens do corpo, antes/depois sensível ou documentos médicos. Nesses casos:

- marcar compliance (`safety_flags.clinical=true` ou similar)
- criar resumo seguro
- fazer handoff
- parar IA após handoff

## Condutas proibidas

- imprimir tokens, API keys, passwords, connection strings completas ou service role keys
- apagar workflows que não foram criados pelo Igor
- alterar workflows ASX
- enviar WhatsApp real sem `settings.allow_real_whatsapp_send=true` AND `settings.dry_run_send=false` AND aprovação do usuário
- ativar campanha real sem autorização
- configurar webhook real sem autorização
- atualizar banco interno do Chatwoot diretamente
- criar nova conversation no Chatwoot se já existe conversation ativa
- deixar rota `unknown` sem tratamento
- usar SQL dinâmico inseguro (sempre parametrizado via `queryReplacement`)
- permitir IA responder após humano assumir
- permitir IA responder após opt-out
- interpretar exames ou documentos clínicos

## Primeira ação obrigatória

Antes de qualquer mutação:

1. Ler `docs/ARCHITECTURE.md` para entender estado atual.
2. Ler `docs/logica-fluxo-igor-receptivo-fora-expediente.md` e `docs/logica-fluxo-igor-agente-ativo-promocao.md` para a lógica funcional.
3. Verificar `docs/VALIDATION_REPORT.md` — não duplicar trabalho já feito.
4. Consultar `.claude/CREDENCIAIS.md` quando precisar de URLs, tokens ou instância.
5. Apresentar o plano antes de tocar produção. Mutações destrutivas (delete workflow, force-push, drop table) exigem confirmação explícita do usuário.
