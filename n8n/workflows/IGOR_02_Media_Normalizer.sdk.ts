// =============================================================================
// SOURCE OF TRUTH NOTICE
// =============================================================================
// The CANONICAL workflow representation is the sibling JSON file:
//   `IGOR_02_Media_Normalizer.json`
//
// This .sdk.ts file was used to generate the initial JSON via the n8n MCP
// `create_workflow_from_code` tool. After creation, the following workflow-
// level properties are set ONLY in the JSON (the SDK API surface accepted by
// `create_workflow_from_code` did not allow declaring them):
//   - "active": false
//   - "settings.errorWorkflow": "ZrsbaSTlW5bqMEaS"  (IGOR_07_Error_Logger)
//   - "settings.executionOrder": "v1"
//   - "settings.availableInMCP": true
//   - "tags": ["igor", "inbound", "media", "fase-b-rebuild"]
//
// IF you regenerate the workflow from this SDK source (re-running
// `create_workflow_from_code`), the five properties above WILL BE LOST.
// You must re-apply them by either:
//   (a) PATCHing the resulting workflow via n8n REST API after create, or
//   (b) Importing the canonical JSON file directly (preferred).
//
// Do NOT treat this SDK file as the single source of truth without
// re-applying the JSON-only properties above.
// =============================================================================

import {
  workflow,
  node,
  trigger,
  ifElse,
  switchCase,
  merge,
  newCredential,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// IGOR_02_Media_Normalizer
// =============================================================================
// Callable que normaliza mídia inbound antes de qualquer agente.
//
// Branches (decididas em Validate Payload e roteadas via Switch):
//   - audio              -> baixa media (URL ou base64) -> POST OpenAI
//                           /v1/audio/transcriptions (model=gpt-4o-transcribe)
//                           -> formata normalized_text com transcript.
//   - image_with_caption -> caption como normalized_text, safety_flags default.
//   - image_no_caption   -> baixa media -> POST OpenAI /v1/chat/completions
//                           (model=gpt-4o-mini) com prompt PT-BR restritivo LITERAL
//                           e response_format json_object -> parse descricao + tipo
//                           + safety_flags -> seta should_handoff/handoff_reason
//                           se clinical/sensitive_image.
//   - document           -> extractFromFile(pdf) -> heuristica regex sobre
//                           caption+filename+text extraido -> safety_flags.clinical
//                           + should_handoff='documento_clinico_sensivel' em match.
//   - text               -> passthrough (caption -> normalized_text).
//   - unknown            -> should_handoff=true, handoff_reason='midia_desconhecida'.
//
// Merge final consolida 6 branches em payload uniforme.
// UPSERT messages (ON CONFLICT msg_id), INSERT events('media_normalized').
// Errors -> IGOR_07_Error_Logger via settings.errorWorkflow.
// =============================================================================

const executeTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'phone', type: 'string' },
          { name: 'msgId', type: 'string' },
          { name: 'messageType', type: 'string' },
          { name: 'media_url', type: 'string' },
          { name: 'media_base64', type: 'string' },
          { name: 'caption', type: 'string' },
          { name: 'mimeType', type: 'string' },
          { name: 'chatwoot_conversation_id', type: 'string' },
          { name: 'test_run_id', type: 'string' },
        ],
      },
    },
    position: [0, 0],
  },
  output: [{
    phone: '5511999990001',
    msgId: 'IGOR_02_FIXTURE_audio_url',
    messageType: 'audio',
    media_url: 'https://example.com/a.ogg',
    media_base64: '',
    caption: '',
    mimeType: 'audio/ogg',
    chatwoot_conversation_id: '9000001',
    test_run_id: 'IGOR_02_FIXTURE_audio_url',
  }],
});

