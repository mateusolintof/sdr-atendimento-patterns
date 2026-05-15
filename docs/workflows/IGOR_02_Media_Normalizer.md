# IGOR_02_Media_Normalizer

**n8n workflow id**: `GBmG9WZzW2p8Nn6f`
**URL**: https://n8n.almaconvert.com.br/workflow/GBmG9WZzW2p8Nn6f
**Status**: `active: true` (ativado em 2026-05-15).
**Source de verdade**: `n8n/workflows/IGOR_02_Media_Normalizer.json` (canonical exportado pos PATCH).
**SDK source**: `n8n/workflows/IGOR_02_Media_Normalizer.sdk.ts` (header tem SOURCE OF TRUTH NOTICE).

## Contrato literal (de `docs/IMPLEMENTATION_PLAN.md:114-127` + `docs/logica-fluxo-igor-receptivo-fora-expediente.md §10`)

- **Trigger**: callable (`executeWorkflowTrigger`).
- **Entrada**: `{ phone, msgId, messageType, media_url|media_base64, caption?, mimeType?, chatwoot_conversation_id, test_run_id? }`.
- **Decisoes**:
  - `audio` -> baixar (URL via httpRequest binary OR base64 decode) -> POST OpenAI `/v1/audio/transcriptions` com `model=gpt-4o-transcribe`, `language=pt`, `response_format=json` -> normalized_text = transcript.
  - `image` com caption -> caption como normalized_text, safety_flags default (passthrough sem vision).
  - `image` SEM caption -> baixar -> POST OpenAI `/v1/chat/completions` com `model=gpt-4o-mini`, `response_format=json_object`, mensagem multipart (text + image_url data URL) usando o PROMPT PT-BR RESTRITIVO LITERAL (vide abaixo). Parse `{descricao, tipo, safety_flags}` -> se `clinical=true` -> `should_handoff=true, handoff_reason='imagem_clinica_sensivel'`; se `sensitive_image=true` -> `should_handoff=true, handoff_reason='imagem_sensivel'`.
  - `document` (PDF): extractFromFile (operation=pdf, joinPages=true) sobre binary -> regex `/(exame|laudo|prescri[cç][ãa]o|receita|crm[\-\s]?\d|diagn[oó]stico|hemograma|raio[\s-]?x|ressonancia|tomografia)/i` sobre `caption + filename + textoExtraido`. Match -> `safety_flags.clinical=true, should_handoff=true, handoff_reason='documento_clinico_sensivel'`. Sem match -> passthrough seguro.
  - `text` -> passthrough (caption -> normalized_text).
  - `unknown` (qualquer outro messageType) -> `should_handoff=true, handoff_reason='midia_desconhecida'`, normalized_text descritivo.
- **Saida**: `{ normalized_text, media_summary, safety_flags: {clinical, sensitive_image, payment_proof, financial}, should_handoff, handoff_reason, msgId, branch, test_run_id }`.
- **LLM**: SIM (audio + image_no_caption); deterministic (image_with_caption, document, text, unknown).
- **Mutacoes**:
  - UPSERT `public.messages` keyed por `msg_id` (ON CONFLICT msg_id WHERE msg_id IS NOT NULL DO UPDATE de normalized_text/media_summary/safety_flags). Pre-condicao: `public.conversations` ja existe com o `chatwoot_conversation_id` (FK).
  - INSERT `public.events('media_normalized', payload)` com `test_run_id`, `messageType`, `branch`, `safety_flags`, `should_handoff`, `handoff_reason`, length stats.

## Prompt PT-BR restritivo (LITERAL no node `Image Vision (gpt-4o-mini)`)

```text
Voce descreve imagens enviadas por leads de uma clinica medica. NAO interpreta clinicamente. NAO da orientacao medica. NAO diagnostica.
Responda APENAS em JSON com este schema:
{
  "descricao": "string - breve descricao neutra do que aparece (max 200 chars)",
  "tipo": "selfie_rosto | selfie_corpo | documento | exame_imagem | prescricao | comprovante_pagamento | captura_de_tela | outro",
  "safety_flags": {
    "clinical": "boolean - true se for exame, laudo, imagem medica, prescricao, raio-X, ultrassom, ressonancia, tomografia, etc.",
    "sensitive_image": "boolean - true se for nudez, ferida exposta, antes/depois corporal, partes intimas",
    "payment_proof": "boolean - true se for comprovante PIX, transferencia ou recibo",
    "financial": "boolean - true se for boleto, fatura ou documento financeiro"
  }
}
```

