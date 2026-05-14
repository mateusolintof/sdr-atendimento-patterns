#!/usr/bin/env bash
# seed-chatwoot.sh — Cria labels, custom_attribute_definitions, team e agent_bot
# do Igor no Chatwoot, de forma idempotente.
#
# Não cria inbox aqui: a inbox será criada automaticamente quando rodarmos
# `POST {EVOLUTION}/chatwoot/set/{instance}` na Fase 5 (Evolution).
#
# Requer: ALLOW_PRODUCTION_MUTATIONS=true em .env.
#
# Uso: bash scripts/seed-chatwoot.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
STATE_FILE="${ROOT}/scripts/reports/raw/chatwoot-state.json"

# Parser seguro
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  fi
done < "$ENV_FILE"

if [[ "${ALLOW_PRODUCTION_MUTATIONS:-false}" != "true" ]]; then
  echo "ERRO: ALLOW_PRODUCTION_MUTATIONS deve ser 'true' para rodar este script." >&2
  exit 1
fi

CW="${CHATWOOT_BASE_URL%/}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}"
H_TOK=(-H "api_access_token: ${CHATWOOT_API_TOKEN}")
H_JSON=(-H "Content-Type: application/json")

mkdir -p "$(dirname "$STATE_FILE")"
echo "{" > "$STATE_FILE"
echo "  \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$STATE_FILE"

# ---------- LABELS ----------
echo "==> Labels"

create_label() {
  local title="$1" color="$2" desc="$3"
  local existing
  existing=$(curl -sS -X GET "${CW}/labels" "${H_TOK[@]}" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join([str(x['id']) for x in d.get('payload',[]) if x.get('title')=='$title']))")
  if [[ -n "$existing" ]]; then
    echo "  skip  $title (id=$existing)"
    return
  fi
  local resp
  resp=$(curl -sS -X POST "${CW}/labels" "${H_TOK[@]}" "${H_JSON[@]}" \
    -d "{\"title\":\"${title}\",\"description\":\"${desc}\",\"color\":\"${color}\",\"show_on_sidebar\":true}")
  local id
  id=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  if [[ -n "$id" ]]; then
    echo "  ok    $title (id=$id)"
  else
    echo "  FAIL  $title  resp=$resp"
  fi
}

# origem
create_label "origem_whatsapp"          "#1F93FF" "Lead chegou via WhatsApp"
create_label "origem_meta_ads"          "#1F93FF" "Lead chegou via Meta Ads"
create_label "origem_site"              "#1F93FF" "Lead chegou via site"
create_label "origem_desconhecida"      "#9E9E9E" "Origem do lead não identificada"
create_label "origem_lista_promocao"    "#7C4DFF" "Lead importado em campanha promocional"
create_label "origem_retorno_antigo"    "#7C4DFF" "Lead de retorno em campanha"
# automação
create_label "ai_after_hours"           "#FF9800" "Conversa em atendimento IA fora de expediente"
create_label "ai_campaign"              "#7C4DFF" "Conversa em atendimento IA de campanha"
create_label "ai_disabled"              "#9E9E9E" "IA desabilitada nesta conversa"
create_label "human_locked"             "#F44336" "Humano assumiu — IA travada"
create_label "handoff_pending"          "#FFC107" "Handoff em andamento"
create_label "handoff_done"             "#4CAF50" "Handoff finalizado"
# receptivo
create_label "fora_expediente"          "#FF9800" "Conversa iniciada fora do expediente"
create_label "qualificacao_rapida"      "#FFC107" "Em qualificação rápida"
create_label "callback_solicitado"      "#FFC107" "Lead solicitou retorno"
create_label "callback_horario_coletado" "#4CAF50" "Período de retorno coletado"
create_label "aguardando_atendente"     "#FFC107" "Aguardando atendente humana"
create_label "atendimento_humano"       "#F44336" "Atendente humana respondeu"
# campanha
create_label "promo_eligivel"           "#7C4DFF" "Elegível para campanha promocional"
create_label "promo_disparo"            "#7C4DFF" "Em fila de disparo"
create_label "promo_enviada"            "#7C4DFF" "Mensagem de campanha enviada"
create_label "promo_entregue"           "#7C4DFF" "Entrega confirmada"
create_label "promo_respondeu"          "#7C4DFF" "Lead respondeu à campanha"
create_label "promo_interessado"        "#4CAF50" "Demonstrou interesse"
create_label "promo_duvida"             "#FFC107" "Tem dúvida sobre a oferta"
create_label "promo_nao_interessado"    "#9E9E9E" "Não tem interesse"
create_label "promo_optout"             "#F44336" "Pediu para parar"
create_label "promo_handoff"            "#4CAF50" "Handoff de campanha feito"
# segurança / compliance
create_label "optout"                   "#F44336" "Opt-out global"
create_label "documento_clinico"        "#F44336" "Enviou documento clínico"
create_label "imagem_sensivel"          "#F44336" "Enviou imagem sensível"
create_label "dados_sensiveis"          "#F44336" "Conversa envolveu dados sensíveis"
create_label "compliance_humano"        "#F44336" "Handoff por compliance"
create_label "erro_envio"               "#F44336" "Falha de envio detectada"

