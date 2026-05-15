# IGOR_05_Finalize_Handoff

## Status

| Campo | Valor |
|---|---|
| n8n workflow ID | `N31QcdrNVE5AOZdu` |
| Active | `false` (default seguro Fase B) |
| Nodes | 24 |
| errorWorkflow | `ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger) |
| Tags | `igor`, `inbound`, `handoff`, `fase-b-rebuild` |
| Wave | 2 (Inbound rebuild) |
| Source of truth | `n8n/workflows/IGOR_05_Finalize_Handoff.json` (canonical) + `IGOR_05_Finalize_Handoff.sdk.ts` (generator, documentado) |

## Função

Callable invocado por IGOR_03 (after_hours agente) e IGOR_13 (campaign agente) para finalizar o handoff IA → humano. Substitui versão revertida (`54af750`) que tinha gaps documentados em `docs/superpowers/debt/2026-05-15-simplifications-to-revert.md` §4.

Sequência **OBRIGATÓRIA** (NO SIMPLIFICATIONS — replica fielmente contrato em `docs/IMPLEMENTATION_PLAN.md` linhas 156-171 e spec §13/§15 em `docs/logica-fluxo-igor-receptivo-fora-expediente.md`):

| Passo | Descrição | Node n8n |
|---|---|---|
| 0 | Validate Payload (coerce, defaults, gates pré-computados, template PT-BR) | `Validate Payload` |
| 1 | UPDATE conversations (state=human_assigned, ai_enabled=false, human_locked=true, assigned_team_id) | `UPDATE conversations` |
| 2 | UPDATE leads (status=aguardando_atendente, handoff_at) — **apenas se lead_id**| `Has lead_id?` → `UPDATE leads` ou `No Lead Passthrough` |
| 3 | Chamar IGOR_04 (labels add/remove + custom_attributes.conversation) | `Call IGOR_04` (executeWorkflow → AJF7dhGrqJEXMLqz) |
| 4 | POST private note Chatwoot (template PT-BR LITERAL) | `POST Private Note` |
| 5 | POST assign team Chatwoot (team_id=$CHATWOOT_HUMAN_TEAM_ID) | `POST Assign Team` |
| 6 | POST assign assignee (apenas se $CHATWOOT_HUMAN_ASSIGNEE_ID setado) | `Has Assignee?` → `POST Assign Assignee` ou `No Assignee Passthrough` |
| 7 | INSERT events('handoff_complete', payload) | `Log handoff_complete` |
| 8a | SELECT phone do contato | `Get Lead Phone` |
| 8b | Send gate: ALLOW_REAL_WHATSAPP_SEND='true' AND IGOR_DRY_RUN!='true' → real; senão dry | `Should Send Real?` |
| 8c (real) | POST Evolution sendText + INSERT events('whatsapp_sent') | `Evolution sendText` → `Log whatsapp_sent` |
| 8c (dry) | INSERT events('dry_run_send', reason=...) | `Log dry_run_send` |
| 9 | Merge branches → Final Summary `{ok, lead_updated, labels_applied, message_sent, send_mode, handoff_reason, test_run_id}` | `Merge Send Branches` → `Final Summary` |

## Contrato (entrada)

```json
{
  "chatwoot_conversation_id": "string (required) — id Chatwoot da conversa, cast int no SQL",
  "chatwoot_contact_id":      "string (optional) — id Chatwoot do contato",
  "lead_id":                  "string (optional UUID) — se ausente, não há UPDATE em leads",
  "handoff_reason":           "string (required) — ex: after_hours_callback, compliance_hold, documento_clinico_sensivel",
  "summary":                  "string (required) — resumo livre PT-BR",
  "callback_period":          "string (optional) — ex: 'amanhã de manhã'",
  "owner_flow":               "string (required) — after_hours|campaign",
  "test_run_id":              "string (optional) — para asserts de smoke"
}
```

## Contrato (saída)

```json
{
  "ok": true,
  "lead_updated": true,         // boolean — reflete se branch lead foi tomada
  "labels_applied": true,       // boolean — IGOR_04 foi chamado sem erro
  "message_sent": "real|dry",   // qual branch send foi tomado
  "send_mode": "real|dry_run",  // duplicado p/ clareza
  "handoff_reason": "...",
  "test_run_id": "..."
}
```

## Send gate (decisão crítica)

Implementado em `Validate Payload` (Code node), exposto como `_should_send_real` (boolean), e branched em `Should Send Real?` (IF node).

| `ALLOW_REAL_WHATSAPP_SEND` | `IGOR_DRY_RUN` | Branch | Effect |
|---|---|---|---|
| `'true'` | `'false'` (ou unset) | `True` | POST `${EVOLUTION_BASE_URL}/message/sendText/${INSTANCE}` com `{number, text}` + INSERT `events('whatsapp_sent')` |
| `'true'` | `'true'` | `False` | INSERT `events('dry_run_send', reason='igor_dry_run=true')` |
| `'false'` (ou unset) | qualquer | `False` | INSERT `events('dry_run_send', reason='allow_real_whatsapp_send=false')` |

Default seguro: `.env.example` traz `IGOR_DRY_RUN=true` e `ALLOW_REAL_WHATSAPP_SEND=false` → workflow nunca envia real até ativação explícita.

**Resolução do debt anterior** (`debt/2026-05-15-simplifications-to-revert.md` §4): a versão revertida sempre escrevia `events('dry_run_send')` hardcoded sem checar env. Esta versão tem branch real funcional.

## Template private note (PT-BR LITERAL)

Construído em `Validate Payload` como `private_note_content`. Inalterável (acentos LITERAIS):

```
📋 *Resumo automático Igor (handoff {owner_flow})*

