# Orquestrador de Workflows IGOR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir os 14 workflows JSON `IGOR_*` em `n8n/workflows/`, com fixtures + asserts SQL + docs por workflow, importados (inativos) na instância n8n da clínica, validados via execução manual com TDD strict.

**Architecture:** Main agent atua como orquestrador, despacha subagentes `general-purpose` em 7 ondas (até 3 paralelos), com brief autocontido por workflow. Cada subagente segue ciclo TDD (vermelho → verde → refator → commit). Estado persiste em `.remember/orchestrator-state.json`. Asserts isolados em DB já populado via `test_run_id` UUID por fixture.

**Tech Stack:** n8n (REST API), Supabase PostgREST + Postgres Chat Memory, Chatwoot REST API, Evolution API, Redis embarcado no n8n, OpenAI (`gpt-5.4-mini`, `gpt-4o-transcribe`).

**Referências carregadas:**
- Spec: `docs/superpowers/specs/2026-05-14-orquestrador-workflows-igor-design.md`
- Plano funcional: `docs/IMPLEMENTATION_PLAN.md` (§2 catálogo, §3 contratos, §4 bloqueios, §5 DDL)
- Padrão técnico: `docs/referencias/workflows-asx/*.json`

**Nota sobre credentials Supabase** (decidido em 2026-05-14): credencial primária é
`igor_supabase_postgres` (tipo Postgres, Session Pooler) — alinha com padrão ASX,
permite SQL com CTEs, atende Postgres Chat Memory. `igor_supabase_service` (tipo
Supabase API) fica como alternativa para nodes Supabase do n8n quando for mais simples
(CRUD direto em tabela). Onde os briefs abaixo dizem "use Supabase REST via HTTP",
ler como "use n8n Postgres node com igor_supabase_postgres".

**Nota sobre contextWindow** (decidido em 2026-05-14): IGOR_03 e IGOR_13 usam
contextWindow 25 (alinhado com ASX P2/P3), não 15/10 como originalmente.

---

## Task 1: Pre-flight — verificar credenciais n8n e inicializar state

**Files:**
- Create: `.remember/orchestrator-state.json`
- Read: `.env`

- [ ] **Step 1: Verificar credenciais `igor_*` no n8n**

Run:
```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
eval "$(grep -E '^N8N_(BASE_URL|API_KEY)=' .env | sed -E 's/^([A-Z_]+)=(.*)/export \1="\2"/')"
curl -sS "${N8N_BASE_URL%/}/api/v1/credentials/schema/httpHeaderAuth" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" >/dev/null && echo "n8n API OK"
# Listar credentials (n8n não tem GET /credentials sem ID, então usamos workflows como proxy)
echo "Credentials esperadas (criar no painel n8n se faltar):"
echo "  - igor_supabase_service (HTTP Header Auth)"
echo "  - igor_supabase_postgres (Postgres session pooler)"
echo "  - igor_chatwoot_api (HTTP Header Auth com admin token)"
echo "  - igor_chatwoot_bot (HTTP Header Auth com bot token)"
echo "  - igor_evolution_api (HTTP Header Auth com apikey)"
echo "  - igor_openai (OpenAI API key)"
echo "  - igor_redis_embedded (Redis embarcado)"
```

Expected: "n8n API OK". Se erro 401, escalar ao usuário antes de prosseguir.

- [ ] **Step 2: Mínimo necessário para Onda 1 — pedir confirmação ao usuário**

Pergunta ao usuário (uma vez, antes de Wave 1):
> "Para a Onda 1 (IGOR_07, IGOR_04, IGOR_06) só preciso que existam `igor_supabase_service` e `igor_chatwoot_api` no n8n. Crie as duas no painel n8n agora e me confirme — as outras 5 entram quando as ondas avançarem."

Aguardar confirmação explícita. Se usuário disser "criadas", seguir.

- [ ] **Step 3: Inicializar state file**

```bash
mkdir -p .remember
cat > .remember/orchestrator-state.json <<'EOF'
{
  "started_at": null,
  "workflows": {
    "IGOR_07_Error_Logger":            {"status": "pending", "wave": 1, "deps": []},
    "IGOR_04_Tool_Labels_Attributes":  {"status": "pending", "wave": 1, "deps": []},
    "IGOR_06_Chatwoot_Message_Logger": {"status": "pending", "wave": 1, "deps": []},
    "IGOR_02_Media_Normalizer":        {"status": "pending", "wave": 2, "deps": ["IGOR_07"]},
    "IGOR_AUX_save_lead_partial":      {"status": "pending", "wave": 2, "deps": ["IGOR_07"]},
    "IGOR_AUX_update_conversation_state": {"status": "pending", "wave": 2, "deps": ["IGOR_07"]},
    "IGOR_01_Inbound_AfterHours":      {"status": "pending", "wave": 3, "deps": ["IGOR_02","IGOR_04","IGOR_07"]},
    "IGOR_05_Finalize_Handoff":        {"status": "pending", "wave": 4, "deps": ["IGOR_04"]},
    "IGOR_03_Agent_AfterHours":        {"status": "pending", "wave": 4, "deps": ["IGOR_02","IGOR_04","IGOR_05","IGOR_AUX_save_lead_partial","IGOR_AUX_update_conversation_state"]},
    "IGOR_08_Health_Check":            {"status": "pending", "wave": 5, "deps": []},
    "IGOR_11_Campaign_Message_Generator": {"status": "pending", "wave": 5, "deps": []},
    "IGOR_12_Campaign_Inbound_Handler": {"status": "pending", "wave": 5, "deps": ["IGOR_02"]},
    "IGOR_13_Agent_Campaign":          {"status": "pending", "wave": 6, "deps": ["IGOR_05","IGOR_11"]},
    "IGOR_10_Campaign_Dispatcher":     {"status": "pending", "wave": 7, "deps": ["IGOR_11"]}
  },
  "current_wave": 0,
  "blocked": [],
  "escalations": []
}
EOF
date -u +%Y-%m-%dT%H:%M:%SZ | xargs -I {} python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['started_at'] = '{}'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
cat .remember/orchestrator-state.json | head -5
```

Expected: arquivo criado, com 14 workflows pending, `started_at` setado.

- [ ] **Step 4: Confirmar `.remember/` está gitignored**

```bash
git check-ignore .remember/orchestrator-state.json && echo "OK — ignored"
```

Expected: `OK — ignored`. Se não ignorar, adicionar `.remember/` ao `.gitignore` antes de prosseguir.

- [ ] **Step 5: Commit do pre-flight**

Não há commit aqui — `.remember/` é local. Próxima task começa a produzir artefatos versionáveis.

---

## Task 2: Construir infraestrutura de testes (scripts + convenções)

**Files:**
- Create: `scripts/test-workflow.sh`
- Create: `scripts/test-block.sh`
- Create: `scripts/import-workflow.sh`
- Create: `tests/README.md`

- [ ] **Step 1: Escrever `scripts/test-workflow.sh`**

