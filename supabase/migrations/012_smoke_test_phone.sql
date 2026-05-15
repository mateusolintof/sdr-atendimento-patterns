-- Igor — 012_smoke_test_phone.sql
-- Adiciona chave smoke_test_phone na tabela settings para uso pelo workflow
-- IGOR_TEST_Smoke_Trigger (dispara WhatsApp manualmente pro número configurado
-- pra iniciar o pipeline de inbound em ambiente de teste).
--
-- Aplicação manual no Supabase SQL Editor.

BEGIN;

-- Telefone do operador de testes. Formato 55+DDD+9digits (13 chars).
-- Configurar via UPDATE:
--   UPDATE public.settings SET value='"5511987654321"'::jsonb WHERE key='smoke_test_phone';
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('smoke_test_phone', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Mensagem default do smoke trigger (texto enviado pelo bot ao operador).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('smoke_test_message',
   '"Olá! Esta é uma mensagem de teste do Igor para iniciar o fluxo de smoke. Pode responder algo aqui."'::jsonb,
   now())
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verificação:
-- SELECT key, value FROM public.settings WHERE key IN ('smoke_test_phone','smoke_test_message');