// -----------------------------------------------------------------------------
// VALIDATE PAYLOAD — coerce + classify branch
// -----------------------------------------------------------------------------

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const strOrEmpty = v => (v === undefined || v === null) ? '' : String(v);\n  const phone = strOrEmpty(j.phone);\n  const msgId = strOrEmpty(j.msgId);\n  const messageType = strOrEmpty(j.messageType).toLowerCase();\n  const mediaUrl = strOrEmpty(j.media_url);\n  const mediaBase64 = strOrEmpty(j.media_base64);\n  const caption = strOrEmpty(j.caption);\n  const mimeType = strOrEmpty(j.mimeType);\n  const convId = strOrEmpty(j.chatwoot_conversation_id);\n  const testRunId = strOrEmpty(j.test_run_id);\n  if (!msgId) throw new Error('IGOR_02: msgId is required');\n  if (!messageType) throw new Error('IGOR_02: messageType is required');\n  const allowedTypes = ['text', 'audio', 'image', 'document'];\n  let branch;\n  if (messageType === 'audio') branch = 'audio';\n  else if (messageType === 'image') branch = caption.trim().length > 0 ? 'image_with_caption' : 'image_no_caption';\n  else if (messageType === 'document') branch = 'document';\n  else if (messageType === 'text') branch = 'text';\n  else branch = 'unknown';\n  const hasMediaUrl = mediaUrl.length > 0;\n  const hasMediaBase64 = mediaBase64.length > 0;\n  return {\n    json: {\n      phone,\n      msgId,\n      messageType,\n      media_url: mediaUrl,\n      media_base64: mediaBase64,\n      caption,\n      mimeType,\n      chatwoot_conversation_id: convId,\n      test_run_id: testRunId,\n      _branch: branch,\n      _has_media_url: hasMediaUrl,\n      _has_media_base64: hasMediaBase64\n    }\n  };\n});",
    },
    position: [220, 0],
  },
  output: [{
    phone: '5511999990001',
    msgId: 'IGOR_02_FIXTURE_audio_url',
    messageType: 'audio',
    media_url: 'https://example.com/a.ogg',
    media_base64: '',
    caption: '',
    mimeType: 'audio/ogg',
    chatwoot_conversation_id: '9000001',
    test_run_id: 'IGOR_02_FIXTURE_audio_url',
    _branch: 'audio',
    _has_media_url: true,
    _has_media_base64: false,
  }],
});

// -----------------------------------------------------------------------------
// SWITCH BY BRANCH (6 outputs)
// -----------------------------------------------------------------------------

const routeByBranch = switchCase({
  version: 3.4,
  config: {
    name: 'Route By Branch',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-audio',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'audio',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'audio',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-img-cap',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'image_with_caption',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'image_with_caption',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-img-no-cap',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'image_no_caption',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'image_no_caption',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-doc',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'document',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'document',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-text',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'text',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'text',
          },
          {
            conditions: {
              combinator: 'and',
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  id: 'route-unknown',
                  leftValue: expr('={{ $json._branch }}'),
                  rightValue: 'unknown',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
            renameOutput: true,
            outputKey: 'unknown',
          },
        ],
      },
      options: { allMatchingOutputs: false },
    },
    position: [440, 0],
  },
});

// =============================================================================
// AUDIO BRANCH
// =============================================================================

const audioHasUrlIf = ifElse({
  version: 2.3,
  config: {
    name: 'Audio Has URL?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'audio-has-url-cond',
            leftValue: expr('={{ $json._has_media_url }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
      },
    },
    position: [660, -540],
  },
});

const audioFetchUrl = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Audio Fetch URL',
    parameters: {
      method: 'GET',
      url: expr('={{ $json.media_url }}'),
      authentication: 'none',
      options: {
        response: {
          response: {
            responseFormat: 'file',
            outputPropertyName: 'data',
          },
        },
        timeout: 30000,
      },
    },
    position: [880, -640],
  },
  output: [{ binary: { data: { fileName: 'audio.ogg', mimeType: 'audio/ogg' } } }],
});

