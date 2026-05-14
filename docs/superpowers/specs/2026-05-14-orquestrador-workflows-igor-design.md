# Design — Orquestrador de execução dos workflows IGOR

**Data**: 2026-05-14
**Escopo**: orquestrar a implementação dos 15 JSONs `IGOR_*` (13 canônicos + 2 auxiliares) no n8n, partindo do plano em `docs/WORKFLOW_PLAN.md`.
**Objetivo**: terminar a Fase 4 do `AGENTS.md` com todos os workflows criados (inativos), validados via fixture + asserts SQL/Chatwoot, e commitados granularmente.

---

## 1. Decisões fechadas com o usuário

| # | Decisão |
|---|---|
| 1 | **Autonomia alta** — orquestrador dirige tudo, escala apenas em bloqueio real |
| 2 | **Paralelismo total respeitando dependências** — até 3 subagentes simultâneos quando os workflows são independentes |
| 3 | **TDD strict** — fixture + asserts SQL escritos ANTES do JSON |
| 4 | **Git** — 1 commit por workflow na branch `main`, sem worktrees |

---

## 2. Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  Orquestrador (main agent)                                  │
│  - lê WORKFLOW_PLAN.md + IMPLEMENTATION_PLAN.md            │
│  - mantém TodoList + state JSON                             │
│  - calcula DAG de dependências                              │
│  - despacha subagentes em ondas paralelas (≤3 por vez)      │
│  - valida output de cada subagente                          │
│  - commita por workflow                                     │
│  - escala em bloqueio real (lista fechada — §5)             │
└────────────────┬────────────────────────────────────────────┘
                 │ Agent tool (subagent_type=general-purpose)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Subagente de workflow (1 por IGOR_*, isolado)              │
