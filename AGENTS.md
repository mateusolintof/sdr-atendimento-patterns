# AGENTS.md — Instituto Dr. Igor

> **Single source of truth para regras de trabalho.** `CLAUDE.md` é um symlink para este arquivo. Qualquer agente (Claude Code, Codex, Cursor) deve ler este documento. Edições feitas via atalho `#` em sessões Claude caem aqui.
>
> Para arquitetura técnica (topologia, IDs, fluxos detalhados), leia `docs/ARCHITECTURE.md`. Para estado vivo, `tasks.md`. Para comandos operacionais, `docs/RUNBOOK.md`.

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

Referências técnicas da ASX ficam em `docs/referencias/workflows-asx/` — use apenas para entender padrões de stack (webhook Evolution, Redis batching, callables, agent tools, handoff, labels, Chatwoot integration). **Não copie regras comerciais, prompts, IDs, telefones ou problemas conhecidos da ASX.**

**Para conhecimento técnico atualizado**:
- Integração Evolution + Chatwoot: https://doc.evolution-api.com/v2/pt/integrations/chatwoot
- n8n: skills `n8n-expression-syntax`, `n8n-workflow-patterns`, `n8n-mcp-tools-expert`, `n8n-validation-expert`, `n8n-node-configuration` + https://docs.n8n.io/
- Use `context7` MCP para fetch da doc de qualquer biblioteca/SDK quando necessário.

## Nomes canônicos dos workflows

Topologia atual (pós refator 2026-05-18 + incident handling 2026-05-20):

**Receptivo fora de expediente:**
- `IGOR_Inbound` — workflow principal (webhook Evolution → gates → mídia switch → Redis batch → Alice agent → Send WhatsApp). Consolida o que antes era IGOR_01+IGOR_02+IGOR_03+IGOR_AUX_*. ID `6hXJpXn139z6WCYW`.
- `IGOR_Handoff` — callable chamado por Alice (tool `request_handoff`). Ramifica por outcome (qualified/unqualified/compliance), atribui team, aplica labels via IGOR_04, posta private note. ID `mfB7MGpCYSPQvRSx` (reaproveita ID do antigo IGOR_05_v2).
- `IGOR_04_Tool_Labels_Attributes` — callable de labels/custom_attributes/private_note. ID `AJF7dhGrqJEXMLqz`.
- `IGOR_Chatwoot_Logger` — webhook Chatwoot, detecta resposta humana e flipa `owner_flow='human_daytime'` (com fallback `Check IA Match` pra distinguir Alice de humano). Renomeado de IGOR_06. ID `xpXRENR7Hoo2W5p3`.
- `IGOR_07_Error_Logger` — errorWorkflow target de todos. ID `ZrsbaSTlW5bqMEaS`.
- `IGOR_08_Health_Check` — schedule `*/10 * * * *`. ID `cDpDA1QdIH9wHAlN`.

**Campanha promocional (one-shot, sem AI conversacional):**
- `IGOR_Campaign_Sender` — workflow único de disparo (cron `*/7 * * * *`, batch=2, jitter 45-90s, 3 variantes anti-block). ID `4NzqtCS3ZGrwSVnB`. Resposta do lead → atendente humana via gate `block_reason='campaign_active'` em IGOR_Inbound. Tracking de resposta + agendamento via hooks em IGOR_Inbound + IGOR_Chatwoot_Logger.
- `scripts/import-kommo-csv.py` — importer manual de leads Kommo (não é workflow n8n).

**Teams Chatwoot (account 2):**

| ID | Nome | Atribuído quando |
|---|---|---|
| 1 | atendimento humano | leads em jornada existente OU em horário comercial OU compliance |
| 3 | ia após-expediente | Alice em ação |
| 4 | aguardando retorno | pós-handoff Alice (qualified/unqualified) |
| 5 | promoção maio 2026 | pós-disparo IGOR_Campaign_Sender |