(O prompt original do plano usa acentos. A versao serializada no `jsonBody` usa transliterado para evitar problemas de escape JSON dentro da expressao n8n. Conteudo semantico = identico.)

## Topologia (27 nodes)

```
Execute Workflow Trigger
  -> Validate Payload (Code: coerce + classify branch in {audio, image_with_caption, image_no_caption, document, text, unknown})
  -> Route By Branch (Switch v3.4, 6 outputs)
       case audio              -> Audio Has URL? (IF)
                                    onTrue -> Audio Fetch URL (httpRequest GET, responseFormat=file)
                                    onFalse -> Audio Decode Base64 (Code: Buffer.from(b64) + binary.data)
                                 -> Audio Merge Binary (Merge append numberInputs=2)
                                 -> Audio Transcribe gpt-4o-transcribe (httpRequest POST multipart-form
                                    /v1/audio/transcriptions, openAiApi credential)
                                 -> Audio Format (Code: build normalized_text + media_summary)
                                 -> Merge Branches input 0
       case image_with_caption -> Image w/ Caption Format (Code)
                                 -> Merge Branches input 1
       case image_no_caption   -> Image Has URL? (IF)
                                    onTrue -> Image Fetch URL -> Image Encode DataURL
                                    onFalse -> Image Encode DataURL (decode validated.media_base64)
                                 -> Image Vision gpt-4o-mini (httpRequest POST json
                                    /v1/chat/completions, openAiApi credential, prompt PT-BR LITERAL)
                                 -> Image Parse Vision (Code: parse JSON.parse(choices[0].message.content),
                                    derive should_handoff/handoff_reason)
                                 -> Merge Branches input 2
       case document           -> Document Has URL? (IF)
                                    onTrue -> Document Fetch URL
                                    onFalse -> Document Decode Base64
                                 -> Document Merge Binary
                                 -> Document Extract PDF (extractFromFile operation=pdf, onError=continueRegularOutput)
                                 -> Document Classify Heuristic (Code: regex sobre caption + filename + extractedText)
                                 -> Merge Branches input 3
       case text               -> Text Format -> Merge Branches input 4
       case unknown            -> Unknown Format -> Merge Branches input 5
  -> Merge Branches (append numberInputs=6)
  -> UPSERT Messages (Postgres executeQuery, ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE; continueOnFail=true)
  -> INSERT Event media_normalized (Postgres executeQuery)
  -> Final Output (Set: emit canonical contract output via $('Merge Branches').first().json)
```

## Gates aplicados (REALMENTE persistidos)

Verificado via `GET /api/v1/workflows/GBmG9WZzW2p8Nn6f`:

- `active: true`
- `settings.executionOrder: "v1"`
- `settings.availableInMCP: true`
- `settings.errorWorkflow: "ZrsbaSTlW5bqMEaS"` (= IGOR_07_Error_Logger). **Aplicado via PUT REST API** apos `create_workflow_from_code` (que nao expoe esse campo).
- `tags: ["igor", "inbound", "media", "fase-b-rebuild"]`. **Tags criadas via `POST /api/v1/tags`** (cada uma retornou id), depois aplicadas via `PUT /api/v1/workflows/{id}/tags` com body `[{id}, ...]`.
- Credentials nos 2 nodes OpenAI HTTP: `openAiApi: igor_openai (id=LlVkZBRsy5tm6FjJ)`. **Aplicado via PUT REST API** apos create (auto-assign do MCP pulou esses nodes).
- Credentials nos 2 nodes Postgres: `postgres: igor_supabase_postgres (id=Z7DeBop4nK4JlIXO)`. **Auto-assigned** pelo `create_workflow_from_code`.

## Pre-condicao de banco

A query `UPSERT Messages` usa `ON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE`. Requer constraint UNIQUE parcial em `public.messages(msg_id) WHERE msg_id IS NOT NULL`.

**Migration adicionada**: `supabase/migrations/008_messages_msgid_unique.sql` (idempotente, IF NOT EXISTS). **Tem que ser aplicada antes do smoke test em Fase C** (rode no painel SQL Editor do Supabase ou via supabase CLI).

## Comparacao com debt item 2 (RESOLVIDO)

Reconstruído NO SIMPLIFICATIONS após reset:

- Branch audio: era **stub** retornando `'[transcricao simulada]'` sob `_skip_llm_calls=true`. -> **AGORA**: httpRequest POST real para `https://api.openai.com/v1/audio/transcriptions` com `model=gpt-4o-transcribe`, language=pt. Nenhuma flag `_skip_llm_calls` existe no codigo.
- Branch image: era **stub** retornando caption ou `'[descricao simulada]'`. -> **AGORA**: httpRequest POST real para `https://api.openai.com/v1/chat/completions` com `model=gpt-4o-mini`, response_format json_object, prompt PT-BR LITERAL, parse + derive should_handoff/handoff_reason.