│  Recebe brief autocontido (template §3.1)                   │
│  Entrega 4 artefatos + 1 commit                             │
│  Reporta JSON estruturado (§3.2) de volta                   │
└─────────────────────────────────────────────────────────────┘
```

- **Sem worktrees / sem branches**: subagentes editam arquivos diferentes, zero conflito esperado.
- **Sem agentes customizados**: os 15 workflows são variações de 4 padrões (webhook, callable, schedule, errorTrigger). `general-purpose` + brief autocontido é suficiente.
- **State do orquestrador** persiste em `.remember/orchestrator-state.json` (gitignored — `.remember/` já está no `.gitignore`).

### State JSON

```json
{
  "workflows": {
    "IGOR_07": {"status": "done", "n8n_id": "abc123", "committed": true},
    "IGOR_04": {"status": "in_progress", "subagent_id": "xyz"},
    "IGOR_06": {"status": "pending", "blocked_by": []}
  },
  "current_wave": 1,
  "blocked": [],
  "escalations": []
}
```

`status` ∈ `pending | in_progress | done | blocked | failed`.

---

## 3. Subagentes — brief e protocolo

### 3.1 Brief autocontido (template)

Cada subagente recebe, no prompt de despacho:

- **Alvo**: nome canônico do workflow (ex: `IGOR_07_Error_Logger`)
- **Contrato**: cópia da entrada de §2 do `IMPLEMENTATION_PLAN.md` (trigger, contrato de entrada, decisões determinísticas, LLM, sub-workflows, mutações, observabilidade)
- **Referência ASX**: caminho + node ranges do JSON ASX a usar como padrão técnico (mapa em §3.3)
- **Arquivos a criar**:
  1. `fixtures/<workflow>-<scenario>.json` (≥1 fixture)
  2. `tests/asserts-<workflow>.sql` (SELECTs que validam o estado pós-execução)
  3. `tests/expected-<workflow>.md` (texto humano: "após X, devo ter Y")
  4. `n8n/workflows/<workflow>.json`
  5. `docs/workflows/<workflow>.md` (1 página: trigger, nodes em ordem, observabilidade)
- **Ordem TDD strict** (7 passos):
  1. Escrever fixture
  2. Escrever asserts SQL
  3. Rodar asserts contra DB vazio → todos falham (esperado, prova que medem)
  4. Construir JSON
  5. `POST /api/v1/workflows` (cria inativo)
  6. `POST /workflows/{id}/execute` com fixture → roda asserts → todos passam
  7. Escrever doc + commit
- **Credentials disponíveis**: subset de `igor_*` (§4)
- **Variáveis do repo**: `.env` (lido com parser seguro, nunca via `source`)
- **Restrições**: nasce inativo · não tocar outros workflows · mascarar tokens · respeitar nomes canônicos
- **Protocolo de retorno**: §3.2

### 3.2 Protocolo de retorno (JSON estruturado)

```json
{
  "status": "success" | "blocked" | "failed",
  "workflow_id": "<n8n id>",
  "files_created": ["...", "..."],
  "commit_sha": "<hash>",
  "test_result": {"asserts_passed": N, "asserts_failed": M},
  "blockers": ["..."],
  "notes": "..."
}
```

### 3.3 Mapa de referência ASX por workflow Igor

| Workflow Igor | Referência ASX | Por quê |
|---|---|---|
| `IGOR_07_Error_Logger` | `05-Error-Logger.json` | errorTrigger + INSERT events |
| `IGOR_04_Tool_Labels_Attributes` | `02-Tool-Label (callable).json` | callable + Chatwoot label merge |
| `IGOR_06_Chatwoot_Message_Logger` | `04-Chatwoot-Message-Logger.json` | webhook Chatwoot + IF + INSERT messages |
| `IGOR_02_Media_Normalizer` | `07-FB-Leads-Inbound.json` (branches de mídia) | switch messageType + transcribe + vision |
| `IGOR_01_Inbound_AfterHours` | `07-FB-Leads-Inbound.json` (entrada + Redis batching) | webhook + extract + Redis Push/Get/IF Last |
| `IGOR_05_Finalize_Handoff` | `03-Finalize-Handoff (callable).json` | UPDATE conversations + assignment + private note |
| `IGOR_03_Agent_AfterHours` | `07-FB-Leads-Inbound.json` (Joao P3 + memory + tools) | LangChain Agent + Postgres Memory + toolWorkflow |
| `IGOR_08_Health_Check` | `08-Health-Check.json` | scheduleTrigger + SQL snapshots + INSERT events |
| `IGOR_11_Campaign_Message_Generator` | (sem ASX — gerador determinístico) | Postgres SELECT + Set substituição `{nome}` |
| `IGOR_12_Campaign_Inbound_Handler` | `07-FB-Leads-Inbound.json` (Switch Lead Type) | Switch por intent + chama IGOR_13 ou opt-out |
| `IGOR_13_Agent_Campaign` | `07-FB-Leads-Inbound.json` (Joao P2/P3) | mesmo padrão IGOR_03, system prompt diferente |
| `IGOR_10_Campaign_Dispatcher` | `06-FB-Leads-Outbound-Webhook.json` | schedule + janela + rate + send |
| `IGOR_AUX_save_lead_partial` | `02C-Agent-Log (callable).json` | callable + Postgres UPSERT simples |
| `IGOR_AUX_update_conversation_state` | (sem ASX — trivial) | callable + Postgres UPDATE |

---

## 4. DAG de dependências e ondas de execução

```
ONDA 1 (paralelo, 3 subagentes):
  IGOR_07_Error_Logger
  IGOR_04_Tool_Labels_Attributes
  IGOR_06_Chatwoot_Message_Logger

ONDA 2 (paralelo, 3 subagentes):
  IGOR_02_Media_Normalizer
  IGOR_AUX_save_lead_partial
  IGOR_AUX_update_conversation_state

ONDA 3 (sequencial, 1 subagente):
  IGOR_01_Inbound_AfterHours              (depende de 02, 04, 07)
  → fim do Bloco 1 do WORKFLOW_PLAN.md

ONDA 4 (sequencial — IGOR_05 ANTES de IGOR_03):
  IGOR_05_Finalize_Handoff                (depende de 04)
  IGOR_03_Agent_AfterHours                (depende de 02, 04, 05, AUX_save, AUX_update)
  → fim do Bloco 2

