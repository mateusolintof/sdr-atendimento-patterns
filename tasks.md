# Tasks — Instituto Dr. Igor

> Arquivo de tarefas persistente entre sessões. Atualizado em 2026-05-20.
> Para regras de trabalho leia `AGENTS.md`. Para arquitetura técnica viva leia `docs/ARCHITECTURE.md`. Para procedimentos operacionais leia `docs/RUNBOOK.md`.

## Estado geral (2026-05-20)

**Sistema PAUSADO** após incident 2026-05-18 (Alice respondeu erroneamente 6 pacientes existentes — ver "Lições do incident" abaixo).

| Frente | Status |
|---|---|
| **Fluxo 1 — Receptivo Fora de Expediente** | ⏸️ pausado. Aguardando implementação de defesa em profundidade do gate "lead novo" (3 camadas) antes de reativar |
| **Fluxo 2 — Campanha Promocional** | ⏸️ pausado. 5 envios completados (1 smoke Mateus + 4 leads reais — Mary, Adriana, Rosa, eliethmachado40). 134 queued restantes. Aguardando ajuste de gates e/ou reativação coordenada com Fluxo 1 |

### Workflows com webhook DESATIVADOS

- `IGOR_Inbound` (6hXJpXn139z6WCYW) — `active=false`
- `IGOR_Handoff` (mfB7MGpCYSPQvRSx) — `active=false`
- `IGOR_Chatwoot_Logger` (xpXRENR7Hoo2W5p3) — `active=false`
- `IGOR_Campaign_Sender` (4NzqtCS3ZGrwSVnB) — `active=false`

### Webhooks Evolution DESABILITADOS

- `dr.igor` (número de produção, +55 75 9 7047-8880) — `enabled=false`
- `convert-teste` (número de teste, +55 11 5304-4220) — `enabled=false`

### Workflows ainda ATIVOS

- `IGOR_04_Tool_Labels_Attributes` (callable, sem trigger próprio)
- `IGOR_07_Error_Logger` (errorTrigger)
- `IGOR_08_Health_Check` (schedule `*/10 * * * *`)

---

## 🚨 Lições do incident 2026-05-18

Alice respondeu mensagens de 6 pacientes existentes:
- Lucas Mota (conv 88, +55 71 99197-5986)
- Licia Helena Bahia (conv 117, +55 75 99210-3663)
- Vinicius Costa Lima (conv 114, +55 71 99999-2599)
- Camila (conv 93, +55 75 99851-5613)
- Nanda🍀 (conv 39, +55 75 98312-2702)
- Dra Ana Cláudia (conv 6, +55 75 98822-1362)

Atendente humana detectou em tempo real ("Tão mandando mensagem p os meus pacientes" — msg 736 às 20:01:58 UTC).

### Causa raiz (5 erros encadeados)

1. **Webhook duplo ativo**: `convert-teste` (teste) habilitado + `dr.igor` (prod) também habilitado. Mensagens reais entraram via dr.igor.
2. **dr.igor recebe msgs reais**: número de produção com pacientes em atendimento ativo. Cada msg disparou IGOR_Inbound.
3. **After-hours forçado**: `settings.holidays=["2026-05-18"]` setado pra teste → gate sempre concluía "fora do expediente".
4. **`journey_started_at IS NULL` retorna true falsamente**: pacientes nunca passaram pelo IGOR_Inbound antes. Row em `conversations` inexistente.
5. **Sem fallback no Chatwoot history**: IGOR_Inbound não consulta histórico de msgs humanas anteriores na conv Chatwoot.

### Defesa em profundidade pré-reativação (OBRIGATÓRIA)

Antes de reativar IGOR_Inbound em prod, implementar TODAS as 3 camadas:

#### Camada 1 — Backfill conversations (migration 016)
- [ ] Criar `supabase/migrations/016_backfill_existing_chatwoot_conversations.sql`
- [ ] Query: pra cada conv existente no Chatwoot, INSERT em `public.conversations` com `owner_flow='human_daytime'`, `human_locked=true`, `journey_started_at=conv.created_at`, `ai_enabled=false`
- [ ] Aplicar via Supabase Studio
- [ ] Verificar: `SELECT COUNT(*) FROM conversations WHERE owner_flow='human_daytime'` ≈ número de conversas no Chatwoot

#### Camada 2 — Gate runtime "tem histórico humano"
- [ ] Adicionar 1 node em `IGOR_Inbound` (após `Load State`): HTTP GET no Chatwoot listando msgs `message_type=outgoing && sender_type=user` anteriores ao msg_id atual
- [ ] Code node ajusta `Compute Gates`: se contagem > 0 → `block_reason='existing_human_conversation'`
- [ ] Smoke test com paciente existente fictício (criar conv no Chatwoot, NÃO criar row em Supabase, mandar msg)

#### Camada 3 — Label override
- [ ] Adicionar em `Compute Gates`: se conv Chatwoot tem label `ai_disabled` OU `atendimento_humano` → `block_reason='label_disabled'`
- [ ] Pode usar dados já carregados no `Load State` ou query separada

### Regra operacional permanente

