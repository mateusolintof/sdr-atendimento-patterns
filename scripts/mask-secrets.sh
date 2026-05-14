#!/usr/bin/env bash
# mask-secrets.sh — Filtro stdin → stdout que mascara segredos comuns.
# Uso: comando_que_imprime_segredos | bash scripts/mask-secrets.sh
set -euo pipefail

# Mascara qualquer string que se pareça com:
# - JWTs (3 segmentos base64 separados por .)
# - API keys de 20+ caracteres alfanuméricos (incluindo - _)
# - access_token=... em query strings
# - "api_access_token": "...", "apikey": "...", "Authorization: Bearer ..."

sed -E \
  -e 's/(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/jwt_***\3/g' \
  -e 's/(api_access_token"?\s*[:=]\s*"?)[A-Za-z0-9_\-]{8,}/\1tok_***/gI' \
  -e 's/(apikey"?\s*[:=]\s*"?)[A-Za-z0-9_\-]{8,}/\1key_***/gI' \
  -e 's/(authorization:?\s*bearer\s+)[A-Za-z0-9_\-\.]{8,}/\1bearer_***/gI' \
  -e 's/(x-n8n-api-key:?\s*)[A-Za-z0-9_\-\.]{8,}/\1key_***/gI' \
  -e 's/(access_token=)[A-Za-z0-9_\-\.]{8,}/\1tok_***/gI' \
  -e 's/(service_role"?\s*[:=]\s*"?)[A-Za-z0-9_\-\.]{8,}/\1srv_***/gI' \
  -e 's/("phone_number"\s*:\s*"\+?5[0-9])([0-9]{6,})([0-9]{2})/\1***\3/g' \
  -e 's/("phone"\s*:\s*"\+?5[0-9])([0-9]{6,})([0-9]{2})/\1***\3/g'