# ---------- CUSTOM ATTRIBUTE DEFINITIONS ----------
# attribute_display_type: 0=text 1=number 2=currency 3=percent 4=link 5=date 6=list 7=checkbox
# attribute_model:        0=conversation_attribute 1=contact_attribute
echo "==> Custom attribute definitions"

create_attr() {
  local key="$1" display_name="$2" display_type="$3" model="$4" desc="$5"; shift 5
  local values_json="${1:-[]}"

  local existing
  existing=$(curl -sS -X GET "${CW}/custom_attribute_definitions" "${H_TOK[@]}" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); arr=d if isinstance(d,list) else d.get('payload',[]); print(','.join([str(x['id']) for x in arr if x.get('attribute_key')=='$key']))")
  if [[ -n "$existing" ]]; then
    echo "  skip  $key (id=$existing)"
    return
  fi
  local resp
  resp=$(curl -sS -X POST "${CW}/custom_attribute_definitions" "${H_TOK[@]}" "${H_JSON[@]}" \
    -d "{\"attribute_display_name\":\"${display_name}\",\"attribute_display_type\":${display_type},\"attribute_description\":\"${desc}\",\"attribute_key\":\"${key}\",\"attribute_values\":${values_json},\"attribute_model\":${model}}")
  local id
  id=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$id" ]]; then
    echo "  ok    $key (id=$id)"
  else
    echo "  FAIL  $key  resp=$resp"
  fi
}

# conversation attributes (model=0)
create_attr "automation_state"  "Automation State"  6 0 "Estado da automação Igor" \
  '["new","ai_after_hours","ai_campaign","handoff_pending","human_assigned","opt_out","compliance_hold"]'
create_attr "owner_flow"        "Owner Flow"        6 0 "Fluxo dono da conversa" \
  '["after_hours","campaign_promo","manual"]'
create_attr "ai_enabled"        "AI Enabled"        7 0 "Igor pode responder?"
create_attr "lead_status"       "Lead Status"       0 0 "Status comercial do lead"
create_attr "callback_period"   "Callback Period"   0 0 "Melhor período para retornar contato"
create_attr "handoff_reason"    "Handoff Reason"    6 0 "Motivo do handoff" \
  '["after_hours_callback","documento_clinico_sensivel","imagem_sensivel","promo_interested","promo_doubt","human_request","midia_desconhecida"]'
create_attr "campaign_run_id"   "Campaign Run ID"   0 0 "UUID da campanha ativa (Chatwoot reserva 'campaign_id')"
create_attr "campaign_offer"    "Campaign Offer"    0 0 "Nome da oferta atual"
create_attr "regular_price"     "Regular Price"     0 0 "Preço regular"
create_attr "promo_price"       "Promo Price"       0 0 "Preço promocional"
create_attr "campaign_status"   "Campaign Status"   6 0 "Status do contato na campanha" \
  '["queued","sent","replied","interested","handoff_done","opt_out"]'