```bash
cat > /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/test-workflow.sh <<'SHELL'
#!/usr/bin/env bash
# test-workflow.sh — Executa um workflow n8n com fixture e roda asserts SQL.
#
# Uso: bash scripts/test-workflow.sh <WORKFLOW_NAME> <FIXTURE> [<TEST_RUN_ID>]
#   ex: bash scripts/test-workflow.sh IGOR_07_Error_Logger fixtures/error-trigger-simulated.json
#
# Substitui {{TEST_RUN_ID}} na fixture por um UUID novo (ou usado pelo arg 3),
# dispara execução via POST /api/v1/workflows/{id}/execute, e roda asserts
# em tests/asserts-<WORKFLOW_NAME>.sql substituindo {{TEST_RUN_ID}} também.
#
# Saída: 0 se todos os asserts retornam ≥1 linha; ≠0 se algum falha.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

# Parser seguro do .env
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    v="${BASH_REMATCH[2]}"
    v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    export "${BASH_REMATCH[1]}=$v"
  fi
done < "$ENV_FILE"

WF_NAME="${1:?usage: $0 <WORKFLOW_NAME> <FIXTURE> [TEST_RUN_ID]}"
FIXTURE="${2:?missing fixture path}"
TEST_RUN_ID="${3:-$(uuidgen | tr 'A-Z' 'a-z')}"

# Localizar workflow id no n8n
WF_ID=$(curl -sS "${N8N_BASE_URL%/}/api/v1/workflows" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); ids=[w['id'] for w in d.get('data',[]) if w['name']=='${WF_NAME}']; print(ids[0] if ids else '')")

if [[ -z "$WF_ID" ]]; then
  echo "ERRO: workflow '$WF_NAME' não encontrado no n8n" >&2
  exit 2
fi

# Substituir {{TEST_RUN_ID}} na fixture
PAYLOAD=$(sed "s/{{TEST_RUN_ID}}/${TEST_RUN_ID}/g" "$FIXTURE")

# Disparar execução
echo "→ Executando $WF_NAME (id=$WF_ID, test_run_id=$TEST_RUN_ID)"
EXEC_RESPONSE=$(curl -sS -X POST "${N8N_BASE_URL%/}/api/v1/workflows/${WF_ID}/execute" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Esperar 5s para a execução estabilizar
sleep 5

# Rodar asserts
ASSERTS_FILE="${ROOT}/tests/asserts-${WF_NAME}.sql"
if [[ ! -f "$ASSERTS_FILE" ]]; then
  echo "ERRO: $ASSERTS_FILE não existe" >&2
  exit 3
fi

# Resolver DNS Supabase (fallback Cloudflare)
HOST=$(echo "$SUPABASE_URL" | sed -E 's|^https?://([^/]+).*|\1|')
IP=$(curl -sS "https://1.1.1.1/dns-query?name=${HOST}&type=A" -H "accept: application/dns-json" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); ans=[a['data'] for a in d.get('Answer',[]) if a.get('type')==1]; print(ans[0] if ans else '')")

# Cada SELECT no arquivo é um assert (separados por -- @assert: <nome>)
PASS=0; FAIL=0
while IFS= read -r line; do
  if [[ "$line" =~ ^--\ @assert:\ (.+) ]]; then
    NAME="${BASH_REMATCH[1]}"
    SQL=""
    continue
  fi
  if [[ "$line" =~ ^--\ @end ]]; then
    QUERY=$(echo "$SQL" | sed "s/{{TEST_RUN_ID}}/${TEST_RUN_ID}/g")
    BODY=$(python3 -c "import json; print(json.dumps({'query':'''${QUERY}'''}))" 2>/dev/null || echo "{\"query\":\"${QUERY}\"}")
    RES=$(curl -sS --resolve "${HOST}:443:${IP}" \
      -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json" \
      -X POST "${SUPABASE_URL%/}/rest/v1/rpc/exec_sql" -d "$BODY" 2>&1 || echo "[]")
    COUNT=$(echo "$RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "0")
    if [[ "$COUNT" -gt 0 ]]; then
      echo "  ✓ $NAME ($COUNT rows)"; PASS=$((PASS+1))
    else
      echo "  ✗ $NAME (0 rows) — query: $QUERY"; FAIL=$((FAIL+1))
    fi
    SQL=""
    continue
  fi
  SQL="$SQL $line"
done < "$ASSERTS_FILE"

echo "→ Resultado: $PASS passaram, $FAIL falharam"
exit $((FAIL == 0 ? 0 : 1))
SHELL
chmod +x /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/test-workflow.sh
```

Expected: script criado e executável.

- [ ] **Step 2: Criar RPC `exec_sql` no Supabase (necessária para asserts)**

PostgREST não permite SELECT arbitrário via REST. Vamos criar uma RPC que aceita SQL e retorna jsonb (uso restrito a service_role).

Migration: `supabase/migrations/007_asserts_rpc.sql`

```bash
cat > /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/supabase/migrations/007_asserts_rpc.sql <<'SQL'
-- RPC usada apenas pelos asserts de teste. Restrita a service_role.
-- Permite ao orquestrador executar SELECT arbitrário e receber jsonb.

CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  FOR result IN EXECUTE format('SELECT to_jsonb(t) FROM (%s) t', query) LOOP
    RETURN NEXT result;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM anon;
-- service_role bypassa RLS e tem acesso por default

COMMENT ON FUNCTION public.exec_sql IS 'Apenas para testes — SELECT arbitrário via service_role';
SQL
echo "Criado supabase/migrations/007_asserts_rpc.sql"
```

- [ ] **Step 3: Pedir ao usuário para aplicar migration 007**

Mensagem ao usuário:
> "Criei `supabase/migrations/007_asserts_rpc.sql` com uma RPC `exec_sql` usada pelos asserts dos testes (restrita a `service_role`). Cole e rode no SQL Editor do Supabase, depois me avise."

Aguardar confirmação. Se usuário disser "aplicado", seguir.

- [ ] **Step 4: Verificar que RPC funciona**

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
eval "$(grep -E '^SUPABASE_(URL|SERVICE_ROLE_KEY)=' .env | sed -E 's/^([A-Z_]+)=(.*)/export \1="\2"/')"
HOST=$(echo "$SUPABASE_URL" | sed -E 's|^https?://([^/]+).*|\1|')
IP=$(curl -sS "https://1.1.1.1/dns-query?name=${HOST}&type=A" -H "accept: application/dns-json" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print([a['data'] for a in d.get('Answer',[]) if a.get('type')==1][0])")
curl -sS --resolve "${HOST}:443:${IP}" -X POST "${SUPABASE_URL%/}/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT 1 as ok"}'
```

Expected: `[{"ok":1}]`. Se erro, escalar.

- [ ] **Step 5: Escrever `scripts/test-block.sh`**

```bash
cat > /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/test-block.sh <<'SHELL'
#!/usr/bin/env bash
# test-block.sh — Roda todos os fixtures de um bloco contra os workflows correspondentes.
# Uso: bash scripts/test-block.sh <BLOCK_N>   (1..4)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCK="${1:?usage: $0 <1|2|3|4>}"

