# IGOR_04_Tool_Labels_Attributes

## Identificação
- **n8n_id**: `AJF7dhGrqJEXMLqz`
- **n8n URL**: `https://n8n.almaconvert.com.br/workflow/AJF7dhGrqJEXMLqz`
- **Estado inicial**: `active: false` (ativação manual no UI após Fase C).
- **Tipo**: callable (sub-workflow) invocado via `executeWorkflow`.

## Contrato literal (de `docs/IMPLEMENTATION_PLAN.md:144-154`)

```text
- Trigger: callable (executeWorkflowTrigger).
- Entrada: { chatwoot_conversation_id, chatwoot_contact_id?, labels_to_add: [], labels_to_remove: [], custom_attributes: { conversation: {}, contact: {} } }
- Decisões:
  - GET labels atuais da conversa e do contato.
  - Mesclar `add` com lista atual (não sobrescrever), remover apenas o explicitado.
  - PATCH custom_attributes (não DELETE).
- LLM: não.
- Sub-workflows: nenhum.
- Mutações: labels e custom_attributes no Chatwoot.
- Observabilidade: events('label_added'), events('attribute_set').
```

## Gates aplicados
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger) — **persistido no JSON canônico** (`settings.errorWorkflow`). Aplicado automaticamente quando o workflow é importado via JSON ou via n8n REST API. Verifique no UI se um reimport from SDK ocorrer (vide nota em `IGOR_04_Tool_Labels_Attributes.sdk.ts`).
- `active: false` por padrão — **persistido no JSON canônico**. Ativação manual no UI após validação em Fase C.
- `tags: ['igor', 'inbound', 'tool', 'fase-b-rebuild']` — **persistido no JSON canônico**. Aplicado em import.
- `availableInMCP: true` — habilita gestão via n8n MCP (`archive_workflow`, `get_workflow_details` etc).
- Sem trigger externo (webhook/cron) — sem necessidade de `settings.workflows_enabled.IGOR_04` check; invocação só vem de outros workflows IGOR_*.
- LLM: zero. Workflow é determinístico puro (matriz, set, HTTP, postgres).

## Inputs (workflowInputs do trigger)

| name                       | type   | required | descrição |
|----------------------------|--------|----------|-----------|
| `chatwoot_conversation_id` | string | sim      | id da conversa Chatwoot (string para compatibilidade com URLs). |
| `chatwoot_contact_id`      | string | não      | id do contato Chatwoot. Se ausente, branch attrs_contact é skippada. |
| `labels_to_add`            | array  | não      | lista de labels a adicionar (default `[]`). |
| `labels_to_remove`         | array  | não      | lista de labels a remover (default `[]`). |
| `custom_attributes`        | object | não      | `{conversation: {}, contact: {}}` (defaults). |
| `test_run_id`              | string | não      | propaga em `payload.test_run_id` dos eventos para filtragem em asserts SQL de Fase C. |

## Node-by-node summary

| # | Node name                       | Type                                | Função |
|---|---------------------------------|-------------------------------------|--------|
| 1 | Execute Workflow Trigger        | `executeWorkflowTrigger@1.1`        | recebe inputs do caller. |
| 2 | Validate Payload                | `code@2` (runOnceForAllItems)       | coerce types; computa `_skip_labels`, `_skip_attrs_conversation`, `_skip_attrs_contact`; serializa attrs em JSON para queries. Throws se `chatwoot_conversation_id` ausente. |
| 3 | Skip Labels?                    | `if@2.3`                            | `_skip_labels === true` → onTrue passthrough; onFalse executa branch labels. |
| 4 | GET Current Labels              | `httpRequest@4.4`                   | GET `{CHATWOOT_BASE_URL}/api/v1/accounts/{ACCOUNT_ID}/conversations/{id}/labels` com header auth `igor_chatwoot_api`. |
| 5 | Merge Labels                    | `code@2`                            | calcula `merged = (current ∪ add) \ remove`, `added_deltas`, `removed_deltas`; gera `label_events_json` array para INSERT. |
| 6 | POST Merged Labels              | `httpRequest@4.4`                   | POST `{...}/conversations/{id}/labels` body `{labels: merged}`. |
| 7 | Log Label Events                | `postgres@2.6` (executeQuery)       | INSERT N linhas em `events` via `jsonb_array_elements($1::jsonb)`. Usa `igor_supabase_postgres`. |
| 8 | Labels Branch Output            | `set@3.4`                           | emite `{branch: 'labels', labels_added, labels_removed}` para o Merge final. |
| 9 | Labels Branch Skipped           | `set@3.4`                           | emite `{branch: 'labels_skipped', labels_added: [], labels_removed: []}`. |
| 10 | Skip Attrs Conversation?       | `if@2.3`                            | `_skip_attrs_conversation === true` → onTrue passthrough; onFalse executa branch. |
| 11 | POST Conversation Attrs        | `httpRequest@4.4`                   | POST `{...}/conversations/{id}/custom_attributes` body `{custom_attributes: <obj>}`. |
| 12 | Log Conversation Attr Event    | `postgres@2.6` (executeQuery)       | INSERT 1 linha `events('attribute_set', {scope:'conversation', keys:[...], chatwoot_conversation_id, test_run_id})`. |
| 13 | Attrs Conversation Output      | `set@3.4`                           | emite `{branch:'attrs_conversation', attrs_conversation_keys}`. |
| 14 | Attrs Conversation Skipped     | `set@3.4`                           | emite `{branch:'attrs_conversation_skipped', attrs_conversation_keys: []}`. |
| 15 | Skip Attrs Contact?            | `if@2.3`                            | `_skip_attrs_contact === true` → onTrue passthrough; onFalse executa branch. |
| 16 | PUT Contact Attrs              | `httpRequest@4.4`                   | PUT `{...}/contacts/{contact_id}` body `{custom_attributes: <obj>}`. |
| 17 | Log Contact Attr Event         | `postgres@2.6` (executeQuery)       | INSERT 1 linha `events('attribute_set', {scope:'contact', keys, chatwoot_contact_id, chatwoot_conversation_id, test_run_id})`. |
| 18 | Attrs Contact Output           | `set@3.4`                           | emite `{branch:'attrs_contact', attrs_contact_keys}`. |
| 19 | Attrs Contact Skipped          | `set@3.4`                           | emite `{branch:'attrs_contact_skipped', attrs_contact_keys: []}`. |
| 20 | Merge Branches                  | `merge@3.2` (append, numberInputs:3) | aguarda os 3 branches e concatena. |
| 21 | Final Summary                   | `set@3.4` (executeOnce: true)        | aggregate de `labels_added`, `labels_removed`, `attrs_conversation_keys`, `attrs_contact_keys`, `test_run_id`, `ok: true`. |

