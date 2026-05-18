-- Igor — 014_conversations_owner_flow.sql
-- Refatoração Fluxo 1: adiciona colunas que viabilizam o gate determinístico
-- "lead novo fora expediente" e o controle de turnos da Alice.
--
-- Novas colunas em public.conversations:
--   - journey_started_at: timestamptz NULLABLE
--       Setado APENAS pelo IGOR_01 quando todos os gates passam e a IA assume.
--       Nunca resetado. Usado como gate "is_new_lead_journey = (journey_started_at IS NULL)".
--   - owner_flow: text
--       Estado granular da conversation. Substitui a combinação ai_enabled+human_locked
--       como fonte de verdade primária do gate IA. Valores:
--         'ai_active'        → IA atua (fora expediente, lead novo)
--         'human_daytime'    → humano atua (dentro expediente ou jornada existente)
--         'handoff_queue'    → caminho A (qualificado), aguardando humano
--         'ai_unqualified'   → caminho B (não engajou), aguardando triagem
--         'compliance_hold'  → bloqueio por conteúdo clínico
--         'opt_out'          → bloqueio definitivo
--   - turn_count: int
--       Contador de turnos Alice (incrementado em cada execução do IGOR_01 que
--       chega até a IA). Lido por IGOR_03 para auto-monitoramento contra
--       settings.max_alice_turns.
--
-- Coexistência com colunas existentes:
--   - current_flow continua existindo (after_hours | campaign | null) — identifica
--     qual fluxo é dono. owner_flow é mais granular (estado dentro do fluxo).
--   - ai_enabled e human_locked continuam como espelho/redundância — IGOR_05
--     seta os 3 (owner_flow, ai_enabled=false, human_locked=true) no handoff.
--
-- Aplicação manual no Supabase SQL Editor.

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS journey_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_flow         text,
  ADD COLUMN IF NOT EXISTS turn_count         int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.conversations.journey_started_at IS
  'Setado pelo IGOR_01 quando IA assume (uma vez). Nunca resetado. Gate "lead novo".';
COMMENT ON COLUMN public.conversations.owner_flow IS
  'Estado granular: ai_active | human_daytime | handoff_queue | ai_unqualified | compliance_hold | opt_out';
COMMENT ON COLUMN public.conversations.turn_count IS
  'Turnos Alice executados nesta conversation; limite em settings.max_alice_turns';

-- Índice para consultas de gate em IGOR_01 ("WHERE owner_flow IN (...)").
CREATE INDEX IF NOT EXISTS idx_conversations_owner_flow
  ON public.conversations(owner_flow);

-- Backfill: deriva owner_flow inicial das flags existentes (ai_enabled, human_locked).
-- Rodada uma única vez; subsequentes execuções não tocam rows com owner_flow já setado.
UPDATE public.conversations
SET owner_flow = CASE
  WHEN human_locked THEN 'human_daytime'
  WHEN NOT ai_enabled THEN 'human_daytime'
  WHEN state = 'opt_out' THEN 'opt_out'
  ELSE 'ai_active'
END
WHERE owner_flow IS NULL;

COMMIT;

-- Verificação:
-- \d public.conversations
-- SELECT owner_flow, count(*) FROM public.conversations GROUP BY owner_flow;
-- Esperado: colunas journey_started_at (nullable), owner_flow (text + index),
-- turn_count (int default 0). Distribuição de owner_flow espelha ai_enabled/human_locked.
