-- Igor — 004_campaign_schema.sql
-- Campanha promocional ativa.

CREATE TABLE IF NOT EXISTS public.campaign_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  offer_name          text NOT NULL,
  regular_price       numeric(10,2),
  promo_price         numeric(10,2),
  booking_fee         numeric(10,2),
  booking_fee_note    text,
  bonuses             jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_template    text NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'ativo',
  media_url           text,
  media_type          text,
  media_caption       text,
  max_daily_sends     integer NOT NULL DEFAULT 20,
  send_window_start   text NOT NULL DEFAULT '09:00',
  send_window_end     text NOT NULL DEFAULT '17:30',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_runs_status_check     CHECK (status IN ('ativo','pausado','finalizado')),
  CONSTRAINT campaign_runs_media_type_check CHECK (media_type IS NULL OR media_type IN ('image','video','none'))
);

COMMENT ON COLUMN public.campaign_runs.booking_fee     IS 'Taxa de agendamento (R$ 180 na campanha atual)';
COMMENT ON COLUMN public.campaign_runs.bonuses         IS 'Lista de bônus, ex: [{"name":"T Sculptor","description":"01 sessão"}]';
COMMENT ON COLUMN public.campaign_runs.message_template IS 'Texto fixo aprovado; suporta {nome} opcional';

CREATE TABLE IF NOT EXISTS public.campaign_contacts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              uuid NOT NULL REFERENCES public.campaign_runs(id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  lead_id                  uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  phone                    text NOT NULL,
  status                   text NOT NULL DEFAULT 'queued',
  eligibility_reason       text,
  skip_reason              text,
  personalized_context     text,
  message_variant          text,
  sent_message             text,
  sent_at                  timestamptz,
  delivered_at             timestamptz,
  replied_at               timestamptz,
  interest_classification  text,
  callback_period          text,
  handoff_at               timestamptz,
  optout_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_contacts_status_check CHECK (status IN (
    'queued','skipped','scheduled','sent','delivered','replied',
    'interested','not_interested','handoff_pending','handoff_done',
    'converted','opt_out','send_failed','blocked'
  )),
  CONSTRAINT campaign_contacts_unique_per_run UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status  ON public.campaign_contacts (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_phone   ON public.campaign_contacts (phone);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_sent_at ON public.campaign_contacts (sent_at) WHERE sent_at IS NOT NULL;