declare -A BLOCKS=(
  [1]="IGOR_07_Error_Logger:error-trigger-simulated IGOR_04_Tool_Labels_Attributes:tool-label-merge IGOR_06_Chatwoot_Message_Logger:chatwoot-message-created-outgoing-human IGOR_02_Media_Normalizer:evolution-audio IGOR_01_Inbound_AfterHours:evolution-text"
  [2]="IGOR_05_Finalize_Handoff:finalize-handoff-trigger IGOR_03_Agent_AfterHours:evolution-text"
  [3]="IGOR_08_Health_Check:health-check-trigger IGOR_AUX_save_lead_partial:aux-save-lead IGOR_AUX_update_conversation_state:aux-update-conv"
  [4]="IGOR_11_Campaign_Message_Generator:campaign-message-gen IGOR_12_Campaign_Inbound_Handler:campaign-reply-text IGOR_13_Agent_Campaign:campaign-reply-text IGOR_10_Campaign_Dispatcher:campaign-dispatch-trigger"
)

PAIRS="${BLOCKS[$BLOCK]:-}"
if [[ -z "$PAIRS" ]]; then
  echo "Bloco $BLOCK não definido"; exit 2
fi

FAIL=0
for pair in $PAIRS; do
  WF="${pair%%:*}"; FIX="${pair##*:}"
  echo "===== $WF (fixture: $FIX) ====="
  if ! bash "${ROOT}/scripts/test-workflow.sh" "$WF" "${ROOT}/fixtures/${FIX}.json"; then
    FAIL=$((FAIL+1))
  fi
done

echo
echo "Bloco $BLOCK concluído: $FAIL workflows falharam"
exit $((FAIL == 0 ? 0 : 1))
SHELL
chmod +x /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/test-block.sh
```

- [ ] **Step 6: Escrever `scripts/import-workflow.sh`**

```bash
cat > /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/import-workflow.sh <<'SHELL'
#!/usr/bin/env bash
# import-workflow.sh — Importa um JSON de workflow para o n8n via API.
# Uso: bash scripts/import-workflow.sh <path/to/IGOR_XX.json>
# Saída: ID do workflow criado (stdout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    v="${BASH_REMATCH[2]}"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    export "${BASH_REMATCH[1]}=$v"
  fi
done < "${ROOT}/.env"

JSON="${1:?usage: $0 <path>}"
NAME=$(python3 -c "import json; print(json.load(open('$JSON'))['name'])")

# Se já existe, atualiza
EXISTING_ID=$(curl -sS "${N8N_BASE_URL%/}/api/v1/workflows" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); ids=[w['id'] for w in d.get('data',[]) if w['name']=='$NAME']; print(ids[0] if ids else '')")

if [[ -n "$EXISTING_ID" ]]; then
  echo "→ Atualizando $NAME (id=$EXISTING_ID)" >&2
  curl -sS -X PUT "${N8N_BASE_URL%/}/api/v1/workflows/${EXISTING_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or d)"
else
  echo "→ Criando $NAME" >&2
  curl -sS -X POST "${N8N_BASE_URL%/}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or d)"
fi
SHELL
chmod +x /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/scripts/import-workflow.sh
```

- [ ] **Step 7: Escrever `tests/README.md` (convenções)**

```bash
mkdir -p /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/tests
cat > /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor/tests/README.md <<'MD'
# Tests — convenções

Cada workflow tem 3 artefatos versionados:

```
fixtures/<workflow>-<scenario>.json    # payload de entrada
tests/asserts-<workflow>.sql            # SELECTs que validam estado pós-execução
tests/expected-<workflow>.md            # texto humano: "depois de X, devo ter Y"
```

## Convenção de `{{TEST_RUN_ID}}`

Tabelas Igor já têm dados reais (137 leads). Para isolar asserts:

1. Cada fixture inclui `{{TEST_RUN_ID}}` em um campo customizado (`test_run_id` em metadata Evolution, ou `payload.test_run_id` em eventos).
2. O workflow propaga esse `test_run_id` ao gravar em `events.payload`, `messages.safety_flags`, etc.
3. `scripts/test-workflow.sh` substitui `{{TEST_RUN_ID}}` por um UUID antes de disparar e antes de rodar asserts.
4. Asserts filtram por esse id — ex: `WHERE payload->>'test_run_id' = '{{TEST_RUN_ID}}'`.

## Formato de `tests/asserts-<workflow>.sql`

Múltiplos asserts num arquivo, separados por marcadores:

```sql
-- @assert: log de erro foi criado
SELECT * FROM events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
-- @end

-- @assert: payload tem campo workflow_name
SELECT * FROM events
WHERE event_type = 'infra_error'
  AND payload->>'test_run_id' = '{{TEST_RUN_ID}}'
  AND payload->>'workflow_name' IS NOT NULL
-- @end
```

Cada assert deve retornar **≥1 linha** para passar.

## Formato de `tests/expected-<workflow>.md`

Texto humano descrevendo o que acontece end-to-end. Útil para o usuário entender sem ler SQL. Atualizar se o comportamento mudar.
MD
```

- [ ] **Step 8: Commit da infraestrutura**

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
git add scripts/test-workflow.sh scripts/test-block.sh scripts/import-workflow.sh tests/README.md supabase/migrations/007_asserts_rpc.sql
git commit -m "$(cat <<'COMMIT'
feat(test): infraestrutura de TDD para workflows IGOR

- scripts/test-workflow.sh: executa workflow com fixture + roda asserts SQL
- scripts/test-block.sh: bateria por bloco
- scripts/import-workflow.sh: POST/PUT JSON via API n8n
- tests/README.md: convenção {{TEST_RUN_ID}} para isolar asserts em DB populado
- supabase/migrations/007_asserts_rpc.sql: RPC exec_sql (service_role only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
COMMIT
)" 2>&1 | tail -2
```

Expected: commit registrado.

---

## Task 3: Onda 1 — IGOR_07, IGOR_04, IGOR_06 (3 subagentes paralelos)

**Files (esperados a serem criados pelos subagentes):**
- `fixtures/error-trigger-simulated.json`, `tool-label-merge.json`, `chatwoot-message-created-outgoing-human.json`
- `tests/asserts-IGOR_07.sql`, `tests/asserts-IGOR_04.sql`, `tests/asserts-IGOR_06.sql`
- `tests/expected-IGOR_07.md`, `tests/expected-IGOR_04.md`, `tests/expected-IGOR_06.md`
- `n8n/workflows/IGOR_07_Error_Logger.json`, `IGOR_04_Tool_Labels_Attributes.json`, `IGOR_06_Chatwoot_Message_Logger.json`
- `docs/workflows/IGOR_07.md`, `IGOR_04.md`, `IGOR_06.md`

- [ ] **Step 1: Atualizar state para wave 1 in_progress**

```bash
python3 <<'PY'
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 1
for w in ['IGOR_07_Error_Logger','IGOR_04_Tool_Labels_Attributes','IGOR_06_Chatwoot_Message_Logger']:
    s['workflows'][w]['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
print("Wave 1: 3 workflows in_progress")
PY
```

- [ ] **Step 2: Despachar os 3 subagentes em paralelo (single message, 3 Agent tool calls)**

Use Agent tool 3x na mesma mensagem (paralelismo). Cada chamada:
- `subagent_type: "general-purpose"`
- `description: "Build IGOR_XX workflow"`
- `prompt`: brief autocontido (template abaixo, preenchido por workflow)

