#!/usr/bin/env bash
# test-workflow.sh — Executa um workflow n8n com fixture e roda asserts SQL.
#
# Uso: bash scripts/test-workflow.sh <WORKFLOW_NAME> <FIXTURE> [<TEST_RUN_ID>]
#   ex: bash scripts/test-workflow.sh IGOR_07_Error_Logger fixtures/error-trigger-simulated.json
#
# Substitui {{TEST_RUN_ID}} na fixture por um UUID novo (ou usado pelo arg 3).
#
# Como a public API do n8n NÃO expõe POST /workflows/{id}/execute, despachamos
# por tipo de trigger primário do workflow:
#   - webhook              → POST direto no webhook URL do target
#   - errorTrigger         → POST no canary (IGOR_TEST_Failing_Workflow) que
#                            falha e tem errorWorkflow setado para o target
#   - executeWorkflowTrigger / scheduleTrigger / manualTrigger
#                          → POST no trampoline (IGOR_TEST_Trampoline) que
#                            invoca o target via executeWorkflow dinâmico
#
# Depois roda asserts em tests/asserts-<WORKFLOW_NAME>.sql substituindo
# {{TEST_RUN_ID}} também.
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

# Carregar JSON completo do workflow para detectar trigger primário
WF_JSON=$(curl -sS "${N8N_BASE_URL%/}/api/v1/workflows/${WF_ID}" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}")

TRIGGER_TYPE=$(echo "$WF_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
triggers = [n['type'] for n in d.get('nodes', []) if n.get('type') in (
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger',
)]
priority = [
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.manualTrigger',
]
for p in priority:
    if p in triggers:
        print(p); break
")

if [[ -z "$TRIGGER_TYPE" ]]; then
  echo "ERRO: workflow '$WF_NAME' não tem trigger suportado" >&2
  exit 5
fi

# Substituir {{TEST_RUN_ID}} na fixture
PAYLOAD=$(sed "s/{{TEST_RUN_ID}}/${TEST_RUN_ID}/g" "$FIXTURE")

echo "→ Executando $WF_NAME (id=$WF_ID, trigger=$TRIGGER_TYPE, test_run_id=$TEST_RUN_ID)"

TMP_OUT="/tmp/n8n-exec-$$.json"

case "$TRIGGER_TYPE" in
  "n8n-nodes-base.errorTrigger")
    CANARY_URL="${N8N_WEBHOOK_URL%/}/webhook/igor-test-canary"
    DISPATCH_BODY=$(TEST_RUN_ID="$TEST_RUN_ID" python3 -c "
import json, sys, os
inner = json.loads(sys.argv[1])
print(json.dumps({
  'test_run_id': os.environ['TEST_RUN_ID'],
  'simulated_payload': inner,
}))
" "$PAYLOAD")
    HTTP_CODE=$(curl -sS -o "$TMP_OUT" -w "%{http_code}" \
      -X POST "$CANARY_URL" \
      -H "Content-Type: application/json" \
      -d "$DISPATCH_BODY")
    ;;
  "n8n-nodes-base.webhook")
    PATH_VAL=$(echo "$WF_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for n in d.get('nodes', []):
    if n.get('type') == 'n8n-nodes-base.webhook':
        print(n.get('parameters', {}).get('path', '')); break
")
    if [[ -z "$PATH_VAL" ]]; then
      echo "ERRO: webhook do workflow '$WF_NAME' não tem path" >&2
      exit 6
    fi
    DIRECT_URL="${N8N_WEBHOOK_URL%/}/webhook/${PATH_VAL}"
    HTTP_CODE=$(curl -sS -o "$TMP_OUT" -w "%{http_code}" \
      -X POST "$DIRECT_URL" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")
    ;;
  "n8n-nodes-base.executeWorkflowTrigger"|"n8n-nodes-base.scheduleTrigger"|"n8n-nodes-base.manualTrigger")
    TRAMPOLINE_URL="${N8N_WEBHOOK_URL%/}/webhook/igor-test-trampoline"
    DISPATCH_BODY=$(WF_ID="$WF_ID" python3 -c "
import json, sys, os
inner = json.loads(sys.argv[1])
print(json.dumps({
  'target_workflow_id': os.environ['WF_ID'],
  'target_payload': inner,
}))
" "$PAYLOAD")
    HTTP_CODE=$(curl -sS -o "$TMP_OUT" -w "%{http_code}" \
      -X POST "$TRAMPOLINE_URL" \
      -H "Content-Type: application/json" \
      -d "$DISPATCH_BODY")
    ;;
  *)
    echo "ERRO: tipo de trigger não suportado: $TRIGGER_TYPE" >&2
    exit 5
    ;;
esac

# Para errorTrigger: o canary É um workflow que falha de propósito, então
# o webhook retorna 500 com {"message":"Error in workflow"}. Isso é sucesso.
DISPATCH_OK=0
if [[ "$HTTP_CODE" =~ ^2 ]]; then
  DISPATCH_OK=1
elif [[ "$TRIGGER_TYPE" == "n8n-nodes-base.errorTrigger" && "$HTTP_CODE" == "500" ]]; then
  if grep -q '"Error in workflow"' "$TMP_OUT" 2>/dev/null; then
    DISPATCH_OK=1
  fi
fi
if [[ "$DISPATCH_OK" -ne 1 ]]; then
  echo "ERRO: dispatch falhou (HTTP $HTTP_CODE)" >&2
  cat "$TMP_OUT" >&2 || true
  rm -f "$TMP_OUT"
  exit 4
fi
rm -f "$TMP_OUT"

# Aguardar execução estabilizar (configurável via TEST_WAIT_SECONDS)
sleep "${TEST_WAIT_SECONDS:-5}"

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
    COUNT_OR_ERR=$(echo "$RES" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if isinstance(d, list):
        print(len(d))
    elif isinstance(d, dict) and ('code' in d or 'message' in d):
        print('ERR:' + str(d.get('message', d.get('code', 'unknown'))))
    else:
        print(0)
except Exception as e:
    print('ERR:parse_failed')
" 2>/dev/null || echo "ERR:python_failed")

    if [[ "$COUNT_OR_ERR" =~ ^ERR: ]]; then
      echo "  ✗ $NAME (rpc error: ${COUNT_OR_ERR#ERR:})"
      FAIL=$((FAIL + 1))
    elif [[ "$COUNT_OR_ERR" -gt 0 ]]; then
      echo "  ✓ $NAME ($COUNT_OR_ERR rows)"
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