**1 webhook Evolution ativo por vez**. Procedimento de comutação em `docs/RUNBOOK.md` seção "Comutar instância Evolution".

### Conter conversas afetadas (já feito durante incident, manter labels permanentes)

- [ ] Aplicar label `ai_disabled` permanente nas 6 conversas afetadas (cv 88, 117, 114, 93, 39, 6)
- [ ] Confirmar que `owner_flow='human_daytime'` está setado nas rows correspondentes

---

## Pendências Fluxo 1 (pré-reativação Inbound)

### Implementação técnica

- [ ] **Camada 1** — Migration 016 backfill conversations (ver "Defesa em profundidade")
- [ ] **Camada 2** — Gate runtime Chatwoot history em IGOR_Inbound
- [ ] **Camada 3** — Label override `ai_disabled`/`atendimento_humano`
- [ ] Smoke isolado: paciente existente fictício NÃO deve receber resposta da Alice
- [ ] Smoke isolado: lead realmente novo DEVE receber resposta da Alice
- [ ] Reativar `IGOR_Inbound` (publish via MCP)
- [ ] Habilitar webhook em apenas UMA instância Evolution (prod ou teste, não ambas)

### Pendente do estado anterior (válido após defesa em profundidade)

- [ ] Smoke caminho A (qualified): Alice coleta nome+objetivo+período → handoff → conv em team 4 (aguardando retorno) + labels `lead_qualificado`, `handoff_done`
- [ ] Smoke caminho B (unqualified): simular disengage → handoff → team 4 + labels `nao_qualificado_ia`
- [ ] Smoke caminho C (compliance): enviar imagem clínica → handoff → team 1 (atendimento humano) + label `compliance_humano`
- [ ] Smoke human takeover: atendente envia msg no Chatwoot → IGOR_Chatwoot_Logger detecta → flipa `owner_flow='human_daytime'` → próxima msg do lead à noite NÃO aciona Alice (validar patch `Check IA Match` ainda detecta corretamente)
- [ ] Cleanup pós-smoke: remover datas de teste de `settings.holidays`, restaurar dia útil normal

---

## Pendências Fluxo 2 (campanha promocional)

### Estado atual

- 6 leads em `campaign_contacts.status='sent'`:
  - Mateus (smoke), Mary, Adriana, Rosa, eliethmachado40, "Nada" (deletada manualmente — não estava em team Promoção)
- 134 leads em `campaign_contacts.status='queued'`
- Campanha em `campaign_runs.status='pausado'`

### Pendências

- [ ] Decidir: ativar antes ou junto com Fluxo 1?
- [ ] Confirmar que `IGOR_Inbound` (mesmo desativado) não vai responder leads de campanha quando reativar — gate `block_reason='campaign_active'` deve cuidar disso, mas validar com smoke
- [ ] Confirmar profile name no WhatsApp `dr.igor` (atualmente "Instituto Aguiar Neri" — pode ou não estar correto)
- [ ] Confirmar variantes finais da mensagem (A2/E2/G2 reformuladas — versão mais quente, sem emoji)
- [ ] Ativar campanha: `UPDATE campaign_runs SET status='ativo'`
- [ ] Republicar `IGOR_Campaign_Sender`
- [ ] Cadência inicial: dia 1: max 20 sends, dia 2: 50, dia 3+: 100 (configurar via `campaign_runs.max_daily_sends`)
- [ ] Monitorar respostas no Chatwoot team 5 ("promoção maio 2026")
- [ ] Quando lista esgotar OU `ends_at` (2026-06-01) expirar: `UPDATE campaign_runs SET status='finalizado'`
- [ ] Compor relatório final pro Dr. Igor: enviadas, entregues, responderam, agendaram, opt-out, falharam + taxas

### Relatório final (template SQL)

```sql
SELECT status, COUNT(*) AS qty,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct
FROM public.campaign_contacts
WHERE campaign_id = '00000000-0000-0000-0000-000000000001'
GROUP BY status
ORDER BY qty DESC;
```

Métricas-chave:
- **Enviadas**: count(status IN sent,delivered,replied,interested,converted,handoff_*)
- **Responderam**: count(status IN replied,interested,converted,handoff_*)
- **Agendaram**: count(status='converted')
- **Opt-out**: count(status='opt_out')
- **Taxa resposta**: respondidos / enviados
- **Taxa conversão**: agendados / enviados

---

## Inventário live no n8n (referência rápida)

### Ativos sempre (callables/error/health)

| ID | Nome | Função |
|---|---|---|
| `AJF7dhGrqJEXMLqz` | `IGOR_04_Tool_Labels_Attributes` | callable labels + custom_attrs |
| `ZrsbaSTlW5bqMEaS` | `IGOR_07_Error_Logger` | errorTrigger target de todos |
| `cDpDA1QdIH9wHAlN` | `IGOR_08_Health_Check` | schedule `*/10 * * * *` |
| `m6QeFfLQRa94G5PJ` | `IGOR_TEST_Failing_Workflow` | fixture do IGOR_07 |
| `enmJo4zpLEvvfuOH` | `IGOR_TEST_Trampoline` | fixture do IGOR_07 |