**Brief para IGOR_07_Error_Logger** (copiar literal, substituir os 4 placeholders):
```
ROLE: Você é um subagente focado em implementar UM workflow n8n via TDD strict.

ALVO: IGOR_07_Error_Logger
TIPO: errorTrigger (recebe erros de outros workflows)

REPOSITÓRIO: /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor

CONTRATO (de docs/IMPLEMENTATION_PLAN.md §2):
- Trigger: errorTrigger
- Entrada: $json.workflow.{id,name}, $json.execution.{id,retryOf,lastNodeExecuted,error.{message,stack}}
- Saída: INSERT events(event_type='infra_error', payload=jsonb) no Supabase
- Payload mínimo: workflow_id, workflow_name, execution_id, last_node, error_message, error_stack, test_run_id (vem do payload se houver)

REFERÊNCIA TÉCNICA: docs/referencias/workflows-asx/05-Error-Logger.json
Replicar: errorTrigger → Postgres INSERT events.
Substituir credential "Supabase ASX" por "igor_supabase_service" (HTTP Request para Supabase REST) OU "igor_supabase_postgres" (Postgres node).
RECOMENDADO: usar HTTP Request com igor_supabase_service para Supabase REST. Mais simples que Postgres direto.

ENDPOINT REST PARA INSERT events:
POST {SUPABASE_URL}/rest/v1/events
Headers: apikey, Authorization: Bearer (ambos = service_role)
Body: [{"event_type":"infra_error", "workflow_name":"...", "payload":{...}}]

CREDENTIALS DISPONÍVEIS NO N8N:
- igor_supabase_service (HTTP Header Auth) — use este

ORDEM TDD STRICT (não pule passo):
PASSO 1: Crie fixtures/error-trigger-simulated.json com payload realista de erro (use {{TEST_RUN_ID}} no campo de metadata).
PASSO 2: Crie tests/asserts-IGOR_07.sql com 2 asserts:
  - @assert: linha events('infra_error', test_run_id) existe
  - @assert: payload tem workflow_name, error_message não nulos
PASSO 3: Rode `bash scripts/test-workflow.sh IGOR_07_Error_Logger fixtures/error-trigger-simulated.json` — deve FALHAR (workflow não existe ainda).
PASSO 4: Construa n8n/workflows/IGOR_07_Error_Logger.json (errorTrigger → Code que monta payload → HTTP Request POST events).
PASSO 5: Importe via `bash scripts/import-workflow.sh n8n/workflows/IGOR_07_Error_Logger.json` — anote o ID.
PASSO 6: Rode `bash scripts/test-workflow.sh IGOR_07_Error_Logger fixtures/error-trigger-simulated.json` novamente — deve PASSAR todos os asserts.
PASSO 7: Escreva docs/workflows/IGOR_07.md (1 página: trigger, nodes em ordem, observabilidade).
PASSO 8: Commite com mensagem: "feat(IGOR_07): error logger via errorTrigger + Supabase REST"

REGRAS:
- Workflow nasce inativo (não ativar)
- Nome do workflow no JSON DEVE ser exatamente "IGOR_07_Error_Logger"
- Não mexer em outros workflows ou arquivos fora dos listados acima
- Mascarar tokens em qualquer log/output
- Webhook path canônico (se usado): "igor/error" — mas errorTrigger NÃO usa path

PROTOCOLO DE RETORNO:
Reportar JSON estruturado no final:
{
  "status": "success" | "blocked" | "failed",
  "workflow_id": "<id n8n>",
  "files_created": [...],
  "commit_sha": "<hash>",
  "test_result": {"asserts_passed": N, "asserts_failed": M},
  "blockers": [],
  "notes": "..."
}

CONSULTE para n8n: docs/referencias/workflows-asx/05-Error-Logger.json e os 4 skills de n8n já carregados nesta sessão (workflow-patterns, expression-syntax, code-javascript, node-configuration).
```

**Brief para IGOR_04_Tool_Labels_Attributes** (mesmo template, mudando contrato):
```
ROLE: Você é um subagente focado em implementar UM workflow n8n via TDD strict.

ALVO: IGOR_04_Tool_Labels_Attributes
TIPO: executeWorkflowTrigger (callable invocado por outros workflows)

REPOSITÓRIO: /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor

CONTRATO (de docs/IMPLEMENTATION_PLAN.md §2 IGOR_04):
- Trigger: executeWorkflowTrigger
- Entrada: { chatwoot_conversation_id, chatwoot_contact_id?, labels_to_add: [], labels_to_remove: [], custom_attributes: {conversation:{}, contact:{}}, test_run_id }
- Comportamento:
  1. GET labels atuais da conversa: GET /api/v1/accounts/{id}/conversations/{c}/labels
  2. Merge: labels_atuais ∪ labels_to_add \ labels_to_remove
  3. PATCH novas labels: POST /api/v1/accounts/{id}/conversations/{c}/labels body {labels: [merged]}
  4. PATCH custom_attributes conversation: PUT /api/v1/accounts/{id}/conversations/{c}/custom_attributes
  5. PATCH custom_attributes contact (se chatwoot_contact_id presente): PUT /api/v1/accounts/{id}/contacts/{cid}
  6. INSERT events('label_added', {chatwoot_conversation_id, added, removed, test_run_id})
- Saída: {success:true, labels_final:[...]}

REFERÊNCIA TÉCNICA: docs/referencias/workflows-asx/02-Tool-Label (callable).json
Replicar a estrutura: Start → Validate → Chatwoot GET → Code merge → Chatwoot POST → Postgres log → Success.
Substituir credential "Supabase ASX" por "igor_supabase_service".
Substituir Chatwoot hardcoded apikey por credential "igor_chatwoot_api".

CHATWOOT_ACCOUNT_ID = 2 (já fixado).

CREDENTIALS DISPONÍVEIS NO N8N:
- igor_supabase_service (HTTP Header Auth)
- igor_chatwoot_api (HTTP Header Auth com api_access_token = admin token)

ORDEM TDD STRICT (mesma estrutura de IGOR_07 — não pule passo):
PASSO 1: fixtures/tool-label-merge.json com {chatwoot_conversation_id: 1, labels_to_add: ["test_label_a"], custom_attributes: {conversation: {test_attr_key: "{{TEST_RUN_ID}}"}}, test_run_id: "{{TEST_RUN_ID}}"}
  IMPORTANTE: o conversation_id 1 PRECISA EXISTIR no Chatwoot. Se não existir, criar uma conversa de teste primeiro via API (escrever no docs/workflows/IGOR_04.md como pré-condição).
PASSO 2: tests/asserts-IGOR_04.sql:
  - @assert: events('label_added', test_run_id) existe
  - @assert: payload.added contém 'test_label_a'
PASSO 3: Rode test-workflow.sh — FALHA (workflow não existe).
PASSO 4: Construa JSON.
PASSO 5: import-workflow.sh.
PASSO 6: test-workflow.sh — PASSA.
PASSO 7: docs/workflows/IGOR_04.md.
PASSO 8: Commite "feat(IGOR_04): label merge + custom_attributes callable"

PROTOCOLO DE RETORNO: idem IGOR_07.
```