Motivo: {handoff_reason}
{callback_line — "Período preferido de retorno: {callback_period}\n" se callback_period definido}

Resumo da conversa:
{summary}

Lead status: aguardando_atendente
IA: desligada nesta conversa (ai_enabled=false, human_locked=true)
```

POST body:
```json
{
  "content": "<template acima>",
  "private": true,
  "message_type": "outgoing",
  "content_type": "text"
}
```

## Mensagem final ao lead (PT-BR LITERAL)

```
Combinado! Já anotei tudo aqui e nossa equipe vai retornar no horário que você preferiu. Qualquer coisa nova, é só me responder. 💛
```

Inalterável. Envio acontece **somente** na branch real do send gate.

## Payload entregue a IGOR_04

Construído em `Validate Payload` como `igor04_payload_json` (string JSON serializada):

```json
{
  "chatwoot_conversation_id": "<input>",
  "chatwoot_contact_id":      "<input>",
  "labels_to_add":            ["handoff_done", "ai_disabled", "aguardando_atendente"],
  "labels_to_remove":         ["qualificacao_rapida", "callback_solicitado"],
  "custom_attributes": {
    "conversation": {
      "automation_state":  "human_assigned",
      "lead_status":       "aguardando_atendente",
      "handoff_reason":    "<input>",
      "handoff_at":        "<ISO timestamp>",
      "owner_flow":        "<input>",
      "ai_enabled":        false,
      "callback_period":   "<input opcional — incluído só se presente>"
    },
    "contact": {}
  },
  "test_run_id": "<input>"
}
```

## Credentials utilizadas

| Credential name | Tipo n8n | Nós que usam | Status |
|---|---|---|---|
| `igor_supabase_postgres` | `postgres` | `UPDATE conversations`, `UPDATE leads`, `Log handoff_complete`, `Get Lead Phone`, `Log whatsapp_sent`, `Log dry_run_send` | ✅ Auto-assigned pelo MCP create |
| `igor_chatwoot_api` | `httpHeaderAuth` | `POST Private Note`, `POST Assign Team`, `POST Assign Assignee` | ⚠️ Existe; **precisa atribuir manualmente** no editor n8n (MCP create_workflow não auto-atribui httpHeaderAuth) |
| `igor_evolution_api` | `httpHeaderAuth` | `Evolution sendText` | ❌ **Soft blocker**: credential pode não existir em staging (Fase B-7 audit do IGOR_08 documentou ausência). Como send gate cai em dry por default, workflow funciona; só impede o real-send até credential ser criada. |

## Env vars consumidas

- `CHATWOOT_BASE_URL` (URL)
- `CHATWOOT_ACCOUNT_ID` (string/int)
- `CHATWOOT_HUMAN_TEAM_ID` (int como string em env)
- `CHATWOOT_HUMAN_ASSIGNEE_ID` (int como string em env — opcional)
- `EVOLUTION_BASE_URL` (URL)
- `EVOLUTION_INSTANCE_NAME` (string)
- `ALLOW_REAL_WHATSAPP_SEND` (`'true'`/`'false'`)
- `IGOR_DRY_RUN` (`'true'`/`'false'`)

## Mutações persistidas

Em **Supabase**:
- `conversations.state = 'human_assigned'`, `ai_enabled = false`, `human_locked = true`, `assigned_team_id`, `updated_at = now()`.
- `leads.status = 'aguardando_atendente'`, `handoff_at = now()`, `updated_at = now()` (apenas se `lead_id`).
- `events('handoff_complete', payload)` (sempre).
- `events('whatsapp_sent', payload)` OU `events('dry_run_send', payload)` (mutualmente exclusivo via gate).

Em **Chatwoot**:
- POST `/conversations/{id}/messages` com `private: true` (private note PT-BR).
- POST `/conversations/{id}/assignments` body `{team_id}`.
- (Opcional) POST `/conversations/{id}/assignments` body `{assignee_id}`.
- Labels/custom_attributes: aplicados via IGOR_04 (delega merge).

Em **Evolution API** (apenas se gate=real):
- POST `/message/sendText/{instance}` body `{number, text}`.

## Idempotência

- UPDATE conversations: idempotente (mesma operação em sequência produz mesmo estado).
- UPDATE leads: idempotente; `handoff_at` é sobrescrito (segunda chamada move o timestamp — aceitável, indica reentrada).
- IGOR_04 labels: merge garante idempotência (não remove o que já está).
- IGOR_04 custom_attributes: PATCH no Chatwoot é idempotente.
- Private note: **NÃO idempotente** — cada execução cria uma nova mensagem. Workflow não deve ser re-executado para a mesma conversa salvo se intencional. Mitigação: `IGOR_06_Chatwoot_Message_Logger` registra `human_assumed` e bloqueia novos handoffs por outras rotas.
- events('handoff_complete'/'whatsapp_sent'/'dry_run_send'): cada execução insere novo evento. Asserts SQL filtram por `test_run_id` para isolar.

## Testes

| Fixture | Path | Foco |
|---|---|---|
| `IGOR_05_handoff_with_lead_callback.json` | `fixtures/` | Happy path completo, lead_id + callback_period |
| `IGOR_05_handoff_no_lead.json` | `fixtures/` | Sem lead_id (compliance precoce) — `Has lead_id?` → False |
| `IGOR_05_handoff_compliance_clinical.json` | `fixtures/` | handoff_reason=documento_clinico_sensivel, com lead_id |
| `IGOR_05_handoff_dry_run.json` | `fixtures/` | Valida explicitamente o gate dry |

Asserts SQL: `tests/asserts-IGOR_05_Finalize_Handoff.sql`. Expected: `tests/expected-IGOR_05_Finalize_Handoff.md` (inclui SQL de seed das preconditions).

## Pendências / next steps

1. **Atribuir credential `igor_chatwoot_api` aos 3 HTTP nodes Chatwoot** no editor n8n (MCP create não auto-atribui httpHeaderAuth genérico). Ou rodar PATCH cirúrgico por `nodeId` + `credentials.httpHeaderAuth.id`.
2. **Criar credential `igor_evolution_api`** no n8n (atualmente missing). Sem ela, branch real do send gate explode caso seja acionado. Mitigado pelo default seguro `ALLOW_REAL_WHATSAPP_SEND=false`.
3. **Seed das fixtures no DB** (vide bloco SQL em `tests/expected-IGOR_05_Finalize_Handoff.md`) antes de smoke.
4. **Smoke integrado em Fase C**: rodar 4 fixtures via `mcp__n8n-mcp__execute_workflow` + executar asserts.
5. **Reviewer de qualidade de fluxo (Fase C)**: comparar com `docs/logica-fluxo-igor-receptivo-fora-expediente.md` §13/§14.5/§15 linha-a-linha.
6. **Real-send validation**: depois de credential Evolution criada, rodar 1 smoke com `ALLOW_REAL_WHATSAPP_SEND=true IGOR_DRY_RUN=false` para número de teste autorizado.

## Não feito (intencional — fora do escopo da Task 5)

- Ativação do workflow (`active: true`) — fica para approval explícito do usuário em Fase C/D.
- Wiring com IGOR_03 (este chama IGOR_05 via tool `request_handoff`) — Task 8 / Fase B-6.
- Teste real-send — depende de credential + número autorizado.
- Validação literal do conteúdo da private note no Chatwoot (precisa mock HTTP ou ambiente staging com Chatwoot acessível).