ONDA 5 (paralelo, 3 subagentes):
  IGOR_08_Health_Check
  IGOR_11_Campaign_Message_Generator
  IGOR_12_Campaign_Inbound_Handler        (com placeholder de IGOR_13)

ONDA 6 (sequencial, 1 subagente):
  IGOR_13_Agent_Campaign                  (depende de 11, 05)
  → orquestrador volta em IGOR_12 e substitui placeholder por chamada real

ONDA 7 (sequencial, 1 subagente):
  IGOR_10_Campaign_Dispatcher             (depende de 11)
  → fim do Bloco 4
```

**Critério de pronto do bloco**: todos os workflows da onda final do bloco têm `status=done`, smoke tests do bloco passam, commits feitos.

---

## 5. Critérios de escalation (orquestrador pausa e me chama)

Lista fechada — fora destes casos, o orquestrador segue sozinho:

1. Subagente retornou `status=blocked` 2x no mesmo workflow.
2. Credential `igor_*` faltando no n8n (descoberta na importação).
3. Migration Supabase faltando (assert depende de coluna/tabela inexistente).
4. Webhook Evolution precisa ser configurado para teste end-to-end (decisão de Fase 5).
5. Modelo `gpt-5.4-mini` produz output muito desviante (prompt precisa revisão clínica/humana).
6. Token Chatwoot/Evolution/OpenAI retornou 401 (precisa rotar).

---

## 6. Testing — TDD strict adaptado a n8n

Cada workflow tem **3 artefatos de teste versionados**:

```
fixtures/<workflow>-<scenario>.json
tests/asserts-<workflow>.sql
tests/expected-<workflow>.md
```

**Loop por workflow:**
1. **Vermelho**: asserts contra estado **antes** da execução → falham (medem o que deveriam — não há `events('infra_error', this_test_run_id)` ainda, por exemplo).
2. **Verde**: JSON importado → executado com fixture → asserts passam (linhas esperadas existem).
3. **Refator**: cleanup de Code nodes ou prompts. Asserts continuam passando.
4. **Commit**: granular, 1 por workflow.

**Como isolar asserts em DB já populado** (temos 137 leads + 1 campaign_run em produção): cada fixture injeta um `test_run_id` único (UUID) no payload, e os asserts filtram por esse id (`WHERE payload->>'test_run_id' = '...'`). Garante que asserts não cruzem com dados reais.

**Bateria por bloco** (após onda final do bloco):
- `scripts/test-block.sh <N>` reroda todos os fixtures do bloco.
- Snapshot SQL antes/depois com diff esperado.

**Bateria end-to-end** (após Bloco 4):
- 10 smoke tests do `IMPLEMENTATION_PLAN.md §10` (AGENTS.md Fase 6).

---

## 7. Error handling

| Erro | Quem trata | Como |
|---|---|---|
| JSON malformado | n8n API rejeita o POST | Subagente lê erro, corrige, reposta. Retry ≤2x. |
| Credential `igor_*` ausente | n8n API erro descritivo | Subagente reporta `blocked`. Orquestrador escala. |
| Asserts não passam após execução | Subagente | Lê logs n8n, ajusta JSON, retenta. Retry ≤2x. |
| Schema Supabase desalinhado | Subagente detecta no assert | Reporta blocker. Orquestrador propõe migration, escala. |
| Subagente travado/timeout | Orquestrador | Mata, retry com brief reforçado. ≤2x. |
| Erro de runtime em workflow ativo | `IGOR_07_Error_Logger` | INSERT events('infra_error'). RUNBOOK descreve investigação. |

**Regra de retry**: máximo 2 tentativas no mesmo workflow. 3ª falha = `failed`, escalation.

---

## 8. Observabilidade

| Sinal | Onde olhar |
|---|---|
| Progresso global | `TaskList` + `.remember/orchestrator-state.json` |
| Resultado de cada subagente | Tool result no transcript + `tests/expected-<workflow>.md` |
| Workflow criado no n8n | `GET /api/v1/workflows` + UI do n8n |
| Comportamento esperado validado | Asserts SQL no Supabase (queries de `tests/asserts-*.sql`) |
| Erros em produção (depois) | `events WHERE event_type='infra_error'` |
| Histórico do que mudou | `git log --oneline` (1 commit por workflow) |

---

## 9. Credentials n8n esperadas (devem existir antes do despacho)

| Nome canônico | Tipo | Onde é usada |
|---|---|---|
| `igor_supabase_service` | HTTP Header Auth | todos os workflows com HTTP Supabase |
| `igor_supabase_postgres` | Postgres (session pooler) | IGOR_03/IGOR_13 (Postgres Chat Memory) |
| `igor_chatwoot_api` | HTTP Header Auth (admin token) | IGOR_04, IGOR_05, IGOR_06 |
| `igor_chatwoot_bot` | HTTP Header Auth (Alice token) | IGOR_03, IGOR_13 (envio de mensagens) |
| `igor_evolution_api` | HTTP Header Auth (apikey) | IGOR_10 (send), IGOR_08 (ping) |
| `igor_openai` | OpenAI API | IGOR_02 (transcribe/vision), IGOR_03, IGOR_13 |
| `igor_redis_embedded` | Redis (n8n embarcado) | IGOR_01 (batching) |

**Onda 1 mínimo necessário**: `igor_supabase_service`, `igor_chatwoot_api`. As demais entram conforme as ondas avançam.

---

## 10. Files & estrutura final

Após orquestração completa, o repo terá:

```
n8n/workflows/
  IGOR_01_Inbound_AfterHours.json
  IGOR_02_Media_Normalizer.json
  IGOR_03_Agent_AfterHours.json
  IGOR_04_Tool_Labels_Attributes.json
  IGOR_05_Finalize_Handoff.json
  IGOR_06_Chatwoot_Message_Logger.json
  IGOR_07_Error_Logger.json
  IGOR_08_Health_Check.json
  IGOR_10_Campaign_Dispatcher.json
  IGOR_11_Campaign_Message_Generator.json
  IGOR_12_Campaign_Inbound_Handler.json
  IGOR_13_Agent_Campaign.json
  IGOR_AUX_save_lead_partial.json
  IGOR_AUX_update_conversation_state.json
  (14 JSONs — IGOR_09 é script Python já existente)