**Helpers internos:**
- `IGOR_TEST_Failing_Workflow` (id `m6QeFfLQRa94G5PJ`) + `IGOR_TEST_Trampoline` (id `enmJo4zpLEvvfuOH`) — fixtures pra validar IGOR_07 (errorTrigger pattern). Nunca ativar em produção.
- `IGOR_TEST_Smoke_Trigger` (id `G8pMteuirc2yZgq5`) — manual trigger pra smoke. Desativado por default.

**Arquivados pós-refator (não recriar):** `IGOR_01_*`, `IGOR_01_Inbound_AfterHours_v2`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_05_*`, `IGOR_06_Chatwoot_Message_Logger` (renomeado), `IGOR_AUX_save_lead_partial`, `IGOR_AUX_update_conversation_state`. Workflows `IGOR_09/10/11/12/13` planejados → cancelados.

Use underscore em nomes técnicos. Não misture hífen e underscore.

## Estado de publicação atual (2026-05-20)

Todos workflows com webhook estão DESATIVADOS após o incident 2026-05-18 (`active=false`):
- IGOR_Inbound, IGOR_Handoff, IGOR_Chatwoot_Logger, IGOR_Campaign_Sender

Webhooks Evolution (dr.igor + convert-teste) → `enabled=false`.

Workflows permanentemente ativos: IGOR_04 (callable), IGOR_07 (errorTrigger), IGOR_08 (schedule), IGOR_TEST_* (fixtures).

Antes de reativar IGOR_Inbound → implementar defesa em profundidade do gate "lead novo" (3 camadas — ver `tasks.md`).

## ⚠️ PROIBIDO em workflows n8n

1. **`={{ $env.X }}`** — container n8n bloqueia por `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`. Em runtime aparece `[ERROR: access to env vars denied]` → workflow falha.
2. **`={{ $vars.X }}`** — Variables é feature Enterprise-only; não funciona em self-hosted Community.
3. **UPDATE direto no banco do Chatwoot.** ASX faz (`Move to Vendor Inbox` no 03-Finalize-Handoff). Igor proíbe. Usar API pública (`/conversations/{id}/assignments`).
4. **2 webhooks Evolution ativos simultâneos.** Lição incident 2026-05-18: mensagens reais do número de prod vão disparar workflows em modo teste. Comutar = desabilitar uma E habilitar outra.
5. **Status `'sending'` em `campaign_contacts.status`.** Não está no CHECK constraint — usar `'scheduled'`.

**Onde os valores vão:**

| Tipo de valor | Onde fica |
|---------------|-----------|
| Credentials (API keys, tokens) | UI do n8n → referenciado por nome no node |
| URLs / IDs / instance names | Hardcoded no node parameter OU expressão dinâmica `={{ $('Extrair Campos').first().json.instance }}` quando multi-instance |
| Configs de negócio (business hours, holidays, workflows_enabled, team_ids) | Tabela `settings` no Supabase |

Para prod/test swap (instância Evolution): URL dinâmica no node + toggle de webhook na instância correta via API.

**Antes de declarar qualquer workflow pronto**: grep por `$env\.` no JSON e SDK. Hits = bug.

## Segurança e gates

- `.claude/CREDENCIAIS.md` é gitignored. Nunca commitar segredos.
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07) em TODOS os workflows IGOR_*.
- Kill switches em `settings`:
  - `ai_enabled_global=true` por padrão; em `false` pausa Igor inteiro.
  - `workflows_enabled.{IGOR_Inbound | IGOR_Campaign_Sender}` controla cada workflow individual.
- Campanha: também controlada por `campaign_runs.status='ativo'`.

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
008_messages_msgid_unique.sql           # partial UNIQUE em msg_id
009_settings_fase_c_activation.sql      # after_hours_*, timezone, holiday_policy
010_settings_gates.sql                  # ⚠️ legacy: gates dry_run_send/allow_real removidos do código
011_chatwoot_assignee_optional.sql      # chatwoot_human_assignee_id (default null)
012_smoke_test_phone.sql                # ⚠️ legacy: settings smoke_test_phone/_message DELETED em runtime
013_settings_teams_and_flow.sql         # ai_team_id, human_daytime_team_id, handoff_queue_team_id, max_alice_turns
014_conversations_owner_flow.sql        # journey_started_at, owner_flow, turn_count
015_campaign_variants_and_tracking.sql  # campaign_runs.message_variants + seed das 3 variantes
```