const audioDecodeBase64 = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Audio Decode Base64',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const b64 = String(j.media_base64 || '');\n  const mime = String(j.mimeType || 'audio/ogg');\n  let ext = 'ogg';\n  if (mime.includes('mp3') || mime.includes('mpeg')) ext = 'mp3';\n  else if (mime.includes('wav')) ext = 'wav';\n  else if (mime.includes('m4a') || mime.includes('mp4')) ext = 'm4a';\n  else if (mime.includes('webm')) ext = 'webm';\n  const buffer = Buffer.from(b64, 'base64');\n  return {\n    json: { ...j, _audio_decoded: true, _audio_bytes: buffer.length },\n    binary: {\n      data: {\n        data: b64,\n        fileName: `audio.${ext}`,\n        mimeType: mime,\n        fileExtension: ext\n      }\n    }\n  };\n});",
    },
    position: [880, -440],
  },
  output: [{ _audio_decoded: true, _audio_bytes: 1024 }],
});

const audioMergeBinary = merge({
  version: 3.2,
  config: {
    name: 'Audio Merge Binary',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [1100, -540],
  },
});

const audioTranscribe = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Audio Transcribe (gpt-4o-transcribe)',
    parameters: {
      method: 'POST',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      contentType: 'multipart-form-data',
      bodyParameters: {
        parameters: [
          { name: 'file', value: '={{ $binary.data }}' },
          { name: 'model', value: 'gpt-4o-transcribe' },
          { name: 'language', value: 'pt' },
          { name: 'response_format', value: 'json' },
        ],
      },
      options: {
        response: {
          response: {
            responseFormat: 'json',
            neverError: true,
          },
        },
        timeout: 60000,
      },
    },
    credentials: {
      // @ts-ignore — openAiApi is a predefinedCredentialType not in HttpRequestV44Credentials
      openAiApi: newCredential('igor_openai'),
    },
    position: [1320, -540],
  },
  output: [{ text: 'oi, queria saber sobre o tratamento' }],
});

const audioFormat = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Audio Format',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const validated = $('Validate Payload').first().json;\nconst items = $input.all();\nreturn items.map(item => {\n  const resp = item.json || {};\n  const transcript = String(resp.text || '').trim();\n  const normalizedText = transcript.length > 0 ? transcript : '[audio sem transcricao]';\n  const mediaSummary = '[audio transcrito] ' + transcript.slice(0, 200);\n  const safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  return {\n    json: {\n      phone: validated.phone,\n      msgId: validated.msgId,\n      messageType: validated.messageType,\n      chatwoot_conversation_id: validated.chatwoot_conversation_id,\n      test_run_id: validated.test_run_id,\n      _branch: 'audio',\n      normalized_text: normalizedText,\n      media_summary: mediaSummary,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: false,\n      handoff_reason: null,\n      audio_transcribed: transcript.length > 0\n    }\n  };\n});",
    },
    position: [1540, -540],
  },
  output: [{
    _branch: 'audio',
    normalized_text: 'oi, queria saber sobre o tratamento',
    media_summary: '[audio transcrito] oi, queria saber sobre o tratamento',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: false,
    handoff_reason: null,
    audio_transcribed: true,
  }],
});

// =============================================================================
// IMAGE WITH CAPTION BRANCH (passthrough)
// =============================================================================

const imageWithCaptionFormat = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Image w/ Caption Format',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const caption = String(j.caption || '').trim();\n  const normalizedText = caption;\n  const mediaSummary = '[imagem com caption] ' + caption.slice(0, 200);\n  const safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  return {\n    json: {\n      phone: j.phone,\n      msgId: j.msgId,\n      messageType: j.messageType,\n      chatwoot_conversation_id: j.chatwoot_conversation_id,\n      test_run_id: j.test_run_id,\n      _branch: 'image_with_caption',\n      normalized_text: normalizedText,\n      media_summary: mediaSummary,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: false,\n      handoff_reason: null\n    }\n  };\n});",
    },
    position: [660, -260],
  },
  output: [{
    _branch: 'image_with_caption',
    normalized_text: 'oi, queria saber sobre o tratamento',
    media_summary: '[imagem com caption] oi, queria saber sobre o tratamento',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: false,
    handoff_reason: null,
  }],
});

