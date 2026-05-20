# Refatoração Fluxo 1 (Inbound After-Hours) — 2026-05-16

Notas de mudança da refatoração que resolve o problema "IA respondia qualquer mensagem fora do expediente" e introduz a arquitetura de **1 inbox WhatsApp + 3 teams** com gate determinístico via `owner_flow`.

Este doc complementa ARCHITECTURE.md, logica-fluxo-igor-receptivo-fora-expediente.md e VALIDATION_REPORT.md. Integrar nesses arquivos quando a refatoração entrar em smoke verde.

## Mudança arquitetural central

**Antes**: gate de bloqueio humano era `conversations.human_locked OR !ai_enabled`. Só bloqueava se IGOR_05 fizesse handoff explícito. Resultado: lead que conversou com atendente durante o dia recebia IA à noite.

**Depois**: gate primário é `conversations.owner_flow IN (...)` no Supabase. Setado por:
- IGOR_01_v2 ao receber primeira mensagem do lead → `ai_active` (e cria `journey_started_at`).
- IGOR_01_v2 ao detectar "jornada já iniciada" ou "dentro expediente" → `human_daytime`.
- IGOR_05_v2 no handoff → `handoff_queue` (qualified) | `ai_unqualified` (caminho B) | `compliance_hold` (mídia clínica).
- IGOR_06 ao detectar humano respondendo no Chatwoot → `human_daytime`.

A IA só atua quando `owner_flow='ai_active'` E `journey_started_at IS NULL` (a primeira chamada do IGOR_01_v2 marca a jornada como iniciada — daí em diante a mensma conversation nunca mais é "novo").

## Decisão "lead novo" — janela de reativação

**Nunca trata como novo**. Uma vez que `journey_started_at` é setado, a conversation está em jornada. Lead que sumiu por semanas e voltar não é tratado como "novo". A coluna nunca é resetada.

## Topologia Chatwoot (3 teams na mesma inbox WhatsApp)

| Chave técnica (`owner_flow`) | Nome na UI Chatwoot | Quando aplica |
|---|---|---|
| `ai_active` | IA Após-Expediente | IGOR_01_v2 acabou de assumir lead novo fora expediente |
| `human_daytime` | Atendimento Humano | Dentro expediente, ou jornada já iniciada, ou humano respondeu |
| `handoff_queue` | Aguardando Retorno | Caminho A (qualificado) OU caminho B (não engajou) — atendente decide |

`compliance_hold` (mídia clínica) e `opt_out` aparecem em `Atendimento Humano` (urgência) e em filtros próprios.

## Workflows tocados

| Workflow | Ação | ID novo / mantido | Nodes |
|---|---|---|---|
| `IGOR_01_Inbound_AfterHours_v2` | Criado do zero | **`D9ca4uoK9hN6YGux`** | 33 |
| `IGOR_05_Finalize_Handoff_v2` | Criado do zero | **`mfB7MGpCYSPQvRSx`** | 25 |
| `IGOR_03_Agent_AfterHours` | `update_workflow` (mesmo ID) | `iQCVbe1P8dC0vhay` | 27 |
| `IGOR_06_Chatwoot_Message_Logger` | `update_workflow` (mesmo ID) | `xpXRENR7Hoo2W5p3` | 17 |
| `IGOR_AUX_update_conversation_state` | **PENDENTE** (MCP bloqueado) | `mFuRPrGGt7yWVqEw` | — |
| `IGOR_01_Inbound_AfterHours` antigo | Arquivado | `nC6ZhCVNn1fQiKfB` | — |
| `IGOR_05_Finalize_Handoff` antigo | Arquivado | `N31QcdrNVE5AOZdu` | — |
| `IGOR_02`, `IGOR_04`, `IGOR_07`, `IGOR_08`, `IGOR_AUX_save_lead_partial` | Sem alteração | — | — |

## Contratos de input (novos)

### IGOR_05_v2 (`mfB7MGpCYSPQvRSx`)

```
chatwoot_conversation_id, chatwoot_contact_id, lead_id,
outcome: 'qualified' | 'unqualified' | 'compliance',  // NEW
lead_name,                                             // NEW
handoff_reason, summary, callback_period, test_run_id
```

Removeu o param `owner_flow` antigo — agora é derivado de `outcome` internamente.

### IGOR_AUX_update_conversation_state (pendente)

Adiciona 3 params opcionais (backwards-compatible):

```
owner_flow: string        // ex: 'ai_active', 'human_daytime'
set_journey_started: bool // se true, seta journey_started_at = now() (idempotente: só seta uma vez)
increment_turn_count: bool // se true, turn_count += 1
```

