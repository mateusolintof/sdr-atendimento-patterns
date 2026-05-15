-- Igor — 011_chatwoot_assignee_optional.sql
-- Fix de bug funcional identificado pelo usuário (2026-05-15):
-- IGOR_05 IF "Has Assignee?" estava hardcoded com leftValue="=1" + notEmpty,
-- então sempre disparava (dead-code condicional). A semântica original era
-- "atribuir assignee específico SE configurado; senão team-only".
--
-- Chatwoot API (developers.chatwoot.com): assignee_id é OPCIONAL.
-- "If the assignee_id is present, this param would be ignored" → ou seja, se
-- assignee_id presente, team_id da chamada anterior é sobrescrito.
--
-- Solução: chave `chatwoot_human_assignee_id` em settings (default NULL).
-- Workflow IGOR_05 checa esse valor — se NULL/0/''  → skip assignee POST
-- (team-only). Se setado → POST com assignee_id real.
--
-- Aplicação manual no Supabase SQL Editor.

BEGIN;

-- Default null = team-only (sem assignee individual).
-- Para configurar atendente específico: UPDATE settings SET value='5' WHERE key='chatwoot_human_assignee_id';
INSERT INTO public.settings (key, value, updated_at) VALUES
  ('chatwoot_human_assignee_id', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;  -- preserva valor existente se já setado

COMMIT;

-- Verificação:
-- SELECT key, value FROM public.settings WHERE key='chatwoot_human_assignee_id';
-- Esperado: value=null (default) OU integer (se configurado depois).