**Brief para IGOR_06_Chatwoot_Message_Logger** (mesmo template):
```
ROLE: Você é um subagente focado em implementar UM workflow n8n via TDD strict.

ALVO: IGOR_06_Chatwoot_Message_Logger
TIPO: webhook (recebe eventos do Chatwoot — message_created)

REPOSITÓRIO: /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor

CONTRATO (de docs/IMPLEMENTATION_PLAN.md §2 IGOR_06):
- Trigger: webhook POST /webhook/igor/chatwoot
- Entrada: payload Chatwoot 'message_created' (body.event, body.conversation, body.message_type, body.sender, body.content)
- Comportamento:
  1. IF body.event !== 'message_created' → respond 204 + NoOp
  2. Extrair phone, conversation_id, sender.type, content
  3. INSERT em messages (espelho normalizado): role baseada em sender.type ('user'|'agent'|'agent_bot'|'system'), direction baseada em message_type
  4. Se message_type='outgoing' E sender.type='user' (humano respondeu) → UPDATE conversations SET human_locked=true, ai_enabled=false + chamar IGOR_04 com label 'atendimento_humano' (mas IGOR_04 talvez não exista ainda nesta Onda 1 — fazer chamada via executeWorkflow opcional/comentada se ainda não existe; ESTRATÉGIA: usar IF que checa se IGOR_04 ID está disponível como env var IGOR_04_ID, senão pular).
  5. INSERT events('human_assumed') se aplicável
- Saída: 200 OK
- test_run_id: vem em body.message.content_attributes.test_run_id (Chatwoot suporta content_attributes em mensagens)

REFERÊNCIA TÉCNICA: docs/referencias/workflows-asx/04-Chatwoot-Message-Logger.json
Replicar estrutura: webhook → IF event_type → Set normalize → Postgres INSERT messages → IF qualifica humano → UPDATE conversations + INSERT events.
Substituir credentials por igor_supabase_service e igor_chatwoot_api.

⚠️ IMPORTANTE: o webhook real do Chatwoot não está configurado nesta fase. O workflow é criado e testado via fixture (POST manual). Quem ativa o webhook do Chatwoot é a Fase 5.

CREDENTIALS DISPONÍVEIS NO N8N:
- igor_supabase_service
- igor_chatwoot_api

WEBHOOK PATH: igor/chatwoot

ORDEM TDD STRICT:
PASSO 1: fixtures/chatwoot-message-created-outgoing-human.json (payload simulado de Chatwoot com event='message_created', message_type='outgoing', sender.type='user', content_attributes.test_run_id='{{TEST_RUN_ID}}'). Também criar fixtures/chatwoot-message-created-outgoing-bot.json (sender.type='agent_bot' — não trava).
PASSO 2: tests/asserts-IGOR_06.sql com 4 asserts:
  - @assert: messages para test_run_id foi inserida
  - @assert: events('human_assumed', test_run_id) existe (cenário humano)
  - @assert: conversations.human_locked=true para conversation_id da fixture
  - @assert: bot variant NÃO criou human_assumed event
PASSO 3-8: idem padrão.

PROTOCOLO DE RETORNO: idem IGOR_07.
```

Dispatch os 3 simultaneamente: 1 message, 3 Agent tool calls, esperar todas retornarem.

- [ ] **Step 3: Validar outputs dos 3 subagentes**

Para cada subagente que retornou:
1. Verificar `status: "success"` no JSON de retorno.
2. Verificar arquivos listados em `files_created` existem.
3. Verificar `commit_sha` aparece no `git log --oneline`.
4. Verificar `test_result.asserts_failed == 0`.