## Migrations Supabase (aplicar no Studio)

1. `supabase/migrations/013_settings_teams_and_flow.sql` — 3 chaves novas (`ai_team_id`, `human_daytime_team_id`, `handoff_queue_team_id`) + `max_alice_turns=6`. Valores começam `null`, preencher com IDs reais do Chatwoot após seed.
2. `supabase/migrations/014_conversations_owner_flow.sql` — 3 colunas novas em `conversations` (`journey_started_at`, `owner_flow`, `turn_count`) + índice `idx_conversations_owner_flow` + backfill de `owner_flow` a partir das flags atuais.

## Seed Chatwoot (rodar com ALLOW_PRODUCTION_MUTATIONS=true)

`scripts/seed-chatwoot.sh` ganhou:
- Função `create_team()` — cria 3 teams ("IA Após-Expediente", "Atendimento Humano", "Aguardando Retorno") idempotente.
- 4 labels novos: `lead_novo`, `lead_qualificado`, `nao_qualificado_ia`, `aguardando_humano_proximo_expediente`.
- 2 custom_attributes novos (conversation): `handoff_outcome` (lista), `turn_count` (number).
- Removida criação do `agent_bot` Alice (mantém o existente inativo).

Saída do script imprime os 3 team_ids para popular settings:

```sql
UPDATE settings SET value='<id>'::jsonb WHERE key='ai_team_id';
UPDATE settings SET value='<id>'::jsonb WHERE key='human_daytime_team_id';
UPDATE settings SET value='<id>'::jsonb WHERE key='handoff_queue_team_id';
```

## IGOR_01_v2 — fluxo determinístico (33 nodes)

```
Evolution Webhook (path: igor/inbound)
  → Normalize Payload (Code: parse Evolution + phone validation)
  → Load State (Postgres: 1 query consolidada — settings, contact, conversation, campaign)
  → Compute Gates (Code: avalia todos os gates em memória)
  → Has Block Reason?
    → True: INSERT inbound_blocked + Resp blocked
    → False:
       Move to Human? (inside_business_hours OR !is_new_lead_journey)
         → True: UPSERT conv owner_flow=human_daytime + POST Assign Human Team + INSERT moved_to_human + Resp
         → False:
            Redis Lock INCR (key igor:lock:inbound:{phone}, ttl 30)
              Got Lock? (counter === 1)
                → False: RPUSH fragment + INCR marker + Resp batched (espera lock holder processar)
                → True: Wait 3s → LRANGE batch → DEL batch → Merge Fragments
                          → Has Media?
                              → True: CALL IGOR_02 Media
                              → False: passthrough
                          → Build Output → UPSERT conv ai_active (journey_started_at=now, turn_count=1)
                          → INSERT message → POST Assign AI Team → CALL IGOR_04 (labels lead_novo, fora_expediente, ai_after_hours)
                          → CALL IGOR_03 Agent → Redis DEL lock → Resp routed
```

Gate `Has Block Reason` (composto, single expression em Code):
- `fromMe`, `!ai_enabled_global`, `!workflows_enabled.IGOR_01`, `!phone_valid`, `do_not_contact`, `owner_flow IN ('human_daytime','handoff_queue','ai_unqualified','compliance_hold','opt_out')`, `has_campaign_active`.

Gate `is_new_lead_journey`: `journey_started_at IS NULL`. UPSERT seta `journey_started_at=COALESCE(existing, now())` — uma única vez.

## IGOR_05_v2 — ramificação A/B/C (25 nodes)

`Validate Payload` (Code) deriva por `outcome`:

| outcome | owner_flow setado | target_team_id | labels (add) | mensagem final |
|---|---|---|---|---|
| `qualified` | `handoff_queue` | settings.handoff_queue_team_id | handoff_done, lead_qualificado, aguardando_atendente, callback_horario_coletado | "Combinado{,nome}. A equipe vai entrar em contato {período}." |
| `unqualified` | `ai_unqualified` | settings.handoff_queue_team_id | nao_qualificado_ia, ai_disabled, handoff_done | "Tudo bem{,nome}. Quando quiser retomar é só me chamar por aqui." |
| `compliance` | `compliance_hold` | settings.human_daytime_team_id | compliance_humano, ai_disabled, handoff_done | "Pra esse tipo de conteúdo, preciso passar pro nosso time olhar com cuidado. A equipe entra em contato no próximo expediente." |

Load Gates lê settings com fallback `team_id=1` (se ainda não populadas).

## IGOR_03 — mudanças no agent Alice

