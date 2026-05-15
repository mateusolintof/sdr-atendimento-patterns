# IGOR_02_Media_Normalizer

## Trigger
`executeWorkflowTrigger` — callable invocado pelo IGOR_01_Inbound_AfterHours
após receber webhook Evolution + normalização inicial. Recebe o payload via
`workflowInputs` (phone, msgId, messageType, text, media, test_run_id,
_skip_llm_calls).

## Objetivo
Transformar mensagem heterogênea da Evolution (texto/áudio/imagem/documento/unknown)
em um payload uniforme com `normalized_text` + `safety_flags` + `should_handoff`.
Permite que o IGOR_03 trabalhe sempre sobre texto, e que o IGOR_05 saiba quando
precisa fazer handoff por motivo de compliance/segurança.

## Nodes em ordem
1. Execute Workflow Trigger
2. Validate Payload (Code) — coerce defaults, garante shape consistente
3. Switch Message Type — 5 outputs: text / audio / image / document / unknown (fallback)
4. Build Output Text (Code)
5. Build Output Audio (Code)
6. Build Output Image (Code)
7. Build Output Document (Code)
8. Build Output Unknown (Code)
9. Log Event (Postgres INSERT events) — convergem aqui
10. Success Response (Set) — payload final ao caller

## Branches

### text (passthrough)
- `normalized_text = text` da entrada
- todas `safety_flags = false`
- `should_handoff = false`

### audio (v1 stub)
- `safety_flags.audio_transcribed = true`
- `_skip_llm_calls: true` → `normalized_text = "[transcricao simulada]"`
- v2: chamar `gpt-4o-transcribe` com `media.url` ou `media.base64`

### image (v1 stub)
- `safety_flags.image_classified = true`
- com caption → `normalized_text = media.caption`
- sem caption + `_skip_llm_calls: true` → `[descricao simulada]`
- v2: chamar `gpt-4o-vision`, setar `sensitive_image`/`payment_proof` quando detectado

### document (FULL v1)
- Regex clínico determinístico aplicado em `filename + " " + text`:
  `/exame|laudo|prescri[çc][aã]o|receita|CRM|diagn[oó]stico/i`
- Match → `safety_flags.clinical = true`, `should_handoff = true`,
  `handoff_reason = "documento_clinico_sensivel"`
- Sem match → flags zeradas, documento neutro segue fluxo normal

### unknown (fallback)
- `safety_flags.unknown_media = true`
- `should_handoff = true`, `handoff_reason = "midia_desconhecida"`

## Mutação registrada
INSERT em `public.events`:
- `event_type = 'media_normalized'`
- `workflow_name = 'IGOR_02_Media_Normalizer'`
- `payload jsonb` com phone, msgId, message_type, normalized_text,
  safety_flags, should_handoff, handoff_reason, test_run_id

## Saída ao caller
```json
{
  "success": true,
  "normalized_text": "...",
  "should_handoff": false,
  "handoff_reason": null,
  "safety_flags": { ... },
  "test_run_id": "..."
}
```

## Credentials
- `igor_supabase_postgres` (INSERT events) — USADA
- `igor_openai` — reservada para v2 (transcribe/vision)

## Como testar
```bash
bash scripts/test-workflow.sh IGOR_02_Media_Normalizer fixtures/evolution-document.json
```

Cenários cobertos por fixtures:
- `fixtures/evolution-text.json` — passthrough
- `fixtures/evolution-audio.json` — stub com `_skip_llm_calls: true`
- `fixtures/evolution-image.json` — stub com caption
- `fixtures/evolution-document.json` — clinical match (smoke canônico)

## TODO v2
- Audio: chamar OpenAI gpt-4o-transcribe quando `_skip_llm_calls` ausente.
- Image: chamar OpenAI gpt-4o-vision e popular `sensitive_image`, `payment_proof`,
  `financial` quando detectado.
- Document: parsing real do PDF (extrair texto) antes do regex clínico — hoje só
  usa `filename + text` da caption/legenda.
- Heurística clínica ampliada: incluir CID, exames específicos (hemograma, RNI…),
  marcadores de imagem médica (raio-x, tomografia, ressonância).
- Branch `payment_proof` separado quando OCR detectar boleto/PIX/comprovante.