// =============================================================================
// IMAGE NO CAPTION BRANCH (vision gpt-4o-mini)
// =============================================================================

const imageHasUrlIf = ifElse({
  version: 2.3,
  config: {
    name: 'Image Has URL?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'image-has-url-cond',
            leftValue: expr('={{ $json._has_media_url }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
      },
    },
    position: [660, 80],
  },
});

const imageFetchUrl = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Image Fetch URL',
    parameters: {
      method: 'GET',
      url: expr('={{ $json.media_url }}'),
      authentication: 'none',
      options: {
        response: {
          response: {
            responseFormat: 'file',
            outputPropertyName: 'data',
          },
        },
        timeout: 30000,
      },
    },
    position: [880, 20],
  },
  output: [{ binary: { data: { fileName: 'image.png', mimeType: 'image/png' } } }],
});

const imageEncodeDataUrl = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Image Encode DataURL',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const validated = $('Validate Payload').first().json;\nconst items = $input.all();\nreturn items.map(item => {\n  let base64;\n  let mimeType;\n  const bin = item.binary && item.binary.data;\n  if (bin && bin.data) {\n    base64 = String(bin.data);\n    mimeType = String(bin.mimeType || validated.mimeType || 'image/png');\n  } else if (validated.media_base64) {\n    base64 = String(validated.media_base64);\n    mimeType = String(validated.mimeType || 'image/png');\n  } else {\n    throw new Error('IGOR_02 image_no_caption: no binary and no media_base64 to encode');\n  }\n  const dataUrl = 'data:' + mimeType + ';base64,' + base64;\n  return { json: { image_data_url: dataUrl, image_mime_type: mimeType } };\n});",
    },
    position: [1100, 80],
  },
  output: [{ image_data_url: 'data:image/png;base64,iVBORw0KGgo=', image_mime_type: 'image/png' }],
});

const imageVisionRequest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Image Vision (gpt-4o-mini)',
    parameters: {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('={{ JSON.stringify({\n  model: "gpt-4o-mini",\n  response_format: { type: "json_object" },\n  temperature: 0,\n  max_tokens: 400,\n  messages: [\n    {\n      role: "user",\n      content: [\n        { type: "text", text: "Voce descreve imagens enviadas por leads de uma clinica medica. NAO interpreta clinicamente. NAO da orientacao medica. NAO diagnostica.\\nResponda APENAS em JSON com este schema:\\n{\\n  \\"descricao\\": \\"string - breve descricao neutra do que aparece (max 200 chars)\\",\\n  \\"tipo\\": \\"selfie_rosto | selfie_corpo | documento | exame_imagem | prescricao | comprovante_pagamento | captura_de_tela | outro\\",\\n  \\"safety_flags\\": {\\n    \\"clinical\\": \\"boolean - true se for exame, laudo, imagem medica, prescricao, raio-X, ultrassom, ressonancia, tomografia, etc.\\",\\n    \\"sensitive_image\\": \\"boolean - true se for nudez, ferida exposta, antes/depois corporal, partes intimas\\",\\n    \\"payment_proof\\": \\"boolean - true se for comprovante PIX, transferencia ou recibo\\",\\n    \\"financial\\": \\"boolean - true se for boleto, fatura ou documento financeiro\\"\\n  }\\n}" },\n        { type: "image_url", image_url: { url: $json.image_data_url } }\n      ]\n    }\n  ]\n}) }}'),
      options: {
        response: {
          response: {
            responseFormat: 'json',
            neverError: true,
          },
        },
        timeout: 60000,
      },
    },
    credentials: {
      // @ts-ignore — openAiApi is a predefinedCredentialType not in HttpRequestV44Credentials
      openAiApi: newCredential('igor_openai'),
    },
    position: [1320, 80],
  },
  output: [{
    id: 'chatcmpl-xxx',
    choices: [{
      message: {
        content: '{"descricao":"imagem de teste","tipo":"outro","safety_flags":{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}}',
      },
    }],
  }],
});

const imageParseResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Image Parse Vision',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const validated = $('Validate Payload').first().json;\nconst items = $input.all();\nreturn items.map(item => {\n  const resp = item.json || {};\n  let descricao = '';\n  let tipo = 'outro';\n  let safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  let parsedOk = false;\n  try {\n    const choices = Array.isArray(resp.choices) ? resp.choices : [];\n    const content = choices.length > 0 && choices[0].message ? String(choices[0].message.content || '') : '';\n    if (content) {\n      const parsed = JSON.parse(content);\n      descricao = String(parsed.descricao || '').trim();\n      tipo = String(parsed.tipo || 'outro').trim();\n      const sf = parsed.safety_flags || {};\n      safetyFlags = {\n        clinical: Boolean(sf.clinical),\n        sensitive_image: Boolean(sf.sensitive_image),\n        payment_proof: Boolean(sf.payment_proof),\n        financial: Boolean(sf.financial)\n      };\n      parsedOk = true;\n    }\n  } catch (e) {\n    descricao = '[imagem nao classificada - parse falhou]';\n    safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  }\n  if (!descricao) descricao = '[imagem sem descricao]';\n  let shouldHandoff = false;\n  let handoffReason = null;\n  if (safetyFlags.clinical) {\n    shouldHandoff = true;\n    handoffReason = 'imagem_clinica_sensivel';\n  } else if (safetyFlags.sensitive_image) {\n    shouldHandoff = true;\n    handoffReason = 'imagem_sensivel';\n  }\n  return {\n    json: {\n      phone: validated.phone,\n      msgId: validated.msgId,\n      messageType: validated.messageType,\n      chatwoot_conversation_id: validated.chatwoot_conversation_id,\n      test_run_id: validated.test_run_id,\n      _branch: 'image_no_caption',\n      normalized_text: '[imagem] ' + descricao,\n      media_summary: descricao,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: shouldHandoff,\n      handoff_reason: handoffReason,\n      image_tipo: tipo,\n      _vision_parsed_ok: parsedOk\n    }\n  };\n});",
    },
    position: [1540, 80],
  },
  output: [{
    _branch: 'image_no_caption',
    normalized_text: '[imagem] imagem de teste',
    media_summary: 'imagem de teste',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: false,
    handoff_reason: null,
    image_tipo: 'outro',
    _vision_parsed_ok: true,
  }],
});

// =============================================================================
// DOCUMENT BRANCH (extractFromFile + regex heuristic)
// =============================================================================

const documentHasUrlIf = ifElse({
  version: 2.3,
  config: {
    name: 'Document Has URL?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'document-has-url-cond',
            leftValue: expr('={{ $json._has_media_url }}'),
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
      },
    },
    position: [660, 460],
  },
});

const documentFetchUrl = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Document Fetch URL',
    parameters: {
      method: 'GET',
      url: expr('={{ $json.media_url }}'),
      authentication: 'none',
      options: {
        response: {
          response: {
            responseFormat: 'file',
            outputPropertyName: 'data',
          },
        },
        timeout: 30000,
      },
    },
    position: [880, 400],
  },
  output: [{ binary: { data: { fileName: 'doc.pdf', mimeType: 'application/pdf' } } }],
});

