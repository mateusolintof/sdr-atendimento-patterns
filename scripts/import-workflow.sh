#!/usr/bin/env bash
# import-workflow.sh — Importa um JSON de workflow para o n8n via API.
# Uso: bash scripts/import-workflow.sh <path/to/IGOR_XX.json>
# Saída: ID do workflow criado (stdout). Idempotente: UPDATE se já existe.
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
