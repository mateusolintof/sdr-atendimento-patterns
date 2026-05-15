# expected-IGOR_02 — Media Normalizer (callable)

## Entrada
Payload Evolution normalizado pelo caller (IGOR_01) com:
- `phone`, `msgId`, `messageType` (text|audio|image|document|unknown)
- `text` (texto inline ou caption fallback)
- `media` (objeto com `url`, `base64`, `mime_type`, `caption`, `filename`)
- `test_run_id`
- `_skip_llm_calls: true` (opcional, força stubs v1 em audio/image)

## Saída ao caller
```json
{
  "phone": "...",
  "msgId": "...",
  "messageType": "...",
  "normalized_text": "...",
  "media_summary": "...",
  "safety_flags": {
    "clinical": false,
    "sensitive_image": false,
    "payment_proof": false,
    "financial": false,
    "unknown_media": false,
    "audio_transcribed": false,
    "image_classified": false
  },
  "should_handoff": false,
  "handoff_reason": null,
  "test_run_id": "..."
}
```

## Significado das flags
- `clinical` — documento ou texto identificado como exame/laudo/receita/prescrição/CRM/diagnóstico (regex determinístico). Força handoff.
- `sensitive_image` — imagem corporal sensível (antes/depois, exame de imagem). Reservado para v2 (classificação OpenAI).
- `payment_proof` — comprovante de pagamento. Reservado para v2.
- `financial` — discussão financeira sensível detectada. Reservado para v2.
- `unknown_media` — `messageType` fora do conjunto suportado. Força handoff.
- `audio_transcribed` — áudio passou pelo branch de transcrição (true mesmo em stub).
- `image_classified` — imagem passou pelo branch de classificação (true mesmo em stub).

## Cenários de teste

### 1. text (passthrough)
- `normalized_text` = `text` da entrada
- todas flags `false`
- `should_handoff = false`

### 2. audio (v1 stub, `_skip_llm_calls: true`)
- `normalized_text = "[transcricao simulada]"`
- `audio_transcribed = true`, demais flags `false`
- `should_handoff = false`
- v2: chamar `gpt-4o-transcribe` com `media.url`/`media.base64` e preencher transcrição real.

### 3. image (v1 stub, `_skip_llm_calls: true`)
- com caption: `normalized_text = media.caption`
- sem caption: `normalized_text = "[descricao simulada]"`
- `image_classified = true`, demais flags `false`
- `should_handoff = false`
- v2: chamar `gpt-4o-vision` e setar `sensitive_image`/`payment_proof` quando detectado.

### 4. document (FULL v1)
- Regex clínico `/exame|laudo|prescri[çc][aã]o|receita|CRM|diagn[oó]stico/i` em `filename + " " + text`.
- Fixture canônica do smoke: filename `exame_sangue_2026.pdf` + text `envio meu exame de sangue` → match.
- Saída: `safety_flags.clinical = true`, `should_handoff = true`, `handoff_reason = "documento_clinico_sensivel"`.
- Sem match: `clinical = false`, `should_handoff = false` (documento neutro, ex: contrato simples).

### 5. unknown
- `safety_flags.unknown_media = true`, `should_handoff = true`, `handoff_reason = "midia_desconhecida"`.

## Resultado esperado em Supabase
1 linha em `public.events`:
- `event_type = 'media_normalized'`
- `workflow_name = 'IGOR_02_Media_Normalizer'`
- `payload jsonb` com `phone`, `msgId`, `message_type`, `normalized_text`, `safety_flags`, `should_handoff`, `handoff_reason`, `test_run_id`.

## Sem efeito colateral
- Não envia mensagens.
- Não chama Chatwoot.
- Não chama Evolution.
- Pode chamar OpenAI em v2 (controlado por `_skip_llm_calls`).

## Skip mode (testes)
`_skip_llm_calls: true` força stubs nos branches audio/image. Em produção esse campo NÃO vem do caller (IGOR_01).