### Fluxo de conexões
```
Execute Workflow Trigger
  → Validate Payload
      → Skip Labels?
          onFalse → GET Current Labels → Merge Labels → POST Merged Labels → Log Label Events → Labels Branch Output → Merge Branches[0]
          onTrue  → Labels Branch Skipped → Merge Branches[0]
      → Skip Attrs Conversation?
          onFalse → POST Conversation Attrs → Log Conversation Attr Event → Attrs Conversation Output → Merge Branches[1]
          onTrue  → Attrs Conversation Skipped → Merge Branches[1]
      → Skip Attrs Contact?
          onFalse → PUT Contact Attrs → Log Contact Attr Event → Attrs Contact Output → Merge Branches[2]
          onTrue  → Attrs Contact Skipped → Merge Branches[2]
  Merge Branches → Final Summary (executeOnce)
```

A saída do **Validate Payload** fanouts para os 3 IFs em paralelo (não há multiplicação de items porque o callable recebe sempre 1 item).

## Credentials configuradas
- `igor_supabase_postgres` — auto-assigned pelo MCP nos 3 nodes Postgres (`Log Label Events`, `Log Conversation Attr Event`, `Log Contact Attr Event`).
- `igor_chatwoot_api` — **a configurar manualmente** nos 4 nodes HTTP (`GET Current Labels`, `POST Merged Labels`, `POST Conversation Attrs`, `PUT Contact Attrs`). O MCP não auto-assigna `httpHeaderAuth`; a credential já existe no n8n, falta apenas wirear nos nodes.

## Mutações produzidas

### Chatwoot
- `POST /api/v1/accounts/{account_id}/conversations/{id}/labels` body `{labels: [...complete merged list...]}` — substitui a lista completa de labels da conversa, mas a lista enviada já mescla a atual + deltas.
- `POST /api/v1/accounts/{account_id}/conversations/{id}/custom_attributes` body `{custom_attributes: {...}}` — atualiza (merge no Chatwoot, não DELETE) custom_attributes da conversa.
- `PUT /api/v1/accounts/{account_id}/contacts/{id}` body `{custom_attributes: {...}}` — atualiza custom_attributes do contato.

### Supabase
- `INSERT INTO public.events` rows de `event_type` em `['label_added', 'label_removed', 'attribute_set']`.

## Comparação com debt (versão simplificada anterior)

**Antes** (commit `880e32c`, revertido em Fase A):
- ✅ Merge labels.
- ❌ Branch `custom_attributes` **totalmente ausente** (nem conversation, nem contact).
- Consequência: IGOR_03, IGOR_05, IGOR_06 conseguiam aplicar labels mas não persistir `automation_state`, `lead_status`, `callback_period`, `handoff_reason` etc. no Chatwoot. Atendentes humanas perdiam contexto da conversa.

**Agora** (commit desta task, NO SIMPLIFICATIONS rebuild):
- ✅ Merge labels (GET + Code + POST + INSERT events).
- ✅ Branch conversation attrs (POST + INSERT events).
- ✅ Branch contact attrs (PUT + INSERT events).
- ✅ 3 branches são **independentes** — payloads parciais (só labels, só attrs, mix) são suportados via IF guards.
- ✅ Eventos `attribute_set` com `scope ∈ {conversation, contact}` permitem auditoria fina.

