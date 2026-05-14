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
