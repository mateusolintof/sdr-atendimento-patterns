#!/usr/bin/env bash
# discover.sh — Descoberta read-only dos serviços (n8n, Chatwoot, Evolution, Supabase).
# Salva respostas mascaradas em scripts/reports/raw/*.json.
# Não muta nada. Não imprime tokens.
#
# Uso: bash scripts/discover.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
RAW_DIR="${ROOT}/scripts/reports/raw"
SUMMARY="${ROOT}/scripts/reports/discover-summary.tsv"
MASK="${ROOT}/scripts/mask-secrets.sh"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: .env não encontrado" >&2; exit 1
fi

# Parser seguro do .env — ignora comentários, linhas em branco e linhas malformadas.
# Não usa `source` para não executar conteúdo arbitrário caso haja sintaxe inválida.
load_env_safely() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local k="${BASH_REMATCH[1]}"
      local v="${BASH_REMATCH[2]}"
      # remove aspas envolventes, se houver
      v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
      export "$k=$v"
    fi
  done < "$ENV_FILE"
}
load_env_safely

mkdir -p "$RAW_DIR"
: > "$SUMMARY"
echo -e "service\tname\tmethod\turl_path\tstatus\tlatency_ms\tnotes" >> "$SUMMARY"

call() {
  local service="$1" name="$2" method="$3" url="$4"; shift 4
  local outfile="$RAW_DIR/${service}-${name}.json"
  local hdrfile="$RAW_DIR/${service}-${name}.headers"
  local start_ns end_ns latency_ms status

  if $DRY_RUN; then
    echo -e "${service}\t${name}\t${method}\t$(echo "$url" | sed -E 's#^https?://[^/]+##')\tDRY\t0\tdry-run" >> "$SUMMARY"
    return 0
  fi

  start_ns=$(date +%s%N 2>/dev/null || gdate +%s%N 2>/dev/null || echo 0)
  status=$(curl -sS -o "$outfile" -D "$hdrfile" -w "%{http_code}" \
    --max-time 15 \
    -X "$method" \
    "$@" \
    "$url" 2>&1 || echo "ERR")
  end_ns=$(date +%s%N 2>/dev/null || gdate +%s%N 2>/dev/null || echo 0)
  if [[ "$start_ns" != "0" && "$end_ns" != "0" ]]; then
    latency_ms=$(( (end_ns - start_ns) / 1000000 ))
  else
    latency_ms=0
  fi

  # Mascarar segredos no raw
  if [[ -f "$outfile" ]]; then
    bash "$MASK" < "$outfile" > "${outfile}.masked" && mv "${outfile}.masked" "$outfile"
  fi
  if [[ -f "$hdrfile" ]]; then
    bash "$MASK" < "$hdrfile" > "${hdrfile}.masked" && mv "${hdrfile}.masked" "$hdrfile"
  fi

  local url_path
  url_path=$(echo "$url" | sed -E 's#^https?://[^/]+##')
  echo -e "${service}\t${name}\t${method}\t${url_path}\t${status}\t${latency_ms}\t" >> "$SUMMARY"
}

# ----- n8n -----
if [[ -n "${N8N_BASE_URL:-}" && -n "${N8N_API_KEY:-}" ]]; then
  call n8n workflows GET "${N8N_BASE_URL%/}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "accept: application/json"
  call n8n tags GET "${N8N_BASE_URL%/}/api/v1/tags" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "accept: application/json"
  call n8n credentials GET "${N8N_BASE_URL%/}/api/v1/credentials/schema/httpHeaderAuth" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "accept: application/json" || true
  call n8n variables GET "${N8N_BASE_URL%/}/api/v1/variables" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "accept: application/json"
  call n8n executions GET "${N8N_BASE_URL%/}/api/v1/executions?limit=10" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "accept: application/json"
fi

# ----- Chatwoot -----
if [[ -n "${CHATWOOT_BASE_URL:-}" && -n "${CHATWOOT_API_TOKEN:-}" && -n "${CHATWOOT_ACCOUNT_ID:-}" ]]; then
  CW="${CHATWOOT_BASE_URL%/}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}"
  HDR=(-H "api_access_token: ${CHATWOOT_API_TOKEN}" -H "accept: application/json")
  call chatwoot account GET "${CW}" "${HDR[@]}"
  call chatwoot inboxes GET "${CW}/inboxes" "${HDR[@]}"
  call chatwoot teams GET "${CW}/teams" "${HDR[@]}"
  call chatwoot agents GET "${CW}/agents" "${HDR[@]}"
  call chatwoot labels GET "${CW}/labels" "${HDR[@]}"
  call chatwoot custom_attributes GET "${CW}/custom_attribute_definitions" "${HDR[@]}"
  call chatwoot automation_rules GET "${CW}/automation_rules" "${HDR[@]}"
  call chatwoot webhooks GET "${CW}/webhooks" "${HDR[@]}"
  call chatwoot canned_responses GET "${CW}/canned_responses" "${HDR[@]}"
fi

# ----- Evolution API -----
if [[ -n "${EVOLUTION_BASE_URL:-}" && -n "${EVOLUTION_API_KEY:-}" ]]; then
  EB="${EVOLUTION_BASE_URL%/}"
  EH=(-H "apikey: ${EVOLUTION_API_KEY}" -H "accept: application/json")
  INST="${EVOLUTION_INSTANCE_NAME:-}"
  call evolution fetchInstances GET "${EB}/instance/fetchInstances" "${EH[@]}"
  if [[ -n "$INST" ]]; then
    call evolution connectionState GET "${EB}/instance/connectionState/${INST}" "${EH[@]}"
    call evolution webhook_find GET "${EB}/webhook/find/${INST}" "${EH[@]}"
    call evolution chatwoot_find GET "${EB}/chatwoot/find/${INST}" "${EH[@]}"
    call evolution settings_find GET "${EB}/settings/find/${INST}" "${EH[@]}"
  fi
fi

# ----- Supabase (PostgREST root) -----
if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  SH=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" -H "accept: application/openapi+json")
  call supabase rest_root GET "${SUPABASE_URL%/}/rest/v1/" "${SH[@]}"
fi

echo "Descoberta concluída. Resumo em $SUMMARY; raw em $RAW_DIR/"
