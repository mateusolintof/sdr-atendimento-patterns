# Tasks — Instituto Dr. Igor

> Arquivo de tarefas persistente entre sessões. Atualizado em 2026-05-18.
> Para regras de trabalho leia `AGENTS.md`. Para arquitetura técnica viva leia `docs/ARCHITECTURE.md`.

## Estado geral (2026-05-18)

- **Fluxo 1 (Inbound After-Hours)**: implantação concluída. Falta SMOKE end-to-end real (bloqueado: precisa deletar/resetar row de `public.conversations` do telefone de smoke).
- **Fluxo 2 (Campanha Promocional)**: planejado (ver plan file `~/.claude/plans/primeiro-de-tudo-eu-melodic-toast.md`). Não iniciado.
- **Frente de campanha (IGOR_11/12/13)**: **CANCELADA**. Substituída por `IGOR_Campaign_Sender` único.

---

## Inventário live no n8n (referência rápida)

### Ativos em produção (8 workflows)

| ID | Nome | Função |
|---|---|---|
| `6hXJpXn139z6WCYW` | `IGOR_Inbound` | Webhook Evolution → gates → mídia → Redis batch → Alice → send WhatsApp |
| `mfB7MGpCYSPQvRSx` | `IGOR_Handoff` | Callable de Alice (tool `request_handoff`). Ramifica qualified/unqualified/compliance |
| `AJF7dhGrqJEXMLqz` | `IGOR_04_Tool_Labels_Attributes` | Callable de labels/custom_attrs/private_note |
| `xpXRENR7Hoo2W5p3` | `IGOR_Chatwoot_Logger` | Webhook Chatwoot. Detecta resposta humana, flipa `owner_flow='human_daytime'` |
| `ZrsbaSTlW5bqMEaS` | `IGOR_07_Error_Logger` | errorWorkflow target de todos |
| `cDpDA1QdIH9wHAlN` | `IGOR_08_Health_Check` | Healthcheck externo |
| `m6QeFfLQRa94G5PJ` | `IGOR_TEST_Failing_Workflow` | Fixture do IGOR_07 |
| `enmJo4zpLEvvfuOH` | `IGOR_TEST_Trampoline` | Fixture do IGOR_07 |

### Helper (ativo manualmente)

| ID | Nome | Função |
|---|---|---|
| `G8pMteuirc2yZgq5` | `IGOR_TEST_Smoke_Trigger` | Manual trigger, dispara WhatsApp pro `settings.smoke_test_phone` |

### Arquivados (não recriar)

`IGOR_01_Inbound_AfterHours`, `IGOR_01_Inbound_AfterHours_v2`, `IGOR_02_Media_Normalizer`, `IGOR_03_Agent_AfterHours`, `IGOR_05_Finalize_Handoff`, `IGOR_AUX_save_lead_partial`, `IGOR_AUX_update_conversation_state`.

---

## Credenciais n8n (referência por ID)

| Nome | ID | Tipo |
|---|---|---|
| `igor_chatwoot_api` | `x8StLhAFnYjQxUFg` | httpHeaderAuth |
| `igor_evolution_api` | `DDhbwLsNclqTA18X` | httpHeaderAuth |
| `igor_supabase_postgres` | (auto-resolvido pelo MCP) | postgres |
| `igor_openai` | (auto-resolvido pelo MCP) | openAiApi |
| `igor_redis_embedded` | (auto-resolvido pelo MCP) | redis |

**HTTP nodes precisam de wiring manual** após `create_workflow_from_code` — MCP só auto-resolve credentials de Postgres/OpenAI/Redis. Workflow para wiring: fetch via REST → PATCH `credentials` → PUT.

---

## Fluxo 1 — Status detalhado

### Concluído ✅

