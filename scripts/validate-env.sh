#!/usr/bin/env bash
# validate-env.sh — Valida presença das variáveis canônicas em .env SEM imprimir valores.
# Saída: tabela KEY → SET|EMPTY|MISSING e gravação em reports/env-validation.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
OUT_FILE="${ROOT}/reports/env-validation.md"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: .env não encontrado em $ENV_FILE" >&2
  exit 1
fi

# Lista canônica derivada de AGENTS.md
CANONICAL=(
  IGOR_ENV IGOR_DRY_RUN ALLOW_REAL_WHATSAPP_SEND ALLOW_PRODUCTION_MUTATIONS
  TIMEZONE AFTER_HOURS_START AFTER_HOURS_END
  CAMPAIGN_SEND_WINDOW_START CAMPAIGN_SEND_WINDOW_END CAMPAIGN_DAILY_LIMIT CAMPAIGN_PER_MINUTE_LIMIT
  PROMO_PRICE REGULAR_PRICE PROMO_VALID_UNTIL
  N8N_BASE_URL N8N_API_KEY N8N_ENCRYPTION_KEY N8N_WEBHOOK_URL
  CHATWOOT_BASE_URL CHATWOOT_ACCOUNT_ID CHATWOOT_API_TOKEN
  CHATWOOT_INBOX_ID CHATWOOT_HUMAN_TEAM_ID CHATWOOT_HUMAN_ASSIGNEE_ID CHATWOOT_HUMAN_AGENT_NAME
  EVOLUTION_BASE_URL EVOLUTION_API_KEY EVOLUTION_INSTANCE_NAME
  SUPABASE_URL SUPABASE_HOST SUPABASE_PROJECT_ID SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_CONNECTION_STRING
  REDIS_HOST REDIS_PORT REDIS_PASSWORD
  OPENAI_API_KEY GEMINI_API_KEY
  LANGCHAIN_TRACING_V2 LANGCHAIN_CALLBACKS_BACKGROUND LANGCHAIN_ENDPOINT LANGCHAIN_PROJECT LANGCHAIN_API_KEY
  TEST_WHATSAPP_NUMBER
)

# Classificação por categoria
declare -a CAT_KEY=()
declare -a CAT_NAME=()
classify() {
  local k="$1"
  case "$k" in
    IGOR_*|ALLOW_*) echo "igor-flags" ;;
    AFTER_HOURS_*|TIMEZONE) echo "horarios" ;;
    CAMPAIGN_*|PROMO_*|REGULAR_PRICE) echo "campanha-params" ;;
    N8N_*) echo "n8n" ;;
    CHATWOOT_INBOX_ID|CHATWOOT_HUMAN_*) echo "chatwoot-ids-fase3" ;;
    CHATWOOT_*) echo "chatwoot-creds" ;;
    EVOLUTION_*) echo "evolution" ;;
    SUPABASE_*) echo "supabase" ;;
    REDIS_*) echo "redis-embarcado" ;;
    OPENAI_*|GEMINI_*) echo "llm" ;;
    LANGCHAIN_*) echo "langsmith" ;;
    TEST_*) echo "teste" ;;
    *) echo "outros" ;;
  esac
}

# Status de cada key (SET / EMPTY / MISSING)
get_status() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)
  if [[ -z "$line" ]]; then
    echo "MISSING"
    return
  fi
  local val="${line#${key}=}"
  if [[ -z "$val" || "$val" == "\"\"" || "$val" == "''" ]]; then
    echo "EMPTY"
  else
    echo "SET"
  fi
}

mkdir -p "$(dirname "$OUT_FILE")"

{
  echo "# env-validation"
  echo
  echo "Gerado por \`scripts/validate-env.sh\` — nenhum valor é exibido."
  echo
  echo "## Status por variável"
  echo
  echo "| Variável | Status | Categoria |"
  echo "|---|---|---|"
  for k in "${CANONICAL[@]}"; do
    status=$(get_status "$k")
    cat=$(classify "$k")
    echo "| \`$k\` | $status | $cat |"
  done
  echo
  echo "## Resumo"
  echo
  set_count=0; empty_count=0; missing_count=0
  for k in "${CANONICAL[@]}"; do
    case "$(get_status "$k")" in
      SET) set_count=$((set_count+1)) ;;
      EMPTY) empty_count=$((empty_count+1)) ;;
      MISSING) missing_count=$((missing_count+1)) ;;
    esac
  done
  total=${#CANONICAL[@]}
  echo "- Total: **$total**"
  echo "- SET: **$set_count**"
  echo "- EMPTY: **$empty_count**"
  echo "- MISSING: **$missing_count**"
  echo
  echo "## Vazios esperados (não-bloqueantes nesta fase)"
  echo
  echo "- \`CHATWOOT_INBOX_ID\`, \`CHATWOOT_HUMAN_TEAM_ID\`, \`CHATWOOT_HUMAN_ASSIGNEE_ID\`, \`CHATWOOT_HUMAN_AGENT_NAME\` — preencher após Fase 3 (Chatwoot)."
  echo "- \`REDIS_HOST\`, \`REDIS_PORT\`, \`REDIS_PASSWORD\` — Redis está embarcado no n8n (Portainer); usa credential interna."
  echo "- \`LANGCHAIN_API_KEY\` — LangSmith opcional; tracing efetivamente off."
  echo
  echo "## Keys no .env que não estão no canônico (possíveis extras)"
  echo
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
      key="${BASH_REMATCH[1]}"
      found=false
      for c in "${CANONICAL[@]}"; do
        [[ "$c" == "$key" ]] && found=true && break
      done
      $found || echo "- \`$key\`"
    fi
  done < "$ENV_FILE"
  echo
} > "$OUT_FILE"

echo "Validação concluída → $OUT_FILE"