- System prompt revisado: lead novo, coletar nome+objetivo+período, max 6 turnos, outcome obrigatório no `request_handoff`.
- Tool `request_handoff`: aponta para IGOR_05_v2 (`mfB7MGpCYSPQvRSx`), schema ganha `outcome` (`qualified|unqualified|compliance`) e `lead_name`.
- Tool `update_conversation_state`: passa `owner_flow="ai_active"` e `increment_turn_count=true` em cada chamada (turn_count rastreia turnos).
- Compliance fast-path: payload usa `outcome="compliance"` no IGOR_05_v2.

## IGOR_06 — gate reativo

- `UPDATE conversations` ao detectar `human_takeover` (atendente respondeu no Chatwoot) agora seta também `owner_flow='human_daytime'` (não só `human_locked=true, ai_enabled=false`).
- `CALL IGOR_04` passa `custom_attributes.conversation.owner_flow='human_daytime'`.

Isso garante que próxima mensagem do lead na mesma conversation cai no gate de bloqueio do IGOR_01_v2.

## BYPASS removido

A linha de "BYPASS smoke test 2026-05-15" do IGOR_01 antigo não existe no IGOR_01_v2. Gate `Inside Business Hours` é puro: `Intl.DateTimeFormat` + `settings.holidays` + `holiday_policy`.

## Aplicação manual antes de smoke

1. Aplicar `013_settings_teams_and_flow.sql` no Supabase Studio.
2. Aplicar `014_conversations_owner_flow.sql` no Supabase Studio.
3. Habilitar `Available in MCP` no workflow `IGOR_AUX_update_conversation_state` (UI n8n → Settings) — desbloqueia upload do AUX v2.
4. Rodar `bash scripts/seed-chatwoot.sh` com `ALLOW_PRODUCTION_MUTATIONS=true` (cria 3 teams, 4 labels, 2 attrs novos no Chatwoot).
5. Popular team_ids em settings (output do seed mostra os 3 UPDATEs prontos).
6. Wire credenciais HTTP nos 6 nodes que MCP não auto-resolveu:
   - IGOR_05_v2 (`mfB7MGpCYSPQvRSx`): POST Private Note, POST Assign Team, POST Assign Assignee, Evolution sendText → `igor_chatwoot_api` ou `igor_evolution_api`.
   - IGOR_01_v2 (`D9ca4uoK9hN6YGux`): POST Assign Human Team, POST Assign AI Team → `igor_chatwoot_api`.
7. Setar `errorWorkflow=ZrsbaSTlW5bqMEaS` (IGOR_07) nas configurações dos 2 novos workflows.
8. Reapontar webhook Evolution para o path `igor/inbound` do novo IGOR_01_v2 (o path é o mesmo — só confirma que aponta para o workflow novo `D9ca4uoK9hN6YGux`, não o arquivado `nC6ZhCVNn1fQiKfB`).
9. Atualizar AUX v2 (após habilitar MCP no passo 3) — SDK pronto em `n8n/workflows/IGOR_AUX_update_conversation_state.sdk.ts`.

## Smoke tests recomendados

1. **Lead novo fora expediente** → IGOR_01_v2 → IGOR_03 Alice → coleta nome+objetivo+período → request_handoff(qualified) → IGOR_05_v2 caminho A → conversation aparece no team "Aguardando Retorno" com label `lead_qualificado`.
2. **Jornada existente fora expediente** → forçar uma row em conversations com `journey_started_at=now()-interval'1 hour'` → enviar webhook → IGOR_01_v2 gate "is_new_lead_journey=false" → conversation movida para team "Atendimento Humano", IA não responde.
3. **Dentro expediente** → settings.after_hours_start/end ajustados → IGOR_01_v2 gate "inside_business_hours" → conversation movida para "Atendimento Humano".
4. **Caminho B (não qualificado)** → simular conversa com Alice em que lead disengage / atinge 6 turnos → request_handoff(unqualified) → IGOR_05_v2 caminho B → conversation com label `nao_qualificado_ia`, team "Aguardando Retorno".
5. **Humano responde no Chatwoot** → atendente envia mensagem manual → IGOR_06 detecta human_takeover → UPDATE conv owner_flow=human_daytime → próxima mensagem do lead à noite NÃO aciona Alice.

## Dívida residual

- `IGOR_AUX_update_conversation_state` aguardando MCP habilitar para receber novos params.
- 6 nodes HTTP precisam wire manual de credenciais (não há suporte SDK para auto-resolver httpHeaderAuth genérico).
- `errorWorkflow` precisa ser setado manualmente nos 2 workflows novos.
- Docs grandes (ARCHITECTURE.md, logica-fluxo-*.md, VALIDATION_REPORT.md) — integrar este doc nelas após smoke verde.