- [x] Migration `013_settings_teams_and_flow.sql` aplicada (ai_team_id=3, human_daytime_team_id=1, handoff_queue_team_id=4, max_alice_turns=6)
- [x] Migration `014_conversations_owner_flow.sql` aplicada (`journey_started_at`, `owner_flow`, `turn_count` adicionados)
- [x] Seed Chatwoot rodado: 3 teams (`IA Após-Expediente`=3, `Atendimento Humano`=1, `Aguardando Retorno`=4) + labels + custom_attributes
- [x] `IGOR_Inbound` (53 nodes) deployed em `6hXJpXn139z6WCYW`, 4 HTTP creds wired, errorWorkflow=`ZrsbaSTlW5bqMEaS`, publicado
- [x] `IGOR_Handoff` (9 nodes) deployed em `mfB7MGpCYSPQvRSx` (reusa ID do antigo IGOR_05_v2), 2 HTTP creds wired, errorWorkflow set, publicado
- [x] `IGOR_06` renomeado para `IGOR_Chatwoot_Logger` (ID `xpXRENR7Hoo2W5p3`)
- [x] Webhook Evolution `convert-teste` confirmado apontando para `https://n8n.almaconvert.com.br/webhook/igor/inbound`
- [x] 7 workflows obsoletos arquivados via MCP
- [x] AGENTS.md atualizado com nomes canônicos novos
- [x] `holidays` em `settings` ajustado para `["2026-05-17","2026-05-18"]` (força after-hours hoje)

### Pendente 🔄

- [ ] **Resetar conversation row do smoke** — `conversations` tem row para `contact_id=0c6d9f50-a7e2-45bd-879a-535c369ecfd5` com `owner_flow='human_daytime'`. Bloqueia gate. Usuário precisa deletar manualmente via Supabase Studio:
  ```sql
  DELETE FROM public.conversations
  WHERE contact_id = '0c6d9f50-a7e2-45bd-879a-535c369ecfd5';
  ```
- [ ] **Smoke end-to-end (caminho A — qualified)**: enviar WhatsApp pro número da clínica (+551153044220) → Alice responde → coletar nome+objetivo+período → Alice chama `request_handoff(qualified)` → conversa cai em `Aguardando Retorno` (team 4) com labels `lead_qualificado`+`handoff_done`
- [ ] **Smoke caminho B — unqualified**: simular disengage ou max_turns → outcome `unqualified` → labels `nao_qualificado_ia`
- [ ] **Smoke caminho C — compliance**: enviar imagem clínica → outcome `compliance` → fila `Atendimento Humano` (team 1) com label `compliance_humano`
- [ ] **Smoke caminho humano takeover**: atendente envia msg no Chatwoot → IGOR_Chatwoot_Logger detecta → flipa `owner_flow='human_daytime'` → próxima msg do lead à noite NÃO aciona Alice
- [ ] **Cleanup pós-smoke**: remover `2026-05-18` de `settings.holidays`, restaurar dia útil normal

### Riscos abertos do Fluxo 1

- Status `'sending'` ou `'ai_active'` órfão em `conversations` se workflow crashar mid-flight. Cleanup manual raro.
- Race entre IGOR_Chatwoot_Logger e Alice no mesmo turno (humano respondeu durante o batch Redis). Mitigação atual: Logger só flipa flag; próximo turno é que respeita.

---

## Fluxo 2 — Campanha Promocional (IGOR_Campaign_Sender)

> Plan detalhado em `~/.claude/plans/primeiro-de-tudo-eu-melodic-toast.md`. Resumo abaixo.

### Decisões fixadas

- **1 workflow apenas**: `IGOR_Campaign_Sender` (cron trigger, ~16 nodes)
- **Sem AI conversacional**: respostas vão direto pra fila humana via `block_reason='campaign_active'` já existente em IGOR_Inbound
- **Cron**: a cada 7 min com gates internos (janela, holiday, quota, status='active')
- **Cadência**: batch=2, delay aleatório 45-90s entre sends, max_daily_sends progressivo (20→50→100)
- **3 variantes de mensagem**: nova coluna `message_variants` jsonb em `campaign_runs`
- **Personalização**: `{nome}` (primeiro nome de `contacts.name`)
- **Tracking respostas**: hook em IGOR_Inbound (antes do block) → UPDATE campaign_contacts.status='replied'
- **Tracking agendamento**: hook em IGOR_Chatwoot_Logger (label `agendado`) → UPDATE campaign_contacts.status='converted'
- **Idempotência**: SELECT FOR UPDATE SKIP LOCKED + transição imediata para `sending`

### Backlog de implementação

#### Fase A — Banco e seed
- [x] Criar `supabase/migrations/015_campaign_variants_and_tracking.sql` (ALTER + seed 3 variantes + toggle workflows_enabled)
- [ ] **Aplicar migration no Supabase Studio** (SQL Editor → cole conteúdo do arquivo → Run)
- [ ] Adicionar labels no Chatwoot (manual via UI ou rodar `seed-chatwoot.sh`): `promo_maio_2026`, `campanha_enviada`, `respondeu_campanha`, `agendado`