### Desativados pós-incident (reativar quando aplicar defesa)

| ID | Nome | Função |
|---|---|---|
| `6hXJpXn139z6WCYW` | `IGOR_Inbound` | webhook principal — gates, mídia, Alice |
| `mfB7MGpCYSPQvRSx` | `IGOR_Handoff` | callable de Alice |
| `xpXRENR7Hoo2W5p3` | `IGOR_Chatwoot_Logger` | webhook Chatwoot (detecta humano takeover + agendado) |
| `4NzqtCS3ZGrwSVnB` | `IGOR_Campaign_Sender` | cron 7min disparo campanha |
| `G8pMteuirc2yZgq5` | `IGOR_TEST_Smoke_Trigger` | manual trigger (desativado por default) |

### Credenciais n8n

| Nome | ID | Tipo |
|---|---|---|
| `igor_chatwoot_api` | `x8StLhAFnYjQxUFg` | httpHeaderAuth (`api_access_token`) |
| `igor_evolution_api` | `DDhbwLsNclqTA18X` | httpHeaderAuth (`apikey`) |
| `igor_supabase_postgres` | `Z7DeBop4nK4JlIXO` | postgres (session pooler) |
| `igor_openai` | (auto) | openAiApi (Bearer) |
| `igor_redis_embedded` | `ayVMY7Njm6ecLLuc` | redis (local) |

**HTTP nodes precisam de wiring manual** após `create_workflow_from_code` — MCP só auto-resolve credentials de Postgres/OpenAI/Redis. Workflow para wiring: fetch via REST → PATCH `credentials` → PUT.

---

## Dependências e referências

- **Regras de trabalho**: `AGENTS.md` (symlink `CLAUDE.md`)
- **Arquitetura técnica viva**: `docs/ARCHITECTURE.md`
- **Procedimentos operacionais**: `docs/RUNBOOK.md`
- **Spec funcional Fluxo 1**: `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
- **Spec funcional Fluxo 2**: `docs/logica-fluxo-igor-agente-ativo-promocao.md`
- **Referências ASX** (padrões técnicos, NÃO regras comerciais): `docs/referencias/workflows-asx/`
- **Snapshots históricos** (não usar como fonte de verdade): `archives/`
- **CSVs Kommo** (gitignored): `lista-leads/*.csv`
- **Credenciais reais** (gitignored): `.claude/CREDENCIAIS.md`
- **Importer Kommo**: `scripts/import-kommo-csv.py`
- **Seed Chatwoot**: `scripts/seed-chatwoot.sh`
- **Memórias de referência** (persistem entre sessões): `~/.claude/projects/-Users-mateusolintof-Projetos-Convert-Produ--o-Instituto-Igor/memory/`

---

## Backlog futuro (fora de escopo atual)

- [ ] Cleanup cron Postgres para limpar status `scheduled` órfão (>5min): job manual ou agendado
- [ ] Dashboard SQL/Metabase para métricas Fluxo 2 em tempo real (Dr. Igor consulta diretamente)
- [ ] Migration consolidando colunas de handoff (`last_handoff_outcome`, `last_handoff_reason`, `last_handoff_at`) em `conversations` para evitar joins em `events`
- [ ] Cleanup de IGOR_TEST_Smoke_Trigger se não for mais necessário (após Fluxo 2 entrar em produção)
- [ ] Reduzir gate de holiday do `IGOR_Campaign_Sender` — feriado pra campanha promo é discutível (decisão de negócio)
- [ ] Considerar trocar `dr.igor` profile name no WhatsApp pra "Clínica Dr. Igor" ou similar (via Evolution API `/chat/updateProfileName`)

---

## Histórico de mudanças (changelog resumido)

- **2026-05-20**: Audit de drift completo. Apagados workflows SDK/JSON arquivados, tests + docs/workflows obsoletos. Arquivado IMPLEMENTATION_PLAN, REFACTOR_FLUXO_1, VALIDATION_REPORT em `archives/`. Reescrito ARCHITECTURE.md, AGENTS.md, RUNBOOK.md, tasks.md. Criadas memórias de referência permanente.
- **2026-05-18**: Incident Alice/pacientes. Pausa total. Análise causa raiz: webhook duplo + gate "lead novo" insuficiente. Plano de defesa em profundidade definido.
- **2026-05-18**: Refator consolidação: IGOR_01+02+03+AUX → IGOR_Inbound, IGOR_05_v2 → IGOR_Handoff, IGOR_06 → IGOR_Chatwoot_Logger, IGOR_09/10/11/12/13 cancelados → IGOR_Campaign_Sender.
- **2026-05-18**: Implementação Fluxo 2 (Campanha): migration 015, IGOR_Campaign_Sender deployed, team `promoção maio 2026` criado, 5 sends completados.
- **2026-05-17**: Migrations 013-014 aplicadas (owner_flow, journey_started_at, teams).
- **2026-05-15**: Fase C — 7 workflows IGOR_01-08 + AUX deployed. ARCHITECTURE.md narrativo escrito.
- **2026-05-14**: Setup inicial — migrations 001-012, Chatwoot seed, 137 leads Kommo importados.