const documentDecodeBase64 = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Document Decode Base64',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const b64 = String(j.media_base64 || '');\n  const mime = String(j.mimeType || 'application/pdf');\n  const fileName = String(j.caption || 'document.pdf').split(' ')[0];\n  return {\n    json: { ...j, _doc_decoded: true },\n    binary: {\n      data: {\n        data: b64,\n        fileName: fileName.endsWith('.pdf') ? fileName : (fileName + '.pdf'),\n        mimeType: mime\n      }\n    }\n  };\n});",
    },
    position: [880, 580],
  },
  output: [{ _doc_decoded: true }],
});

const documentMergeBinary = merge({
  version: 3.2,
  config: {
    name: 'Document Merge Binary',
    parameters: { mode: 'append', numberInputs: 2 },
    position: [1100, 460],
  },
});

const documentExtractPdf = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Document Extract PDF',
    parameters: {
      operation: 'pdf',
      binaryPropertyName: 'data',
      options: {
        joinPages: true,
        maxPages: 0,
        keepSource: 'json',
      },
    },
    onError: 'continueRegularOutput',
    position: [1320, 460],
  },
  output: [{ text: 'conteudo extraido do pdf', numpages: 1 }],
});

const documentClassify = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Document Classify Heuristic',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const validated = $('Validate Payload').first().json;\nconst items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const extractedText = String(j.text || '');\n  const caption = String(validated.caption || '');\n  const filename = caption.length > 0 ? caption : '';\n  const haystack = (caption + ' ' + filename + ' ' + extractedText).toLowerCase();\n  const clinicalRegex = /(exame|laudo|prescri[cç][ãa]o|receita|crm[\\-\\s]?\\d|diagn[oó]stico|hemograma|raio[\\s-]?x|ressonancia|tomografia)/i;\n  const isClinical = clinicalRegex.test(haystack);\n  const textLen = extractedText.length;\n  const snippet = extractedText.slice(0, 300);\n  const normalizedText = '[documento] ' + (filename || 'arquivo.pdf') + ' (' + textLen + ' chars)';\n  const mediaSummary = snippet.length > 0 ? snippet : ('[documento ' + (filename || 'arquivo.pdf') + ']');\n  const safetyFlags = {\n    clinical: isClinical,\n    sensitive_image: false,\n    payment_proof: false,\n    financial: false\n  };\n  return {\n    json: {\n      phone: validated.phone,\n      msgId: validated.msgId,\n      messageType: validated.messageType,\n      chatwoot_conversation_id: validated.chatwoot_conversation_id,\n      test_run_id: validated.test_run_id,\n      _branch: 'document',\n      normalized_text: normalizedText,\n      media_summary: mediaSummary,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: isClinical,\n      handoff_reason: isClinical ? 'documento_clinico_sensivel' : null,\n      document_text_length: textLen\n    }\n  };\n});",
    },
    position: [1540, 460],
  },
  output: [{
    _branch: 'document',
    normalized_text: '[documento] exame_laudo.pdf (0 chars)',
    media_summary: '[documento exame_laudo.pdf]',
    safety_flags: { clinical: true, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":true,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: true,
    handoff_reason: 'documento_clinico_sensivel',
    document_text_length: 0,
  }],
});

// =============================================================================
// TEXT BRANCH (passthrough)
// =============================================================================

const textFormat = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Text Format',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const caption = String(j.caption || '');\n  const normalizedText = caption;\n  const mediaSummary = '[texto]';\n  const safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  return {\n    json: {\n      phone: j.phone,\n      msgId: j.msgId,\n      messageType: j.messageType,\n      chatwoot_conversation_id: j.chatwoot_conversation_id,\n      test_run_id: j.test_run_id,\n      _branch: 'text',\n      normalized_text: normalizedText,\n      media_summary: mediaSummary,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: false,\n      handoff_reason: null\n    }\n  };\n});",
    },
    position: [660, 840],
  },
  output: [{
    _branch: 'text',
    normalized_text: 'oi, gostaria de saber',
    media_summary: '[texto]',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: false,
    handoff_reason: null,
  }],
});