#### Fase B — Workflow novo  ✅
- [x] `n8n/workflows/IGOR_Campaign_Sender.sdk.ts` criado (19 nodes)
- [x] Validado via `mcp__n8n-mcp__validate_workflow` (zero erros)
- [x] Deploy em `4NzqtCS3ZGrwSVnB` (n8n.almaconvert.com.br/workflow/4NzqtCS3ZGrwSVnB)
- [x] HTTP cred `Send WhatsApp` → `igor_evolution_api` wired
- [x] errorWorkflow = `ZrsbaSTlW5bqMEaS`
- [x] Workflow inativo (não publicado) — pronto, mas só dispara quando `campaign_runs.status='ativo'` E publicado

Detalhe da sequência implementada:
  1. Schedule Trigger `*/7 * * * *`
  2. Load Campaign State (Postgres CTE: settings + campaign ativa + sent_today)
  3. Compute Gates (Code: should_proceed, skip_reason, batch_size, remaining_quota)
  4. IF should_proceed (false → Resp idle 200)
  5. Pick Eligible Batch (Postgres SELECT FOR UPDATE SKIP LOCKED, LIMIT 2)
  6. Split In Batches (size=1)
  7. Mark Sending (UPDATE status='sending')
  8. Pick Variant + Personalize (Code: random variant + interpolate {nome})
  9. Send WhatsApp (HTTP Evolution sendText, `neverError: true`)
  10. IF Send OK → UPDATE 'sent' / 'send_failed'
  11. INSERT events('campaign_send_attempt')
  12. Call IGOR_04 Labels (`promo_maio_2026`, `campanha_enviada`)
  13. Wait jitter (`={{ Math.floor(45000 + Math.random()*45000) }}` ms)
  14. Next batch
  15. Final Output (Set: sent_count, failed_count, remaining_quota)
- [ ] Validar via `mcp__n8n-mcp__validate_workflow` (zero erros)
- [ ] Deploy via `create_workflow_from_code`, capturar ID
- [ ] Wire HTTP creds manualmente (Send WhatsApp → `DDhbwLsNclqTA18X`)
- [ ] Setar `errorWorkflow=ZrsbaSTlW5bqMEaS` via PUT
- [ ] Não publicar ainda (workflow começa inativo)

#### Fase G — Team `Promoção Maio 2026` + assignment pós-send  ✅
- [x] Team criado no Chatwoot (id=5, "Promoção Maio 2026")
- [x] Setting `promo_team_id=5` inserido em settings
- [x] IGOR_Campaign_Sender patcheado (25 nodes total): após Update Sent → Wait 3s → Search Chatwoot Contact → Extract Contact ID → Get Contact Conversations → Extract Conversation ID → Assign Promo Team → INSERT event sent → Call IGOR_04 Labels (agora com conv_id real)
- [x] AGENTS.md atualizado com tabela de teams

#### Fase C — Extensões em workflows existentes  ✅
- [x] **IGOR_Inbound** patcheado via PUT — node `Update Campaign Replied` inserido entre `IF Block Reason?` (true) e `INSERT inbound_blocked`. UPDATE é idempotente (WHERE phone + status IN sent/delivered/sending). Sem chamada extra a IGOR_04 (label `respondeu_campanha` opcional, pode ser feito pelo humano via Chatwoot). 54 nodes total.
- [x] **IGOR_Chatwoot_Logger** patcheado via PUT — 3 nodes novos:
  - `IF agendado label added` — IF que checa `body.event='conversation_updated'` AND `changed_attributes` contém `label_list.current` com `agendado` E `previous` sem `agendado`
  - `UPDATE campaign converted` — UPDATE campaign_contacts SET status='converted', interest_classification='agendado', handoff_at=now via JOIN com contacts.phone
  - `INSERT campaign_agendamento` — event log
  - Conexão: IF event=message_created false → IF agendado → (true) UPDATE → INSERT → Filtered Response; (false) INSERT event_filtered. 20 nodes total.

