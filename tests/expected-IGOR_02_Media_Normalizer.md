# Expected matrix — IGOR_02_Media_Normalizer

Fase C executa cada fixture via `mcp__n8n-mcp__execute_workflow` (modo manual) e roda
os asserts em `tests/asserts-IGOR_02_Media_Normalizer.sql`. Cada fixture é
identificada pelo campo `test_run_id` que aparece em `events.payload`.

## Schema de saída (contrato literal)

Cada execução produz na trigger output:

```json
{
  "normalized_text": "string (texto pronto para o agente)",
  "media_summary": "string (resumo curto da midia)",
  "safety_flags": {
    "clinical": boolean,
    "sensitive_image": boolean,
    "payment_proof": boolean,
    "financial": boolean
  },
  "should_handoff": boolean,
  "handoff_reason": "string | null"
}
```

E mutações em:
- `public.messages` — UPSERT por `msg_id` (criar se não existe; UPDATE de `normalized_text`, `media_summary`, `safety_flags` se já existe).
- `public.events` — INSERT com `event_type='media_normalized'`, `payload` contendo `test_run_id`, `messageType`, `safety_flags`, `should_handoff`.

## Matriz fixture × branch × LLM × DB

| Fixture | Branch interna | LLM calls | UPSERT messages | INSERT events('media_normalized') | should_handoff | handoff_reason | safety_flags |
|---|---|---|---|---|---|---|---|
| `IGOR_02_FIXTURE_audio_url` | `audio` (fetch URL) | `POST /v1/audio/transcriptions` (gpt-4o-transcribe) | 1 row (msg_id=fixture, media_summary com prefixo `[audio transcrito]`) | 1 row | `false` | `null` | `{clinical:false, sensitive_image:false, payment_proof:false, financial:false}` |
| `IGOR_02_FIXTURE_audio_base64` | `audio` (decode base64) | `POST /v1/audio/transcriptions` (gpt-4o-transcribe) | 1 row | 1 row | `false` | `null` | defaults false |
| `IGOR_02_FIXTURE_image_no_caption` | `image_no_caption` (fetch URL → vision) | `POST /v1/chat/completions` (gpt-4o-mini) com prompt PT-BR restritivo | 1 row (media_summary = descricao da imagem) | 1 row | depende da resposta vision (esperado `false` para imagem genérica de teste) | `null` ou `imagem_clinica_sensivel`/`imagem_sensivel` | safety_flags vindas do JSON parsed |
| `IGOR_02_FIXTURE_image_with_caption` | `image_with_caption` (passthrough) | nenhuma | 1 row (normalized_text=caption) | 1 row | `false` | `null` | defaults false |
| `IGOR_02_FIXTURE_image_clinical_flagged` | `image_with_caption` (passthrough) | nenhuma | 1 row (normalized_text=caption) | 1 row | `false` | `null` | defaults false (deteccao clinica nao se aplica em caption neste branch — apenas no `image_no_caption`) |
| `IGOR_02_FIXTURE_document_clinical` | `document` (extract + regex) | nenhuma | 1 row (safety_flags.clinical=true) | 1 row | `true` | `documento_clinico_sensivel` | `{clinical:true, sensitive_image:false, payment_proof:false, financial:false}` |
| `IGOR_02_FIXTURE_document_generic` | `document` (extract + regex sem match) | nenhuma | 1 row | 1 row | `false` | `null` | defaults false |
| `IGOR_02_FIXTURE_text_passthrough` | `text` (passthrough) | nenhuma | 1 row (normalized_text=caption) | 1 row | `false` | `null` | defaults false |
| `IGOR_02_FIXTURE_unknown_type` | `unknown` | nenhuma | 1 row (normalized_text=`[midia desconhecida tipo=sticker]`) | 1 row | `true` | `midia_desconhecida` | defaults false |

## Notas

1. Os fixtures `audio_url` e `image_no_caption` exigem que as URLs do
   Wikimedia Commons estejam acessíveis no momento da execução. Em ambiente
   isolado ou caso o OpenAI rejeite o input, Fase C deve trocar pela mídia de
   teste autorizada pelo usuário. **Não modificar o workflow** para essa
   substituição — usar `update_workflow` apenas via spike de teste.
2. O fixture `audio_base64` usa base64 truncado/placeholder; OpenAI
   provavelmente retorna texto vazio. O assert mínimo é UPSERT messages + INSERT
   events. Para validar transcrição real, Fase C deve gerar audio curto e
   colocar em base64 antes do smoke test.
3. O fixture `image_clinical_flagged` exercita o branch `image_with_caption`
   (não o vision). Confirma que caption com termos clínicos não acidentalmente
   dispara detecção (regra: detecção clínica só acontece com vision em
   `image_no_caption`, ou via heurística regex em `document`). Decisão
   intencional do contrato.
4. PDF parsing via `extractFromFile` (`operation: 'pdf'`) tenta extrair texto.
   Se o binário não for PDF válido, retorna empty/error. O fluxo continua para
   a heurística regex sobre `caption + filename + extractedText` — qualquer
   match dispara `safety_flags.clinical=true`.