## Como invocar (de outros workflows IGOR_*)

```javascript
// Em IGOR_01, IGOR_03, IGOR_05, IGOR_06 — node executeWorkflow:
{
  workflowId: 'AJF7dhGrqJEXMLqz', // ou referência por nome em modo development
  workflowInputs: {
    chatwoot_conversation_id: '{{ $json.chatwoot_conversation_id }}',
    chatwoot_contact_id: '{{ $json.chatwoot_contact_id }}', // opcional
    labels_to_add: ['handoff_done', 'ai_disabled'],
    labels_to_remove: [],
    custom_attributes: {
      conversation: { automation_state: 'human_assigned' },
      contact: {}
    },
    test_run_id: '{{ $json.test_run_id }}' // opcional
  }
}
```

Saída esperada:
```json
{
  "ok": true,
  "labels_added": ["handoff_done", "ai_disabled"],
  "labels_removed": [],
  "attrs_conversation_keys": ["automation_state"],
  "attrs_contact_keys": [],
  "test_run_id": "..."
}
```

## Riscos conhecidos

1. **Rate limit Chatwoot**: GET + 3x POST/PUT pode triggar throttling em alta concorrência. Mitigação via Redis lock em IGOR_01 (single-callable serial por phone).
2. **Race em labels concorrentes**: se dois callers invocarem IGOR_04 quase simultaneamente na mesma conversation, o segundo GET pode não ver o POST do primeiro → labels do primeiro são perdidas. Mitigação parcial: IGOR_01 mantém lock por phone, então só um pipeline roda por vez por conversa. Mitigação total exige fila ou advisory lock no Postgres — deferido até evidência de race em produção.
3. **`POST /labels` substitui lista completa**: a API Chatwoot define labels totais por conversa, não permite "add diff". Por isso o pattern GET-merge-POST é obrigatório. Se um agente humano adicionar uma label manualmente entre GET e POST, ela será perdida. Aceitável dado o lock por phone.
4. **HTTP credential wiring manual**: as 4 chamadas HTTP declaram `igor_chatwoot_api` (httpHeaderAuth) **by name** no JSON, mas sem `id`. A credencial precisa existir no n8n com este nome exato; resolução é feita pelo n8n no momento da execução. Se ausente → 401 em runtime. Documentado em `## Credentials configuradas`.
5. **SDK source-of-truth gap**: o arquivo `.sdk.ts` não declara `settings`/`tags`/`active` (o SDK API do MCP `create_workflow_from_code` não aceita esses campos no input). Os valores estão no JSON canônico e foram preservados na criação. Se re-rodar `create_workflow_from_code` a partir do SDK, **perderá** errorWorkflow, tags e active — re-aplicar via PATCH REST API ou re-importar JSON direto. Documentado no header do `.sdk.ts`.
6. **IGOR_07_Error_Logger ID hardcoded**: `settings.errorWorkflow = "ZrsbaSTlW5bqMEaS"` está no JSON. Se IGOR_07 for reimportado (ID muda), todos os errorWorkflow refs ficam stale. Plano Fase C deve incluir fixup script. (Risco compartilhado com `IGOR_AUX_*` e `IGOR_TEST_*` — não introduzido por este commit.)

## Pendências de wiring (antes da Fase C)
1. **(Single must-do antes de testar)**: Verificar que credencial `igor_chatwoot_api` existe no n8n com httpHeaderAuth wiring para Chatwoot (`api_access_token` header). Sem isso, os 4 HTTP nodes falham 401.
2. Confirmar que `CHATWOOT_BASE_URL` e `CHATWOOT_ACCOUNT_ID` estão setados como env vars no container n8n (consumido via `$env.X` nas URLs).
3. (Opcional) Validar no UI que `Settings → Error Workflow` aponta para o IGOR_07 atual (caso IGOR_07 tenha sido reimportado com ID diferente do persistido `ZrsbaSTlW5bqMEaS`).

## Como testar (Fase C — deferido)
1. Importar fixtures de `fixtures/IGOR_04_*.json`.
2. Para cada fixture, invocar o workflow via trampoline ou execute_workflow MCP substituindo `chatwoot_conversation_id` por uma conversa real de teste no Chatwoot (criar uma se necessário).
3. Rodar asserts SQL de `tests/asserts-IGOR_04_Tool_Labels_Attributes.sql` filtrando por `payload->>'test_run_id'`.
4. Comportamento esperado por fixture documentado em `tests/expected-IGOR_04_Tool_Labels_Attributes.md`.

## Histórico
- 2026-05-15 — Workflow criado via MCP `create_workflow_from_code` (NO SIMPLIFICATIONS rebuild, Wave 1 da Fase B).
- Debt item 3 (`docs/superpowers/debt/2026-05-15-simplifications-to-revert.md`) — RESOLVIDO.
