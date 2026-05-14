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

# Parser seguro do .env (não usa source — .env tem comentário malformado linha 24)
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
curl -sS -X POST "${N8N_BASE_URL%/}/api/v1/workflows/${WF_ID}/execute" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null

# Aguardar 5s para a execução estabilizar
sleep 5

# Rodar asserts
ASSERTS_FILE="${ROOT}/tests/asserts-${WF_NAME}.sql"
if [[ ! -f "$ASSERTS_FILE" ]]; then
  echo "ERRO: $ASSERTS_FILE não existe" >&2
  exit 3
fi

# Resolver DNS Supabase (fallback Cloudflare DoH — DNS local não resolve)
HOST=$(echo "$SUPABASE_URL" | sed -E 's|^https?://([^/]+).*|\1|')
IP=$(curl -sS "https://1.1.1.1/dns-query?name=${HOST}&type=A" -H "accept: application/dns-json" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); ans=[a['data'] for a in d.get('Answer',[]) if a.get('type')==1]; print(ans[0] if ans else '')")

# Cada SELECT no arquivo é um assert (separados por -- @assert: <nome> ... -- @end)
PASS=0; FAIL=0; SQL=""; NAME=""
while IFS= read -r line; do
  if [[ "$line" =~ ^--[[:space:]]*@assert:[[:space:]]*(.+)$ ]]; then
    NAME="${BASH_REMATCH[1]}"
    SQL=""
    continue
  fi
  if [[ "$line" =~ ^--[[:space:]]*@end ]]; then
    QUERY=$(echo "$SQL" | sed "s/{{TEST_RUN_ID}}/${TEST_RUN_ID}/g")
    BODY=$(python3 -c "import json,sys; print(json.dumps({'query':sys.argv[1]}))" "$QUERY")
    RES=$(curl -sS --resolve "${HOST}:443:${IP}" \
      -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json" \
      -X POST "https://${HOST}/rest/v1/rpc/exec_sql" -d "$BODY" 2>&1 || echo "[]")
    COUNT=$(echo "$RES" | python3 -c "import json,sys
try:
  d = json.load(sys.stdin)
  print(len(d) if isinstance(d, list) else 0)
except: print(0)
" 2>/dev/null || echo "0")
    if [[ "$COUNT" -gt 0 ]]; then
      echo "  ✓ $NAME ($COUNT rows)"
      PASS=$((PASS + 1))
    else
      echo "  ✗ $NAME (0 rows)"
      FAIL=$((FAIL + 1))
    fi
    SQL=""
    NAME=""
    continue
  fi
  SQL="$SQL $line"
done < "$ASSERTS_FILE"

echo "→ Resultado: $PASS passaram, $FAIL falharam"
exit $((FAIL == 0 ? 0 : 1))
