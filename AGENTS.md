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

**Receptivo fora de expediente — implementados (`n8n/workflows/IGOR_*.sdk.ts`):**

Topologia atual (pós refator 2026-05-18, adaptação ASX 07-FB-Leads-Inbound):

- `IGOR_Inbound` ✅ — workflow principal único (webhook Evolution → gates → mídia switch → Redis batch → Alice agent → Send WhatsApp). Consolida o que antes era IGOR_01+IGOR_02+IGOR_03+IGOR_AUX_*.
- `IGOR_Handoff` ✅ — callable chamado por Alice (tool `request_handoff`). Ramifica por outcome (qualified/unqualified/compliance), atribui team, aplica labels via IGOR_04, posta private note. ID `mfB7MGpCYSPQvRSx` (reutiliza workflow que antes era IGOR_05_v2).
- `IGOR_04_Tool_Labels_Attributes` ✅ — callable de labels/custom_attributes/private_note, usado por IGOR_Inbound e IGOR_Handoff.
- `IGOR_Chatwoot_Logger` ✅ — webhook Chatwoot, detecta resposta humana e flipa `owner_flow='human_daytime'` (renomeado de IGOR_06).
- `IGOR_07_Error_Logger` ✅ — errorWorkflow target de todos os IGOR_*.
- `IGOR_08_Health_Check` ✅ — healthcheck externo.

**Arquivados pós-refator** (não usar/recriar): `IGOR_01_Inbound_AfterHours`, `IGOR_01_Inbound_AfterHours_v2`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_05_Finalize_Handoff`, `IGOR_AUX_save_lead_partial`, `IGOR_AUX_update_conversation_state`.

**Campanha ativa — implementado (one-shot, sem AI):**

- `IGOR_09_Campaign_Importer` — script Python local (`scripts/import-kommo-csv.py`).
- `IGOR_Campaign_Sender` ✅ — workflow único de disparo (cron 7min, batch=2, jitter 45-90s, 3 variantes anti-block, quota progressiva 20→50→100/dia). ID `4NzqtCS3ZGrwSVnB`. Cancela IGOR_10/11/12/13: resposta do lead vai pra atendente humana via gate `block_reason='campaign_active'` já existente em IGOR_Inbound. Após cada send: aguarda 3s, busca contato no Chatwoot, atribui conversa ao team `Promoção Maio 2026` (id=5, settings `promo_team_id`) via API `POST /conversations/{id}/assignments`. Tracking de resposta via UPDATE em IGOR_Inbound (`Update Campaign Replied`); tracking de agendamento via IGOR_Chatwoot_Logger (detecção de label `agendado`).

**Teams Chatwoot (account 2):**

| ID | Nome | Função |
|---|---|---|
| 1 | atendimento humano | Leads em jornada existente ou em horário comercial |
| 3 | ia após-expediente | Conversas sob comando da Alice |
| 4 | aguardando retorno | Pós-handoff IA aguardando contato humano |
| 5 | promoção maio 2026 | Conversas da campanha (atribuído pós-send) |

**Helpers internos:**

- `IGOR_TEST_Failing_Workflow`, `IGOR_TEST_Trampoline` — fixtures para validar IGOR_07 (errorTrigger pattern). Nunca ativar em produção.
- `IGOR_TEST_Smoke_Trigger` — manual trigger que dispara WhatsApp pro número configurado em `settings.smoke_test_phone` (usado em smoke real).

Use underscore em nomes técnicos. Não misture hífen e underscore.

## ⚠️ PROIBIDO em workflows n8n

1. **`={{ $env.X }}`** — container n8n bloqueia por `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`. Em runtime aparece `[ERROR: access to env vars denied]` → workflow falha.
2. **`={{ $vars.X }}`** — Variables é feature Enterprise-only; não funciona em self-hosted Community.

**Onde os valores vão:**

| Tipo de valor | Onde fica |
|---------------|-----------|
| Credentials (API keys, tokens) | UI do n8n → referenciado por nome no node |
| URLs / IDs / instance names | Hardcoded no node parameter (pattern ASX em produção) |
| Configs de negócio (business hours, holidays, workflows_enabled, team_ids) | Tabela `settings` no Supabase |

Para prod/test swap (instância Evolution): find/replace no JSON local + re-PUT via REST ou via `mcp__n8n-mcp__update_workflow`.

**Antes de declarar qualquer workflow pronto**: grep por `$env\.` no JSON e SDK. Hits = bug.

## Segurança e gates

- `.claude/CREDENCIAIS.md` é gitignored. Nunca commitar segredos.
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07) em todos os workflows IGOR_*.
- Kill switches em `settings`:
  - `ai_enabled_global=true` por padrão; em `false` pausa Igor inteiro.
  - `workflows_enabled.IGOR_XX` controla cada workflow individual.

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
013_settings_teams_and_flow.sql      # ai_team_id, human_daytime_team_id, handoff_queue_team_id, max_alice_turns
014_conversations_owner_flow.sql     # journey_started_at, owner_flow, turn_count em conversations
015_campaign_variants_and_tracking.sql # campaign_runs.message_variants + seed das 3 variantes
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
- enviar WhatsApp real sem aprovação do usuário
- ativar campanha real sem autorização
- configurar webhook real sem autorização
- atualizar banco interno do Chatwoot diretamente
- criar nova conversation no Chatwoot se já existe conversation ativa
- deixar rota `unknown` sem tratamento
- usar SQL dinâmico inseguro (sempre parametrizado via `queryReplacement`)
- permitir IA responder após humano assumir
- permitir IA responder após opt-out
- interpretar exames ou documentos clínicos