#### Fase D — Docs
- [x] `AGENTS.md` seção "Campanha ativa": atualizada com `IGOR_Campaign_Sender` único + IDs + migration 015 listada
- [ ] Revisar `docs/logica-fluxo-igor-agente-ativo-promocao.md` — confirmar regra "AI conversacional na campanha REMOVIDA" (resposta = humano)
- [ ] Atualizar `docs/ARCHITECTURE.md` com seção dedicada IGOR_Campaign_Sender (deixar pra depois do smoke real)

#### Fase E — Importação Kommo
- [ ] Confirmar conteúdo de `lista-leads/*.csv` (137 leads esperados)
- [ ] Dry-run: `python scripts/import-kommo-csv.py` (sem `--apply`) — revisar contagem de skipped vs aceitos
- [ ] Apply: `python scripts/import-kommo-csv.py --apply`
- [ ] Verificar: `SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id='00000000-...001' AND status='queued'` ≈ 137

#### Fase F — Smoke campanha (isolado)
- [ ] Inserir 1 row teste manual em `campaign_contacts` com phone=`5562998621000`, status=`queued`
- [ ] `UPDATE campaign_runs SET status='active' WHERE id='00000000-...001'`
- [ ] Publicar `IGOR_Campaign_Sender`
- [ ] Aguardar ≤7 min ou disparar execução manual
- [ ] Verificar: msg chegou, `status='sent'`, `sent_at`, `message_variant` populados, label aplicada
- [ ] Responder: verificar Alice NÃO responde, `status='replied'`, conversa visível no Chatwoot
- [ ] Aplicar label `agendado` no Chatwoot: verificar `status='converted'`
- [ ] Cleanup: `UPDATE campaign_runs SET status='pausado'`, despublicar workflow, deletar row de teste

#### Fase G — Disparo real (faseado)
- [ ] **Dia 1**: `UPDATE campaign_runs SET status='active', max_daily_sends=20`. Publicar workflow. Acompanhar.
- [ ] **Dia 1 fim**: `SELECT status, COUNT(*) GROUP BY status`. Confirmar sem bloqueio do número.
- [ ] **Dia 2**: ajustar `max_daily_sends=50`
- [ ] **Dia 3+**: `max_daily_sends=100`
- [ ] **Acompanhar respostas** no Chatwoot — atendente humana opera normalmente
- [ ] **Encerrar quando lista esgotar** OU `ends_at` expirar: `UPDATE campaign_runs SET status='concluida'`, despublicar workflow

#### Fase H — Relatório final
- [ ] Rodar SQL de métricas (ver plan file seção "Relatório final")
- [ ] Compor relatório para Dr. Igor: enviadas, entregues, responderam, agendaram, opt-out, falharam + taxas

### Riscos abertos do Fluxo 2

- Bloqueio do número WhatsApp em rajada → mitigado por variantes+jitter+quota progressiva
- Status `'sending'` órfão se workflow crashar mid-send → cleanup raro com query manual
- Atendente esquecer label `agendado` → métrica de conversão subnotificada
- `message_variants` vazio em prod → fallback para `message_template`

---

## Dependências externas e conhecimento

- **Plan file Fluxo 2 (detalhado)**: `~/.claude/plans/primeiro-de-tudo-eu-melodic-toast.md`
- **Spec funcional Fluxo 1**: `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
- **Spec funcional Fluxo 2**: `docs/logica-fluxo-igor-agente-ativo-promocao.md`
- **Arquitetura técnica viva**: `docs/ARCHITECTURE.md`
- **Referências ASX**: `docs/referencias/workflows-asx/` (NUNCA copiar regras comerciais; apenas padrões técnicos)
- **CSVs Kommo**: `lista-leads/*.csv` (gitignored)
- **Credenciais reais**: `.claude/CREDENCIAIS.md` (gitignored)
- **Importer**: `scripts/import-kommo-csv.py`
- **Seed Chatwoot**: `scripts/seed-chatwoot.sh`

## Backlog futuro (fora de escopo atual)

- [ ] Cleanup cron Postgres para limpar status `sending` órfão (>5min): job manual ou agendado
- [ ] Dashboard SQL/Metabase para métricas Fluxo 2 em tempo real (para Dr. Igor consultar diretamente)
- [ ] Migration consolidando colunas de handoff (`last_handoff_outcome`, `last_handoff_reason`, `last_handoff_at`) em `conversations` para evitar joins em `events`
- [ ] Cleanup de IGOR_TEST_Smoke_Trigger se não for mais necessário (após Fluxo 2 entrar em produção)
