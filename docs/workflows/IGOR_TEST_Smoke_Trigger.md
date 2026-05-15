# IGOR_TEST_Smoke_Trigger — audit

- **Workflow id n8n**: `G8pMteuirc2yZgq5`
- **Trigger**: `manualTrigger` (botão Execute no UI — não precisa `active: true`).
- **ErrorWorkflow**: `ZrsbaSTlW5bqMEaS` (IGOR_07_Error_Logger).
- **Source-of-truth**: `n8n/workflows/IGOR_TEST_Smoke_Trigger.json` (canonical export). Sem SDK source.
- **Settings dependentes**: `settings.smoke_test_phone` (string OR null), `settings.smoke_test_message` (string). Aplicar migration 012 antes de usar.

## Propósito

Permite operador disparar manualmente uma mensagem WhatsApp pelo Igor (via Evolution `sendText`) para o telefone configurado em `settings.smoke_test_phone`. Quando o operador responder via WhatsApp, o pipeline real (Evolution webhook → IGOR_01 → IGOR_03) é exercitado.

> ℹ️ **Limitação reconhecida**: o pattern original do usuário era simular uma **mensagem ENTRANTE** (POST direto no webhook IGOR_01 com payload Evolution fake). Versão atual dispara um ping bot→user. Pode ser refeito no formato entrante se preferido.

## Fluxo (6 nodes)

```
Manual Trigger
   ↓
Load Test Config  (Postgres: SELECT settings.smoke_test_phone + settings.smoke_test_message)
   ↓
Validate & Prepare  (Code: valida regex 55+DDD+9digits; gera test_run_id; throw se phone null/invalid)
   ↓
Log smoke_trigger_sent  (Postgres: INSERT events('smoke_trigger_sent', payload))
   ↓
Evolution sendText to Test Phone  (HTTP POST /message/sendText/convert-teste com igor_evolution_api)
   ↓
Result  (Set: ok, phone, test_run_id, http_status_code)
```

## Configuração do operador

```sql
-- Definir telefone (formato 55+DDD+9digits, 13 chars, sem '+' nem espaços)
UPDATE public.settings
SET value = '"5562998621000"'::jsonb, updated_at = now()
WHERE key = 'smoke_test_phone';

-- Verificar
SELECT key, value FROM public.settings WHERE key IN ('smoke_test_phone', 'smoke_test_message');
```

## Pendências

- Migration 012 aplicada manualmente no Supabase SQL Editor antes do primeiro uso.
- Credencial `igor_evolution_api` precisa existir no n8n (id `DDhbwLsNclqTA18X`).