// =============================================================================
// UNKNOWN BRANCH (handoff)
// =============================================================================

const unknownFormat = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Unknown Format',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const items = $input.all();\nreturn items.map(item => {\n  const j = item.json || {};\n  const mt = String(j.messageType || '');\n  const normalizedText = '[midia desconhecida tipo=' + mt + ']';\n  const mediaSummary = normalizedText;\n  const safetyFlags = { clinical: false, sensitive_image: false, payment_proof: false, financial: false };\n  return {\n    json: {\n      phone: j.phone,\n      msgId: j.msgId,\n      messageType: j.messageType,\n      chatwoot_conversation_id: j.chatwoot_conversation_id,\n      test_run_id: j.test_run_id,\n      _branch: 'unknown',\n      normalized_text: normalizedText,\n      media_summary: mediaSummary,\n      safety_flags: safetyFlags,\n      safety_flags_json: JSON.stringify(safetyFlags),\n      should_handoff: true,\n      handoff_reason: 'midia_desconhecida'\n    }\n  };\n});",
    },
    position: [660, 1080],
  },
  output: [{
    _branch: 'unknown',
    normalized_text: '[midia desconhecida tipo=sticker]',
    media_summary: '[midia desconhecida tipo=sticker]',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    safety_flags_json: '{"clinical":false,"sensitive_image":false,"payment_proof":false,"financial":false}',
    should_handoff: true,
    handoff_reason: 'midia_desconhecida',
  }],
});

// =============================================================================
// MERGE BRANCHES + UPSERT messages + INSERT events
// =============================================================================

const mergeBranches = merge({
  version: 3.2,
  config: {
    name: 'Merge Branches',
    parameters: { mode: 'append', numberInputs: 6 },
    position: [1760, 200],
  },
});

const upsertMessage = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'UPSERT Messages',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.messages (\n  conversation_id, msg_id, text, normalized_text, message_type, direction, role, from_me, media_summary, safety_flags, created_at\n)\nSELECT\n  c.id,\n  $1::text,\n  NULL,\n  $2::text,\n  $3::text,\n  'inbound',\n  'user',\n  false,\n  $4::text,\n  $5::jsonb,\n  now()\nFROM public.conversations c\nWHERE c.chatwoot_conversation_id = NULLIF($6::text, '')::int\nON CONFLICT (msg_id) WHERE msg_id IS NOT NULL DO UPDATE\nSET\n  normalized_text = EXCLUDED.normalized_text,\n  media_summary = EXCLUDED.media_summary,\n  safety_flags = EXCLUDED.safety_flags;",
      options: {
        queryReplacement: expr("={{ (function(){ const m = $('Merge Branches').first().json; return [m.msgId, m.normalized_text, m.messageType, m.media_summary, m.safety_flags_json, m.chatwoot_conversation_id]; })() }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    continueOnFail: true,
    position: [1980, 200],
  },
  output: [{ executionStatus: 'success' }],
});

const insertEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'INSERT Event media_normalized',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO public.events (event_type, phone, chatwoot_conversation_id, workflow_name, payload)\nVALUES (\n  'media_normalized',\n  $1::text,\n  NULLIF($2::text, '')::int,\n  'IGOR_02_Media_Normalizer',\n  $3::jsonb\n);",
      options: {
        queryReplacement: expr("={{ (function(){ const m = $('Merge Branches').first().json; return [m.phone, m.chatwoot_conversation_id, JSON.stringify({ test_run_id: m.test_run_id, msgId: m.msgId, messageType: m.messageType, branch: m._branch, safety_flags: m.safety_flags, should_handoff: m.should_handoff, handoff_reason: m.handoff_reason, normalized_text_length: (m.normalized_text || '').length, media_summary_length: (m.media_summary || '').length })]; })() }}"),
      },
    },
    credentials: {
      postgres: newCredential('igor_supabase_postgres'),
    },
    position: [2200, 200],
  },
  output: [{ executionStatus: 'success' }],
});