# contact attributes (model=1)
create_attr "do_not_contact"    "Do Not Contact"    7 1 "Contato pediu para não receber mais"
create_attr "consent_marketing" "Consent Marketing" 7 1 "Consentimento explícito para marketing"
create_attr "optout_at"         "Optout At"         5 1 "Quando opt-out foi registrado"
create_attr "external_lead_id"  "External Lead ID"  0 1 "UUID do lead no Supabase"

# ---------- TEAM ----------
echo "==> Team"
TEAM_NAME="Atendimento Humano"
TEAM_ID=$(curl -sS -X GET "${CW}/teams" "${H_TOK[@]}" | \
  python3 -c "import json,sys; arr=json.load(sys.stdin); want='${TEAM_NAME}'.lower(); print(','.join([str(x['id']) for x in arr if x.get('name','').lower()==want]))")
if [[ -n "$TEAM_ID" ]]; then
  echo "  skip  $TEAM_NAME (id=$TEAM_ID)"
else
  RESP=$(curl -sS -X POST "${CW}/teams" "${H_TOK[@]}" "${H_JSON[@]}" \
    -d "{\"name\":\"${TEAM_NAME}\",\"description\":\"Atendentes humanos do Instituto Dr. Igor\",\"allow_auto_assign\":true}")
  TEAM_ID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  echo "  ok    $TEAM_NAME (id=$TEAM_ID)"
fi

# ---------- AGENT BOT ----------
echo "==> Agent bot"
BOT_NAME="Alice — IA Instituto Dr. Igor"
BOT_LIST=$(curl -sS -X GET "${CW}/agent_bots" "${H_TOK[@]}" 2>/dev/null || echo "[]")
BOT_ID=$(echo "$BOT_LIST" | python3 -c "import json,sys
try:
  arr = json.load(sys.stdin)
  if isinstance(arr, dict): arr = arr.get('payload', [])
  print(','.join([str(x['id']) for x in arr if x.get('name')=='${BOT_NAME}']))
except: print('')")

if [[ -n "$BOT_ID" ]]; then
  echo "  skip  $BOT_NAME (id=$BOT_ID)"
else
  RESP=$(curl -sS -X POST "${CW}/agent_bots" "${H_TOK[@]}" "${H_JSON[@]}" \
    -d "{\"name\":\"${BOT_NAME}\",\"description\":\"Agente IA do Instituto Dr. Igor (n8n)\",\"outgoing_url\":\"\"}")
  BOT_ID=$(echo "$RESP" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('id',''))
except: print('')")
  if [[ -n "$BOT_ID" ]]; then
    echo "  ok    $BOT_NAME (id=$BOT_ID)"
  else
    echo "  FAIL  $BOT_NAME — resp: $RESP"
    echo "        agent_bot pode requerer platform API (super admin). Veremos no resumo."
  fi
fi

# ---------- STATE FILE ----------
TEAM_ID_JSON=${TEAM_ID:-null}
BOT_ID_JSON=${BOT_ID:-null}
[[ "$TEAM_ID_JSON" != "null" ]] && TEAM_ID_JSON="$TEAM_ID_JSON" || TEAM_ID_JSON="null"
[[ "$BOT_ID_JSON" != "null" ]] && BOT_ID_JSON="$BOT_ID_JSON" || BOT_ID_JSON="null"

cat >> "$STATE_FILE" <<EOF
  "team_atendimento_humano_id": ${TEAM_ID_JSON},
  "agent_bot_alice_id": ${BOT_ID_JSON},
  "note": "inbox será criado via Evolution na Fase 5"
}
EOF

echo
echo "==> Estado salvo em $STATE_FILE"
echo "    Atualize .env: CHATWOOT_HUMAN_TEAM_ID=${TEAM_ID_JSON}"
