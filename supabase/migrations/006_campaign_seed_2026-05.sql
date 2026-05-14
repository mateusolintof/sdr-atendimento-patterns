-- Igor — 006_campaign_seed_2026-05.sql
-- Insere a campanha promocional de maio/2026 com o template aprovado.
-- Aplicar APÓS 004_campaign_schema.sql.

INSERT INTO public.campaign_runs (
  id,
  name,
  offer_name,
  regular_price,
  promo_price,
  booking_fee,
  booking_fee_note,
  bonuses,
  message_template,
  starts_at,
  ends_at,
  status,
  media_type,
  max_daily_sends,
  send_window_start,
  send_window_end
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'promo_maio_2026',
  'Primeiro atendimento promocional — maio/2026',
  800.00,
  600.00,
  180.00,
  'integralmente abatida no valor da consulta',
  '[{"name": "T Sculptor", "description": "01 sessão de fortalecimento muscular e redução de gordura, não invasiva"}]'::jsonb,
  E'Olá 😊\n\nComo você demonstrou interesse em iniciar esse cuidado com o Dr. Igor, quis te avisar antecipadamente sobre uma condição especial disponível durante o mês de maio para novos pacientes.\n\nNeste período, o investimento da consulta está em R$ 600, com taxa de agendamento de R$ 180, integralmente abatida no valor da consulta.\n\nE tem mais um detalhe, os pacientes que realizarem o agendamento neste mês ganharão 01 sessão de T Sculptor.\n\nO T Sculptor é uma tecnologia voltada para fortalecimento muscular e auxílio na redução de gordura, ajudando na definição corporal, ganho de massa muscular e melhora do contorno corporal de forma não invasiva.\n\nComo a agenda permanece limitada, estou entrando em contato primeiro com os pacientes que já haviam demonstrado interesse no acompanhamento.\n\nSe fizer sentido para você neste momento, posso verificar os horários disponíveis.',
  '2026-05-01 00:00:00-03',
  '2026-05-31 23:59:59-03',
  'pausado',           -- nasce pausado; ativar manualmente após validar
  'none',
  20,                  -- Dia 1 conservador
  '09:00',
  '17:30'
)
ON CONFLICT (id) DO NOTHING;