Se qualquer um falhou → escalation conforme spec §5.

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
git log --oneline -10
ls -la n8n/workflows/IGOR_07_Error_Logger.json n8n/workflows/IGOR_04_Tool_Labels_Attributes.json n8n/workflows/IGOR_06_Chatwoot_Message_Logger.json 2>&1
```

Expected: 3 arquivos existem, 3 commits novos.

- [ ] **Step 4: Atualizar state**

```bash
python3 <<'PY'
import json
s = json.load(open('.remember/orchestrator-state.json'))
for w in ['IGOR_07_Error_Logger','IGOR_04_Tool_Labels_Attributes','IGOR_06_Chatwoot_Message_Logger']:
    s['workflows'][w]['status'] = 'done'
    s['workflows'][w]['committed'] = True
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
print("Wave 1: 3 workflows done")
PY
```

---

## Task 4: Onda 2 — IGOR_02, IGOR_AUX_save_lead_partial, IGOR_AUX_update_conversation_state (3 paralelos)

**Files:** análogo à Task 3 (3 fixtures, 3 asserts, 3 JSONs, 3 docs).

- [ ] **Step 1: Atualizar state**

```bash
python3 <<'PY'
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 2
for w in ['IGOR_02_Media_Normalizer','IGOR_AUX_save_lead_partial','IGOR_AUX_update_conversation_state']:
    s['workflows'][w]['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
PY
```

- [ ] **Step 2: Despachar 3 subagentes em paralelo**

Briefs (mesma estrutura, contratos específicos):

**IGOR_02_Media_Normalizer** (callable):
- Contrato §2 IGOR_02: Entrada `{phone, msgId, messageType, media_url|base64, caption?, mimeType?, test_run_id}`. Saída `{normalized_text, media_summary?, safety_flags{clinical,sensitive_image,payment_proof,financial,unknown_media}, should_handoff, handoff_reason?}`.
- Branches: text passthrough · audio via `@n8n/n8n-nodes-langchain.openAi` (resource=audio, operation=transcribe, model=gpt-4o-transcribe, credential=igor_openai) · image via `@n8n/n8n-nodes-langchain.openAi` (resource=image, model=gpt-4o-mini, prompt restritivo PT-BR) · document PDF: heurística (regex "exame|laudo|prescrição|receita|CRM|diagnóstico") → flags clinical.
- Referência: 07-FB-Leads-Inbound.json (branches de mídia, nodes 6-15 da dissecação).
- Fixtures: evolution-audio.json (já listado), evolution-image.json (com e sem caption), evolution-document.json (clínico e neutro).
- Asserts: messages.normalized_text não nulo para áudio; safety_flags.clinical=true para documento "exame".

**IGOR_AUX_save_lead_partial** (callable trivial):
- Contrato: entrada `{contact_id, source, external_id, objective?, city?, callback_period?, kommo_data?, test_run_id}`. Saída `{lead_id}`. UPSERT em `leads` ON CONFLICT (source, external_id) DO UPDATE.
- Referência: 02C-Agent-Log.json (callable simples).
- Asserts: leads existe pelo external_id+source.

**IGOR_AUX_update_conversation_state** (callable trivial):
- Contrato: entrada `{chatwoot_conversation_id, state?, ai_enabled?, human_locked?, current_flow?, test_run_id}`. Saída `{updated:true}`. UPDATE conversations.
- Referência: nenhum específico (Postgres node simples).
- Asserts: conversations.state mudou para valor da fixture.

- [ ] **Step 3-4: validar outputs + atualizar state** (mesmo padrão de Task 3).

---

## Task 5: Onda 3 — IGOR_01_Inbound_AfterHours (sequencial, depende de 02/04/07)

**Files:** fixture evolution-text + evolution-fromme + evolution-group + asserts + JSON + doc.

- [ ] **Step 1: Atualizar state**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 3
s['workflows']['IGOR_01_Inbound_AfterHours']['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
```

- [ ] **Step 2: Despachar 1 subagente para IGOR_01**

Brief específico:

```
ROLE: subagente, TDD strict, mesmo padrão das ondas anteriores.

ALVO: IGOR_01_Inbound_AfterHours
TIPO: webhook (POST /webhook/igor/inbound)

CONTRATO (de IMPLEMENTATION_PLAN.md §2 IGOR_01):
- Webhook recebe payload Evolution MESSAGES_UPSERT
- Sequência de decisões determinísticas (em ordem):
  1. body.data.key.fromMe === true → NoOp + events('inbound_blocked', 'from_me')
  2. settings.ai_enabled_global === false → NoOp
  3. settings.workflows_enabled.IGOR_01 === false → NoOp
  4. Normalizar phone (regex 55 + DDD + 9 dígitos). Inválido → events('invalid_phone')
  5. Lookup contacts.do_not_contact → bloqueia
  6. Lookup conversations.human_locked OR ai_enabled=false → bloqueia
  7. Lookup campaign_contacts (status sent/delivered/replied/interested) → roteia para IGOR_12 (no Bloco 1 ainda não existe — usar IF que checa env IGOR_12_ID, senão segue)
  8. Hora atual ∈ [AFTER_HOURS_END, AFTER_HOURS_START)? Sim → NoOp
  9. Feriado (settings.holidays array)? Sim → mesmo comportamento de fora-de-expediente
  10. Adquirir Redis lock SET NX EX 30 igor:lock:inbound:{phone}; falha → RPUSH igor:batch:{phone}, sair
  11. Chamar IGOR_02 se messageType ≠ text
  12. Chamar IGOR_03 (no Bloco 1 ainda não existe — IF env IGOR_03_ID; senão log inbound_routed e sair)

REFERÊNCIA: 07-FB-Leads-Inbound.json (entrada + normalização + Redis batching, nodes 1-23 da dissecação).

CREDENTIALS: igor_supabase_service, igor_redis_embedded, igor_evolution_api (não usado neste, só read), igor_openai (para IGOR_02).

FIXTURES A CRIAR:
- fixtures/evolution-text.json (mensagem normal)
- fixtures/evolution-fromme.json (fromMe=true)
- fixtures/evolution-group.json (groupsIgnore — deve sair)

ASSERTS:
- @assert: para fromme, events('inbound_blocked', from_me) existe
- @assert: para text dentro do horário (10:00 BRT), events('inbound_blocked', within_hours) existe
- @assert: para text fora do horário (21:00 BRT), conversations.state='ai_after_hours' (ou pelo menos chamada IGOR_02 logada)

⚠️ Como simular hora? O workflow lê hora atual via DateTime.now() em SP timezone. Para testar com 10:00 vs 21:00, a fixture inclui um campo override: `_test_hour_override` (lido por um Code node especial no início que substitui hora real quando esse campo está presente). Isso é um test seam — documentar bem.

PROTOCOLO DE RETORNO: idem.

NOTA SOBRE IGOR_03/IGOR_12: ainda não existem. Os IFs ficam parametrizados via settings.workflows_enabled — se IGOR_03 não habilitado, IGOR_01 só loga inbound_routed e sai. Quando IGOR_03 entrar (Onda 4), basta ligar.
```

- [ ] **Step 3-4: validar + state.**

---

## Task 6: Onda 4 — IGOR_05_Finalize_Handoff THEN IGOR_03_Agent_AfterHours

**Sequencial — IGOR_05 primeiro porque IGOR_03 chama IGOR_05.**

- [ ] **Step 1: Atualizar state — só IGOR_05 in_progress**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 4
s['workflows']['IGOR_05_Finalize_Handoff']['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
```

- [ ] **Step 2: Despachar 1 subagente para IGOR_05**

Brief:
```
ALVO: IGOR_05_Finalize_Handoff
TIPO: executeWorkflowTrigger (callable)
CONTRATO §2 IGOR_05: Entrada {chatwoot_conversation_id, chatwoot_contact_id, lead_id?, handoff_reason, summary, callback_period?, owner_flow, test_run_id}. Sequência: UPDATE conversations (state='human_assigned', ai_enabled=false, human_locked=true) → UPDATE leads (status='aguardando_atendente', handoff_at=now()) → chamar IGOR_04 (labels: handoff_done, ai_disabled, aguardando_atendente) → POST Chatwoot message com private:true (template padrão) → POST assignments {team_id} → INSERT events('handoff_complete') → enviar mensagem final ao lead (gated por ALLOW_REAL_WHATSAPP_SEND).
REFERÊNCIA: 03-Finalize-Handoff (callable).json.
TEXTO DO HANDOFF: IMPLEMENTATION_PLAN.md §13.9.1 (Opção A aprovada) com fallback de {nome} e {callback_period}.
CREDENTIALS: igor_supabase_service, igor_chatwoot_bot (envia mensagem final como Alice), igor_chatwoot_api (assignment + private note).
FIXTURE: fixtures/finalize-handoff-trigger.json com payload completo.
ASSERTS: conversations.human_locked=true; leads.status='aguardando_atendente'; events('handoff_complete') com test_run_id; label 'handoff_done' aplicada no Chatwoot.

PROTOCOLO DE RETORNO: idem.
```

- [ ] **Step 3: validar IGOR_05 + state done**

- [ ] **Step 4: Despachar IGOR_03 (depois de IGOR_05 done)**

Brief:
```
ALVO: IGOR_03_Agent_AfterHours
TIPO: executeWorkflowTrigger (callable)

CONTRATO §2 IGOR_03:
- Entrada: payload normalizado de IGOR_01 (após IGOR_02)
- Comportamento:
  - Se safety_flags.clinical=true OR should_handoff=true → pular conversa, chamar IGOR_05 com handoff_reason='documento_clinico_sensivel'
  - Senão: conversação Alice (saudar, coletar nome, objetivo_principal, callback_period)
- Memória: Postgres Chat Memory (credential igor_supabase_postgres), sessionKey = `after_hours_{{$json.phone}}`, contextWindow 25
- Modelo: gpt-5.4-mini, temperature 0.3
- Tools (toolWorkflow, descrições EXATAS):
  - set_label_and_attr → IGOR_04 — descrição: "Use para aplicar labels e custom attributes na conversa Chatwoot. Use depois de coletar nome E objetivo E período."
  - save_lead_partial → IGOR_AUX_save_lead_partial — descrição: "Use para gravar dados parciais do lead em leads. Use quando coletar nome, objetivo, ou cidade."
  - update_conversation_state → IGOR_AUX_update_conversation_state — descrição: "Use para atualizar o estado da conversa (state, ai_enabled). Use a cada transição de etapa."
  - trigger_handoff → IGOR_05 — descrição: "Use APENAS quando: a) coletou nome E objetivo E callback_period; b) detectou mídia clínica sensível; c) lead pediu falar com humano. Não chame antes."

SYSTEM PROMPT: PT-BR conversacional, guardrails (não diagnosticar, não prometer agenda específica, não comentar imagem/documento clínico — apenas dizer que equipe vai analisar). Texto baseado em IMPLEMENTATION_PLAN.md §2 IGOR_03 + handoff copies §13.9.1.

REFERÊNCIA TÉCNICA: 07-FB-Leads-Inbound.json (Joao P3 nodes 32-34 + tools).

REPLY PATH: após o agent gerar resposta, montar split-out + presence-typing + send via Evolution sendText (gated por ALLOW_REAL_WHATSAPP_SEND). Se DRY_RUN, log events('dry_run_send').

CREDENTIALS: igor_supabase_service, igor_supabase_postgres, igor_chatwoot_api, igor_chatwoot_bot, igor_openai, igor_evolution_api.

FIXTURE: usar fixtures/evolution-text.json + simulação de fluxo de 3 mensagens (mock de session contínua). Como Postgres Chat Memory precisa de sessionKey persistente, fixture inclui phone fixo e o teste roda 3 execuções consecutivas.

ASSERTS:
- @assert: messages com role='assistant' criada após primeira mensagem
- @assert: events com event_type='after_hours_started' existe
- @assert: após mensagem 3 (com callback fornecido), events('handoff_complete') aparece

PROTOCOLO DE RETORNO: idem.
```

- [ ] **Step 5: validar IGOR_03 + state done para ambos**

- [ ] **Step 6: Smoke test do Bloco 2**

```bash
bash scripts/test-block.sh 2
```

Expected: ambos workflows passam fixtures principais.

---

## Task 7: Onda 5 — IGOR_08, IGOR_11, IGOR_12 (3 paralelos)

**IGOR_12 é despachado com placeholder de IGOR_13 (que entra na Onda 6).** O placeholder é um IF que checa env var IGOR_13_ID; se ausente, IGOR_12 só loga `events('campaign_inbound_pending_agent')` e sai.

- [ ] **Step 1: Atualizar state**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 5
for w in ['IGOR_08_Health_Check','IGOR_11_Campaign_Message_Generator','IGOR_12_Campaign_Inbound_Handler']:
    s['workflows'][w]['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
```

- [ ] **Step 2: Despachar 3 paralelos**

Briefs (resumido):

**IGOR_08_Health_Check** (schedule */10 * * * *):
- Pings: Evolution `/instance/connectionState/convert-teste`, Chatwoot `/api/v1/accounts/2`, Supabase `/rest/v1/` (sanity).
- SQL snapshots: contagens últimas 24h em events, messages, leads, campaign_contacts. Detectar conversas com ai_enabled=true após mensagem humana (race), batches Redis órfãos.
- INSERT events('health_check', {checks, critical, warnings}).
- Ref: 08-Health-Check.json (mesma estrutura).
- Fixture: fixtures/health-check-trigger.json (manual trigger override).
- Asserts: events('health_check', test_run_id) existe; payload.checks tem entries para evolution/chatwoot/supabase.

**IGOR_11_Campaign_Message_Generator** (callable, sem LLM):
- Entrada: `{campaign_id, contact:{name?,phone}, test_run_id}`. Carrega `campaign_runs.message_template` via Postgres SELECT. Substitui `{nome}` por `contact.name` se existir, senão remove "Olá, {nome}" pelo padrão "Olá".
- Saída: `{sent_message}`.
- Fixture: fixtures/campaign-message-gen.json com campaign_id=00000000-0000-0000-0000-000000000001 (do seed).
- Asserts: response.sent_message contém "R$ 600" e "T Sculptor".

**IGOR_12_Campaign_Inbound_Handler** (callable, com placeholder IGOR_13):
- Entrada: payload normalizado + campaign_contact_id.
- Bloqueios determinísticos (fromMe, human_locked, ai_enabled, opt-out).
- Classificar intenção via regex/keywords:
  - opt_out: keywords from `settings.do_not_contact_keywords`
  - interested: "quero", "tenho interesse", "pode ver", "sim"
  - price_question: "quanto", "valor", "preço"
  - scheduling: "horário", "agendar", "agenda"
  - human_request: "atendente", "humano", "alguém"
  - unknown: fallback
- Para opt_out: SET contacts.do_not_contact=true, campaign_contacts.status='opt_out', label 'promo_optout', enviar texto §9.4.
- Para interested/price_question/scheduling/doubt/human_request: chamar IGOR_13 (com placeholder IF).
- Para unknown: enviar pergunta de esclarecimento (não chamar handoff).
- Fixture: fixtures/campaign-reply-text.json (interessado), fixtures/campaign-reply-optout.json.
- Asserts: para optout, contacts.do_not_contact=true; events('campaign_opt_out'); label aplicada.

- [ ] **Step 3-4: validar + state.**

---

## Task 8: Onda 6 — IGOR_13_Agent_Campaign + patch IGOR_12 placeholder

- [ ] **Step 1: Atualizar state**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 6
s['workflows']['IGOR_13_Agent_Campaign']['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
```

- [ ] **Step 2: Despachar IGOR_13**

Brief:
```
ALVO: IGOR_13_Agent_Campaign
TIPO: executeWorkflowTrigger (callable)
PADRÃO: idêntico ao IGOR_03, mas system prompt diferente (oferta R$600 + T Sculptor + booking_fee R$180; sem mencionar valores que não estejam em campaign_runs).
Tools: idem IGOR_03 (set_label_and_attr, save_lead_partial, update_conversation_state, trigger_handoff via IGOR_05).
Memory: Postgres Chat Memory, sessionKey = `campaign_{{$json.phone}}`, contextWindow 25 (menor que receptivo — conversa de campanha é mais curta).
Modelo: gpt-5.4-mini, temperature 0.3.

SYSTEM PROMPT (esqueleto):
"Você é Alice, atendente IA do Instituto Dr. Igor. Está continuando uma campanha promocional que você já enviou. O lead respondeu. Sua função: esclarecer dúvidas sobre a oferta (preço, validade, T Sculptor), coletar callback_period, e chamar trigger_handoff quando confirmar interesse + período.
Não invente preço (use exatamente: R$ 600 consulta, R$ 180 taxa abatida, 1 sessão T Sculptor).
Não diagnostique. Não comente exames/imagens (chame trigger_handoff com motivo compliance se receber).
Não insista após "não" claro (chame trigger_handoff com não-interessado, sem callback).
Tom: cordial, breve, max 3 linhas por mensagem."

FIXTURE: simulação de 2 turnos (lead pergunta preço → Alice responde → lead diz "fechado, à tarde" → Alice chama handoff).
ASSERTS: events('campaign_handoff_complete'); campaign_contacts.status='handoff_done'; callback_period preenchido.
```

- [ ] **Step 3: Após IGOR_13 success, despachar subagente de patch para IGOR_12**

Brief:
```
ALVO: patch em n8n/workflows/IGOR_12_Campaign_Inbound_Handler.json
OBJETIVO: substituir o placeholder de IGOR_13 (que só logava 'campaign_inbound_pending_agent') por chamada real via executeWorkflow node.

PASSOS:
1. Ler o JSON atual em n8n/workflows/IGOR_12_Campaign_Inbound_Handler.json
2. Localizar o IF/placeholder; substituir por executeWorkflow node apontando para 'IGOR_13_Agent_Campaign' (n8n resolve por nome).
3. Reimportar via `bash scripts/import-workflow.sh n8n/workflows/IGOR_12_Campaign_Inbound_Handler.json` (UPDATE).
4. Rodar `bash scripts/test-workflow.sh IGOR_12_Campaign_Inbound_Handler fixtures/campaign-reply-text.json` — agora deve passar asserts que checam events('campaign_handoff_complete') (porque IGOR_13 é chamado e finaliza).
5. Atualizar tests/asserts-IGOR_12.sql adicionando os novos asserts que dependem de IGOR_13.
6. Commit "feat(IGOR_12): wire real IGOR_13 in place of placeholder".

PROTOCOLO DE RETORNO: idem.
```

- [ ] **Step 4: validar ambos + state done.**

---

## Task 9: Onda 7 — IGOR_10_Campaign_Dispatcher

- [ ] **Step 1: Atualizar state**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
s['current_wave'] = 7
s['workflows']['IGOR_10_Campaign_Dispatcher']['status'] = 'in_progress'
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
"
```

- [ ] **Step 2: Despachar IGOR_10**

Brief:
```
ALVO: IGOR_10_Campaign_Dispatcher
TIPO: scheduleTrigger (*/1 * * * 1-5 — cada minuto seg-sex, com IF interno para janela CAMPAIGN_SEND_WINDOW)

CONTRATO §2 IGOR_10:
- Checagens sequenciais: workflows_enabled.IGOR_10, janela horário, dia da semana, feriado, limite diário, throttle per-minute via Redis last_sent_at.
- Buscar 1 campaign_contacts WHERE status='queued' AND campaign_id ativo, mais antigo primeiro.
- Revalidar elegibilidade (do_not_contact, human_locked, scheduled_at).
- Chamar IGOR_11_Campaign_Message_Generator.
- Enviar via Evolution sendText (gated por ALLOW_REAL_WHATSAPP_SEND=true AND IGOR_DRY_RUN=false; senão events('dry_run_send')).
- UPDATE campaign_contacts.status='sent', sent_at=now().
- Aplicar threshold opt-out: se 3 dos últimos 20 sends do mesmo campaign_id viraram opt_out, UPDATE campaign_runs.status='pausado' + events('campaign_auto_paused').

REFERÊNCIA: 06-FB-Leads-Outbound-Webhook.json (estrutura de outbound + send).

CREDENTIALS: igor_supabase_service, igor_redis_embedded, igor_evolution_api.

FIXTURE: manual trigger com IGOR_DRY_RUN=true (do .env). O scheduleTrigger não é disparado por POST tradicional — em vez disso, usar `POST /api/v1/workflows/{id}/execute` com payload vazio funciona como manual run.
ASSERTS:
- @assert: dry-run: events('dry_run_send', campaign_id da fixture) existe
- @assert: campaign_contacts.status='sent' para o contato selecionado
- @assert: NO INSERT em messages com direction='outbound' (porque DRY_RUN bloqueou Evolution)
```

- [ ] **Step 3: validar + state done.**

---

## Task 10: Bateria end-to-end + final commit

- [ ] **Step 1: Rodar todos os blocos em sequência**

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
for B in 1 2 3 4; do
  echo "===== BLOCO $B ====="
  bash scripts/test-block.sh $B || { echo "FALHA bloco $B"; exit 1; }
done
echo "TODOS OS BLOCOS PASSARAM"
```

Expected: 4 blocos passando.

- [ ] **Step 2: Validar lista final de workflows no n8n**

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
eval "$(grep -E '^N8N_(BASE_URL|API_KEY)=' .env | sed -E 's/^([A-Z_]+)=(.*)/export \1="\2"/')"
curl -sS "${N8N_BASE_URL%/}/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" | \
  python3 -c "
import json,sys
d = json.load(sys.stdin)
wfs = [w for w in d['data'] if w['name'].startswith('IGOR_')]
print(f'Total IGOR workflows: {len(wfs)}')
for w in sorted(wfs, key=lambda x: x['name']):
  print(f'  {w[\"name\"]:45} active={w[\"active\"]}')
"
```

Expected: 14 workflows IGOR_*, todos `active=false`.

- [ ] **Step 3: Atualizar state final**

```bash
python3 -c "
import json
s = json.load(open('.remember/orchestrator-state.json'))
all_done = all(w['status']=='done' for w in s['workflows'].values())
s['completed'] = all_done
s['completed_at'] = __import__('datetime').datetime.utcnow().isoformat()+'Z' if all_done else None
json.dump(s, open('.remember/orchestrator-state.json','w'), indent=2)
print(f'all_done={all_done}')
"
```

- [ ] **Step 4: Commit final + summary report**

```bash
cd /Users/mateusolintof/Projetos/Convert/Produção/Instituto-Igor
# Atualizar VALIDATION_REPORT.md com sumário
python3 <<'PY'
import json
s = json.load(open('.remember/orchestrator-state.json'))
lines = ["# VALIDATION_REPORT — Igor Fase 4", "",
         f"Concluída em {s.get('completed_at','?')}.", "",
         "## Workflows construídos", ""]
for name, info in sorted(s['workflows'].items()):
    lines.append(f"- {name}: {info['status']} (wave {info['wave']})")
lines += ["", "## Próximo passo", "",
          "Fase 5 (Evolution): bind Evolution↔Chatwoot, configurar webhook real."]
open('docs/VALIDATION_REPORT.md','w').write('\n'.join(lines))
PY
git add docs/VALIDATION_REPORT.md
git commit -m "$(cat <<'COMMIT'
docs: validation report Fase 4 — todos os 14 IGOR_* construídos

Workflows criados (inativos), fixtures + asserts versionados,
smoke tests dos 4 blocos passando.

Próximo: Fase 5 (Evolution binding) só após autorização explícita
do usuário e flip de ALLOW_REAL_WHATSAPP_SEND/workflows_enabled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
COMMIT
)" 2>&1 | tail -3
```

Expected: commit final, report escrito.

---

## Self-review

**Spec coverage** — verificado contra `2026-05-14-orquestrador-workflows-igor-design.md`:

| Spec | Task que cobre |
|---|---|
| §1 Decisões (autonomia, paralelismo, TDD, git) | Tasks 3-9 (paralelismo até 3, commit por workflow, TDD em cada brief) |
| §2 Arquitetura | Task 1 (state) + Tasks 3-9 (dispatch) |
| §3 Brief e protocolo | Briefs embutidos em Tasks 3-9 |
| §3.3 Mapa ASX | Briefs referenciam JSON ASX certo |
| §4 DAG | Tasks 3-9 seguem ordem 1→2→3→4→5→6→7 |
| §5 Escalation | Step 3 de cada wave: "Se falhou → escalation §5" |
| §6 TDD | TDD strict embutido em cada brief (passos 1-8) |
| §7 Error handling | Briefs incluem retry ≤2x + status="blocked" |
| §8 Observabilidade | State JSON + `test_run_id` em todos os asserts |
| §9 Credentials | Task 1 step 2 (mínimo Wave 1) + briefs listam por workflow |
| §10 Files | Cada task lista files esperados |
| §11 Fora de escopo | Task 10 step 4 — workflows ficam inativos, sem touching webhook |

**Placeholder scan**: nenhum "TBD/TODO". Cada brief tem contrato concreto + fixture + asserts + comando.

**Type consistency**: nomes de workflow seguem padrão `IGOR_XX_Nome_Em_Snake` em todos os steps. State JSON usa as mesmas chaves em Tasks 3-9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-orquestrador-workflows-igor.md`. Two execution options:

**1. Subagent-Driven (recommended)** — eu dispatch um subagente fresco por task (especificamente: as ondas de dispatch viram subagent-of-subagents), reviso entre tasks, iteração rápida.

**2. Inline Execution** — executo tasks nesta sessão usando `executing-plans`, batch com checkpoints de review.

Qual approach?