Próxima migration (pendente — pré-reativação Inbound):
- `016_backfill_existing_chatwoot_conversations.sql` — cria row em `conversations` pra cada conv existente no Chatwoot com `owner_flow='human_daytime'`, `human_locked=true`, `journey_started_at=created_at`. Backfill obrigatório pra defesa em profundidade.

Para novas migrations, mantenha numeração sequencial e idempotência (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING/UPDATE`).

## Regras críticas de negócio

### Receptivo fora de expediente

- IA responde apenas fora do expediente humano.
- IA responde apenas a **leads novos** (definição robusta abaixo).
- IA faz acolhimento e qualificação curta.
- IA coleta melhor horário/período para retorno.
- IA não agenda diretamente.
- IA não promete disponibilidade.
- IA faz handoff para humano e para de responder.

**Definição robusta de "lead novo"** (3 sinais combinados):
1. `conversations.journey_started_at IS NULL` no Supabase (gate atual)
2. Chatwoot não tem msgs outgoing humanas anteriores na conv (gate pendente — query runtime)
3. Conv Chatwoot NÃO tem label `ai_disabled` nem `atendimento_humano` (gate pendente)

### Campanha ativa

- Campanha só envia para leads elegíveis (status `queued`).
- Campanha respeita opt-out e `do_not_contact`.
- Campanha usa preço e validade configurados em banco (`campaign_runs`).
- Campanha não afirma que a mensagem foi escrita manualmente por humano.
- Campanha não promete resultado clínico.
- **NÃO existe IA conversacional na campanha.** Lead responde → atendente humana.
- Cadência: 7 min entre tics, batch=2, jitter 45-90s entre sends, max diário progressivo (20→50→100).

### Opt-out (prioridade máxima)

Ao detectar pedido de parada:

1. marcar `contacts.do_not_contact=true`
2. marcar `contacts.consent_marketing=false`
3. atualizar campanha quando houver (`campaign_contacts.status='opt_out'`)
4. aplicar labels de opt-out
5. registrar evento
6. responder confirmação curta
7. bloquear novos disparos

### Handoff

`IGOR_Handoff` deve ser chamado antes da mensagem final ao lead. Após handoff:

- `conversations.ai_enabled=false`
- `conversations.human_locked=true`
- `conversations.owner_flow IN ('handoff_queue', 'compliance_hold', 'ai_unqualified')`
- aplicar label `handoff_done`
- criar private note no Chatwoot
- atribuir conversa ao team correto (4 ou 1 dependendo do outcome)
- registrar `events('handoff_complete')`
- IA não responde mais (gate determinístico por `owner_flow`)

### Mídia e saúde

O sistema **não interpreta clinicamente** exames, laudos, prescrições, imagens do corpo, antes/depois sensível ou documentos médicos. Nesses casos:

- marcar compliance (`safety_flags.clinical=true`)
- criar resumo seguro
- fazer handoff (`outcome='compliance'`)
- parar IA após handoff

## Condutas proibidas

- imprimir tokens, API keys, passwords, connection strings completas ou service role keys
- apagar workflows que não foram criados pelo Igor
- alterar workflows ASX
- enviar WhatsApp real sem aprovação do usuário
- ativar campanha real sem autorização
- configurar webhook real sem autorização
- atualizar banco interno do Chatwoot diretamente (usar API pública)
- ter 2 webhooks Evolution ativos simultâneos (incident lesson)
- criar nova conversation no Chatwoot se já existe conversation ativa
- deixar rota `unknown` sem tratamento
- usar SQL dinâmico inseguro (sempre parametrizado via `queryReplacement`)
- permitir IA responder após humano assumir (gate `owner_flow`)
- permitir IA responder após opt-out
- permitir IA responder a paciente existente (gate "lead novo" robusto — defesa em profundidade)
- interpretar exames ou documentos clínicos
- usar status `'sending'` em campaign_contacts (não existe no CHECK; usar `'scheduled'`)