const finalOutput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Final Output',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'out-normalized-text',
            name: 'normalized_text',
            value: expr("={{ $('Merge Branches').first().json.normalized_text }}"),
            type: 'string',
          },
          {
            id: 'out-media-summary',
            name: 'media_summary',
            value: expr("={{ $('Merge Branches').first().json.media_summary }}"),
            type: 'string',
          },
          {
            id: 'out-safety-flags',
            name: 'safety_flags',
            value: expr("={{ $('Merge Branches').first().json.safety_flags }}"),
            type: 'object',
          },
          {
            id: 'out-should-handoff',
            name: 'should_handoff',
            value: expr("={{ $('Merge Branches').first().json.should_handoff }}"),
            type: 'boolean',
          },
          {
            id: 'out-handoff-reason',
            name: 'handoff_reason',
            value: expr("={{ $('Merge Branches').first().json.handoff_reason }}"),
            type: 'string',
          },
          {
            id: 'out-msgid',
            name: 'msgId',
            value: expr("={{ $('Merge Branches').first().json.msgId }}"),
            type: 'string',
          },
          {
            id: 'out-branch',
            name: 'branch',
            value: expr("={{ $('Merge Branches').first().json._branch }}"),
            type: 'string',
          },
          {
            id: 'out-test-run-id',
            name: 'test_run_id',
            value: expr("={{ $('Merge Branches').first().json.test_run_id }}"),
            type: 'string',
          },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    position: [2420, 200],
  },
  output: [{
    normalized_text: 'oi, queria saber sobre o tratamento',
    media_summary: '[audio transcrito] oi, queria saber sobre o tratamento',
    safety_flags: { clinical: false, sensitive_image: false, payment_proof: false, financial: false },
    should_handoff: false,
    handoff_reason: null,
    msgId: 'IGOR_02_FIXTURE_audio_url',
    branch: 'audio',
    test_run_id: 'IGOR_02_FIXTURE_audio_url',
  }],
});

// =============================================================================
// WIRE WORKFLOW
// =============================================================================

export default workflow('IGOR_02_Media_Normalizer', 'IGOR_02_Media_Normalizer')
  .add(executeTrigger)
  .to(validatePayload)
  .to(
    routeByBranch
      .onCase(0,
        audioHasUrlIf
          .onTrue(audioFetchUrl.to(audioMergeBinary.input(0)))
          .onFalse(audioDecodeBase64.to(audioMergeBinary.input(1)))
      )
      .onCase(1, imageWithCaptionFormat)
      .onCase(2,
        imageHasUrlIf
          .onTrue(imageFetchUrl.to(imageEncodeDataUrl))
          .onFalse(imageEncodeDataUrl)
      )
      .onCase(3,
        documentHasUrlIf
          .onTrue(documentFetchUrl.to(documentMergeBinary.input(0)))
          .onFalse(documentDecodeBase64.to(documentMergeBinary.input(1)))
      )
      .onCase(4, textFormat.to(mergeBranches.input(4)))
      .onCase(5, unknownFormat.to(mergeBranches.input(5)))
  )
  .add(audioMergeBinary)
  .to(audioTranscribe)
  .to(audioFormat)
  .to(mergeBranches.input(0))
  .add(imageWithCaptionFormat)
  .to(mergeBranches.input(1))
  .add(imageEncodeDataUrl)
  .to(imageVisionRequest)
  .to(imageParseResponse)
  .to(mergeBranches.input(2))
  .add(documentMergeBinary)
  .to(documentExtractPdf)
  .to(documentClassify)
  .to(mergeBranches.input(3))
  .add(mergeBranches)
  .to(upsertMessage)
  .to(insertEvent)
  .to(finalOutput);
