# expected — IGOR_04_Tool_Labels_Attributes

Callable que mescla labels (GET current + ∪ add − remove + POST set) e PATCH
custom_attributes em conversation/contact no Chatwoot. Sem LLM. 3 branches
independentes guardadas por IF skip flags. Eventos: `label_added`,
`label_removed`, `attribute_set` (scope: conversation | contact).

## Trigger
`executeWorkflowTrigger` (callable) invocado por IGOR_01, IGOR_03, IGOR_05,
IGOR_06 via `executeWorkflow`. Em testes, via trampoline.

## Workflow inputs (esperados)
```text
chatwoot_conversation_id : string  (required)
chatwoot_contact_id      : string  (optional — branch attrs_contact só roda se presente)
labels_to_add            : array<string>
labels_to_remove         : array<string>
custom_attributes        : object  ({conversation: {}, contact: {}})
test_run_id              : string  (optional, propaga em payload de events)
```

## Flags computadas em "Validate Payload" (Code node)
- `_skip_labels = true` SE `labels_to_add` E `labels_to_remove` ambos vazios.
- `_skip_attrs_conversation = true` SE `custom_attributes.conversation` vazio.
- `_skip_attrs_contact = true` SE `chatwoot_contact_id` vazio OU
  `custom_attributes.contact` vazio.

## Cobertura por fixture

| Fixture                                  | _skip_labels | _skip_attrs_conv | _skip_attrs_contact | http_calls | pg_events |
|------------------------------------------|--------------|------------------|---------------------|------------|-----------|
| `IGOR_04_labels_only.json`               | false        | true             | true                | GET + POST labels | 2 label_added + 1 label_removed |
| `IGOR_04_attrs_conversation_only.json`   | true         | false            | true                | POST attrs conv | 1 attribute_set (conv) |
| `IGOR_04_attrs_contact_and_labels.json`  | false        | false            | false               | GET + POST labels + POST attrs conv + PUT contact | 1 label_added + 1 attribute_set (conv) + 1 attribute_set (contact) |
| `IGOR_04_empty_payload.json`             | true         | true             | true                | nenhum     | 0 events |

## Comportamento esperado por branch

### Labels merge (quando `_skip_labels=false`)
1. GET `/api/v1/accounts/{account_id}/conversations/{conv}/labels` →
   `{payload: [<current_labels>]}`.
2. Code "Merge Labels":
   - `merged = (current ∪ labels_to_add) \ labels_to_remove`.
   - `added_deltas = labels_to_add \ current` (apenas as que realmente entraram).
   - `removed_deltas = labels_to_remove ∩ current` (apenas as que realmente saíram).
3. POST `/api/v1/accounts/{account_id}/conversations/{conv}/labels` body
   `{labels: merged}`.
4. INSERT em `public.events` uma linha por `added_deltas[i]` com
   `event_type='label_added'`, `payload={label, chatwoot_conversation_id,
   test_run_id}`.
5. INSERT uma linha por `removed_deltas[i]` com `event_type='label_removed'`.

### Attributes conversation (quando `_skip_attrs_conversation=false`)
1. POST `/api/v1/accounts/{account_id}/conversations/{conv}/custom_attributes`
   body `{custom_attributes: <object from payload>}`.
2. INSERT `events('attribute_set', payload={scope:'conversation',
   keys:Object.keys(attrs.conversation), chatwoot_conversation_id, test_run_id})`.

### Attributes contact (quando `_skip_attrs_contact=false`)
1. PUT `/api/v1/accounts/{account_id}/contacts/{contact_id}` body
   `{custom_attributes: <object from payload>}`.
2. INSERT `events('attribute_set', payload={scope:'contact',
   keys:Object.keys(attrs.contact), chatwoot_contact_id, test_run_id})`.

## Saída final (merge of 3 branches)
```json
{
  "ok": true,
  "labels_added": ["<delta>"],
  "labels_removed": ["<delta>"],
  "attrs_conversation_keys": ["<keys>"],
  "attrs_contact_keys": ["<keys>"]
}
```

## Credentials
- `igor_chatwoot_api` — header auth (`api_access_token`) para chamadas Chatwoot.
- `igor_supabase_postgres` — Postgres para INSERT em events.

## Settings
- `errorWorkflow: ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
- `active: false` (ativação manual no UI do n8n após Fase C).
- `tags: ['igor', 'inbound', 'tool', 'fase-b-rebuild']`.

## Critério de execução em Fase C
1. Workflow ativado manualmente no UI.
2. Trampoline invoca o workflow com cada fixture (substituindo o
   `chatwoot_conversation_id` por um id real de conversa de teste no Chatwoot).
3. Asserts SQL acima rodam após cada execução e contam linhas em `events` por
   `payload->>'test_run_id'`.