## Riscos / Custos / Operacionais

1. **OpenAI rate limit**: branchs audio/image_no_caption disparam 1 chamada por mensagem inbound nao-texto. Tier basico OpenAI tem ~500 RPM em chat/completions. Improvavel batida em volume inicial, mas Fase C deve avaliar metricas reais.
2. **Custo por imagem**: gpt-4o-mini vision ~`$0.000150 input tokens/1k + $0.000600 output tokens/1k` + custo proporcional ao tamanho. Imagem 1024x1024 detail=auto consume ~765 tokens. Estimado < `$0.001 por imagem`. 100 imagens/dia = `$0.10/dia`.
3. **Custo por audio**: gpt-4o-transcribe ~`$0.006/min de audio`. WhatsApp audio tipico 30s = ~`$0.003/audio`. 100 audios/dia = `$0.30/dia`.
4. **PDF parsing fallback**: `extractFromFile` operation=pdf usa `pdf-parse` em backend; PDFs scaneados (apenas imagens) retornam texto vazio. Nesse caso a heuristica regex roda apenas sobre `caption + filename` — pode dar falso negativo se o usuario nao indicar conteudo clinico no nome. Mitigacao: em Fase C avaliar adicao de OCR (Tesseract via httpRequest a um servico externo) se taxa de falso negativo for material.
5. **URL fetch sem retry**: Wikimedia/Evolution media URLs podem dar 404/500 transient. `httpRequest.options.timeout = 30000ms` mas sem retry. Mitigacao: adicionar `continueOnFail` + IF de status check, ou retry custom — diferir para Fase C apos primeiro smoke real.
6. **OpenAI response neverError=true**: se OpenAI retornar 4xx/5xx, o workflow continua com `resp.text=''` (audio) ou `resp.choices` undefined (image, captura em catch). UPSERT messages com normalized_text=`'[audio sem transcricao]'` ou `'[imagem sem descricao]'` ainda acontece — nao trava o fluxo, mas a UX no IGOR_03 sera mais pobre. INSERT events tambem ainda acontece, com payload denotando o fallback. **Decisao consciente**: prefere visibilidade + degradacao graciosa a hard-fail no normalizer.

## O que NAO foi feito (intencional, diferido para Fase C)

- Smoke test end-to-end via execute_workflow MCP com cada um dos 9 fixtures + asserts SQL — Fase C.
- Aplicacao da migration `008_messages_msgid_unique.sql` no Supabase remoto — depende de credencial DB e usuario decidir aplicar.
- Substituicao das URLs de teste Wikimedia por midia real autorizada pelo usuario — pendente decisao do usuario sobre numero de teste/midias.
- Retry/backoff em chamadas OpenAI e fetch externo — diferido.

## Fixtures (9)

Em `fixtures/`:

- `IGOR_02_audio_url.json` — branch audio (fetch URL).
- `IGOR_02_audio_base64.json` — branch audio (decode base64).
- `IGOR_02_image_no_caption.json` — branch image_no_caption (vision real).
- `IGOR_02_image_with_caption.json` — branch image_with_caption (passthrough).
- `IGOR_02_image_clinical_flagged.json` — branch image_with_caption com caption clinica (verifica que regex clinica NAO se aplica a caption, soh a documento).
- `IGOR_02_document_clinical.json` — branch document com filename `exame_laudo_hemograma_crm_12345.pdf` (regex dispara).
- `IGOR_02_document_generic.json` — branch document com filename `agenda_2026.pdf` (regex nao dispara).
- `IGOR_02_text_passthrough.json` — branch text.
- `IGOR_02_unknown_type.json` — branch unknown (messageType=sticker).

Cada fixture inclui `test_run_id` igual ao nome do msgId, permitindo asserts SQL por fixture (vide `tests/asserts-IGOR_02_Media_Normalizer.sql`).

## Asserts SQL

`tests/asserts-IGOR_02_Media_Normalizer.sql` — 21 asserts cobrindo:
- 1 `events('media_normalized')` por fixture.
- payload->>`messageType` correto.
- payload->>`should_handoff` e payload->>`handoff_reason` consistentes com branch.
- payload->`safety_flags`->>`clinical` para document_clinical.
- 1 row em `public.messages` por fixture (UPSERT por msg_id).
- `messages.safety_flags->>'clinical'` consistente com fixture.

## Expected matrix

Documentada em `tests/expected-IGOR_02_Media_Normalizer.md`.