fixtures/
  evolution-text.json, evolution-audio.json, evolution-image.json,
  evolution-document.json, evolution-fromme.json, evolution-group.json,
  chatwoot-message-created-incoming.json,
  chatwoot-message-created-outgoing-bot.json,
  chatwoot-message-created-outgoing-human.json,
  campaign-reply-text.json, campaign-reply-optout.json,
  campaign-reply-price.json, campaign-reply-sensitive.json,
  error-trigger-simulated.json
  health-check-trigger.json
  campaign-dispatch-trigger.json

tests/
  asserts-IGOR_01.sql … asserts-IGOR_13.sql, asserts-IGOR_AUX_*.sql
  expected-IGOR_01.md … expected-IGOR_13.md, expected-IGOR_AUX_*.md

scripts/
  import-workflows.sh    # POST todos os JSONs no n8n
  export-workflows.sh    # GET e salva backups
  test-workflow.sh       # executa 1 workflow com fixture e roda asserts
  test-block.sh          # bateria por bloco

docs/workflows/
  IGOR_01.md … IGOR_13.md, IGOR_AUX_*.md
```

---

## 11. O que o orquestrador NÃO faz (fora de escopo)

- Não ativa workflows (continua manual, via `settings.workflows_enabled.IGOR_XX=true` no Supabase).
- Não toca webhook real da Evolution (Fase 5).
- Não roda WhatsApp real (`ALLOW_REAL_WHATSAPP_SEND=false` continua valendo).
- Não cria as credentials `igor_*` no painel n8n (responsabilidade do usuário).
- Não aplica migrations Supabase (essas continuam manuais no SQL Editor).

---

## 12. Próximo passo após aprovação desta spec

Invocar `superpowers:writing-plans` com esta spec como input. A skill writing-plans transforma o design em plano de implementação executável (passos numerados, critérios de aceite por passo, comandos exatos).
