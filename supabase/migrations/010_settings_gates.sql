-- Igor — 010_settings_gates.sql
-- Fase C revisão: gates operacionais (dry_run_send, allow_real_whatsapp_send)
-- agora vêm da tabela public.settings (não mais de process.env / $env.X).
--
-- Contexto:
-- IGOR_03 e IGOR_05 anteriormente liam process.env.IGOR_DRY_RUN /
-- process.env.ALLOW_REAL_WHATSAPP_SEND dentro de Code nodes. Em runtime
-- n8n self-hosted Community esses valores eram sempre undefined porque
-- N8N_BLOCK_ENV_ACCESS_IN_NODE=true e o container não exporta as vars.
-- Comportamento de fato era sempre fallback "dry_run" — funcionou por sorte
-- mas a leitura estava quebrada.
--
-- Solução (2026-05-15): adicionar Postgres node "Load Gates" no início
-- de IGOR_03 e IGOR_05 que faz SELECT destas 2 chaves, e o Code node
-- "Validate Payload" passa a ler de $('Load Gates').first().json.X.
--
-- Defaults seguros: dry_run_send=true, allow_real_whatsapp_send=false.
-- Para liberar envio real no smoke autorizado:
--   UPDATE public.settings SET value='true'::jsonb WHERE key='allow_real_whatsapp_send';
--   UPDATE public.settings SET value='false'::jsonb WHERE key='dry_run_send';
--
-- Idempotente (ON CONFLICT DO NOTHING). Aplicação manual no Supabase SQL Editor.

BEGIN;

INSERT INTO public.settings (key, value, updated_at) VALUES
  ('dry_run_send', 'true'::jsonb, now()),
  ('allow_real_whatsapp_send', 'false'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Verificação read-only no final (não afeta state):
SELECT key, value
FROM public.settings
WHERE key IN ('dry_run_send','allow_real_whatsapp_send')
ORDER BY key;

COMMIT;
