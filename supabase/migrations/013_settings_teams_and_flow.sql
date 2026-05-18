-- Igor — 013_settings_teams_and_flow.sql
-- Refatoração Fluxo 1 (Inbound After-Hours):
-- Introduz 3 teams no Chatwoot e configura settings novos para o gate
-- determinístico "lead novo fora expediente" via owner_flow.
--
-- Contexto:
-- O novo IGOR_01 lê:
--   - settings.ai_team_id            → team "IA Após-Expediente" (default da IA)
--   - settings.human_daytime_team_id → team "Atendimento Humano"
--   - settings.handoff_queue_team_id → team "Aguardando Retorno"
--   - settings.max_alice_turns       → limite de turnos antes de forçar handoff
--
-- Após rodar scripts/seed-chatwoot.sh (atualizado para criar os 3 teams),
-- popular os 3 team_ids com os IDs reais do Chatwoot (vide chatwoot-state.json):
--   UPDATE settings SET value='2'::jsonb WHERE key='ai_team_id';
--   UPDATE settings SET value='1'::jsonb WHERE key='human_daytime_team_id';
--   UPDATE settings SET value='3'::jsonb WHERE key='handoff_queue_team_id';
--
-- Mapeamento UI Chatwoot ↔ chave técnica:
--   "IA Após-Expediente"  ↔ ai_team_id            ↔ owner_flow='ai_active'
--   "Atendimento Humano"  ↔ human_daytime_team_id ↔ owner_flow='human_daytime'
--   "Aguardando Retorno"  ↔ handoff_queue_team_id ↔ owner_flow IN ('handoff_queue','ai_unqualified')
--
-- Aplicação manual no Supabase SQL Editor.

BEGIN;

-- Team IDs default null — preencher após criar teams no Chatwoot via seed.
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('ai_team_id',            'null'::jsonb, now()),
  ('human_daytime_team_id', 'null'::jsonb, now()),
  ('handoff_queue_team_id', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;  -- preserva valor já setado se rerodando

-- Limite de turnos Alice antes de forçar handoff (qualified ou unqualified).
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('max_alice_turns', '6'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;

-- Verificação:
-- SELECT key, value FROM public.settings
-- WHERE key IN ('ai_team_id','human_daytime_team_id','handoff_queue_team_id','max_alice_turns')
-- ORDER BY key;
-- Esperado (após rodar seed e preencher IDs):
--   ai_team_id            → integer
--   handoff_queue_team_id → integer
--   human_daytime_team_id → integer (provavelmente 1, team antigo Atendimento Humano)
--   max_alice_turns       → 6
