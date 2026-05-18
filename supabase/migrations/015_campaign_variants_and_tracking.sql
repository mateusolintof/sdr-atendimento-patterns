-- Igor — 015_campaign_variants_and_tracking.sql
-- Habilita Fluxo 2 (IGOR_Campaign_Sender):
--  1. Coluna message_variants em campaign_runs (anti-block via rotação)
--  2. Toggle workflows_enabled.IGOR_Campaign_Sender em settings
--  3. Seed das 3 variantes na campanha promo_maio_2026
-- Aplicar APÓS 014_conversations_owner_flow.sql.

-- 1) Coluna nova
ALTER TABLE public.campaign_runs
  ADD COLUMN IF NOT EXISTS message_variants jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.campaign_runs.message_variants IS
  'Array JSONB de strings — variantes da mensagem para reduzir risco de bloqueio do número. Vazio = workflow usa message_template como fallback.';

-- 2) Habilita workflow novo em settings
UPDATE public.settings
SET value = COALESCE(value::jsonb, '{}'::jsonb) || '{"IGOR_Campaign_Sender": true}'::jsonb,
    updated_at = now()
WHERE key = 'workflows_enabled';

-- 3) Seed das 3 variantes na campanha promo_maio_2026
UPDATE public.campaign_runs
SET message_variants = $$[
  "Oi, {nome}! Aqui é da equipe do Dr. Igor. Em maio, a consulta de avaliação está em R$ 600 (regular R$ 800), com taxa de R$ 180 integralmente abatida no valor da consulta — e quem agendar neste mês ganha 1 sessão de T Sculptor. Faz sentido a gente ver os horários?",
  "Olá {nome}, tudo bem? Aqui é da clínica Dr. Igor. Como você havia demonstrado interesse no acompanhamento, quis avisar que em maio o investimento ficou em R$ 600 (de R$ 800), com R$ 180 de taxa abatida e bônus de 1 sessão T Sculptor pra quem agendar agora. Posso verificar os horários disponíveis?",
  "Oi, {nome}! Passando uma condição especial do Dr. Igor disponível só em maio: avaliação por R$ 600 (preço regular R$ 800), taxa de R$ 180 já abatida e 1 sessão de T Sculptor de bônus para quem agendar este mês. Vale conversar?"
]$$::jsonb,
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';
