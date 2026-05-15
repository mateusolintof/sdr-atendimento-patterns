-- Igor — 009_settings_fase_c_activation.sql
-- Fase C: align settings keys com o que IGOR_01 efetivamente lê do banco
-- + ativar workflows_enabled IGOR_01..IGOR_08 para fase de testes.
--
-- Contexto:
-- Migration 003 criou a tabela settings com:
--   - after_hours_window (objeto único {start, end, timezone})
--   - workflows_enabled = todos false (exceto IGOR_07)
--   - SEM holiday_policy
--
-- IGOR_01 (commit 819d1ca, query node 'Read Settings') faz:
--   SELECT value FROM settings WHERE key='ai_enabled_global'
--   SELECT value FROM settings WHERE key='workflows_enabled'
--   SELECT value FROM settings WHERE key='holidays'
--   SELECT value FROM settings WHERE key='holiday_policy'      ← NOVO
--   SELECT value FROM settings WHERE key='after_hours_start'   ← NOVO
--   SELECT value FROM settings WHERE key='after_hours_end'     ← NOVO
--   SELECT value FROM settings WHERE key='timezone'            ← NOVO
--
-- Esta migration insere as 4 chaves novas E habilita workflows IGOR_01-08
-- para Fase C smoke. Idempotente (ON CONFLICT DO UPDATE).
--
-- Aplicação manual no Supabase SQL Editor.

BEGIN;

-- 1. Garantir ai_enabled_global = true (kill switch global ON).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('ai_enabled_global', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 2. Habilitar IGOR_01..IGOR_08 (não toca em IGOR_09-13 — Campanha permanece false).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('workflows_enabled',
   '{
      "IGOR_01": true, "IGOR_02": true, "IGOR_03": true, "IGOR_04": true,
      "IGOR_05": true, "IGOR_06": true, "IGOR_07": true, "IGOR_08": true,
      "IGOR_09": false, "IGOR_10": false, "IGOR_11": false, "IGOR_12": false,
      "IGOR_13": false
    }'::jsonb,
   now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 3. Adicionar chaves separadas que IGOR_01 lê (in addition to after_hours_window que já existe).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('after_hours_start', '"18:30"'::jsonb, now()),
  ('after_hours_end',   '"07:30"'::jsonb, now()),
  ('timezone',          '"America/Sao_Paulo"'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 4. Holiday policy — comportamento quando settings.holidays inclui hoje (YYYY-MM-DD).
-- 'after_hours_force' = trata feriado como fora-de-expediente (IA responde).
-- Outras opções futuras: 'block_completely' (bloqueia tudo).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('holiday_policy', '"after_hours_force"'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 5. Holidays default [] (no caso de não ter sido seed inicial).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('holidays', '[]'::jsonb, now())
ON CONFLICT (key) DO NOTHING;  -- preserva lista já configurada se houver

-- 6. Confirmar inbox_id capturado pós-criação inbox API Channel Chatwoot (id=1).
-- Substitui o human_inbox_id=null da migration 003.
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('human_inbox_id', '1'::jsonb, now()),
  ('human_inbox_identifier', '"vRrf8MeDTe9DsH11RB3ZRCug"'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;

-- Verificação manual após aplicar:
-- SELECT key, value FROM public.settings ORDER BY key;
--
-- Esperado: 12 chaves no total — ai_enabled_global, workflows_enabled (com IGOR_01-08
-- true), after_hours_start/end, timezone, holidays, holiday_policy, human_team_id,
-- human_inbox_id, human_inbox_identifier, after_hours_window (legado da 003),
-- do_not_contact_keywords (legado), campaign_optout_threshold (legado).
