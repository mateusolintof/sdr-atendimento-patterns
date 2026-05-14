-- Igor — 001_core_schema.sql
-- Aplicação manual no Supabase SQL Editor.
-- Idempotente: usa IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- contacts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone              text NOT NULL UNIQUE,
  name               text,
  email              text,
  consent_marketing  boolean NOT NULL DEFAULT false,
  do_not_contact     boolean NOT NULL DEFAULT false,
  optout_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.contacts                 IS 'Contato único; opt-out global vive aqui';
COMMENT ON COLUMN public.contacts.phone           IS 'Formato 55DDDNNNNNNNNN, sem símbolos';
COMMENT ON COLUMN public.contacts.do_not_contact  IS 'true = nenhuma IA responde nem envia campanha';

-- ============================================================
-- conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS public.conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  chatwoot_conversation_id integer NOT NULL UNIQUE,
  chatwoot_inbox_id        integer NOT NULL,
  state                    text NOT NULL DEFAULT 'new',
  ai_enabled               boolean NOT NULL DEFAULT true,
  human_locked             boolean NOT NULL DEFAULT false,
  current_flow             text,                  -- after_hours | campaign | null
  assigned_team_id         integer,
  assigned_agent_id        integer,
  last_message_at          timestamptz,
  last_ai_message_at       timestamptz,
  last_human_message_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.conversations IS 'Estado da conversa Chatwoot — ai_enabled/human_locked são os flags primários de bloqueio determinístico';

-- ============================================================
-- leads
-- ============================================================
CREATE TABLE IF NOT EXISTS public.leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id      uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  source               text,                       -- ex: 'kommo_2026-05-14', 'whatsapp', 'meta_ads'
  external_id          text,                       -- id no sistema externo (Kommo, Meta, etc)
  status               text NOT NULL DEFAULT 'novo',
  objective            text,
  city                 text,
  callback_preference  text,
  callback_period      text,
  kommo_data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  qualified_at         timestamptz,
  handoff_at           timestamptz,
  scheduled_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_source_external_unique UNIQUE (source, external_id)
);

COMMENT ON TABLE  public.leads             IS 'Aspecto comercial do contato; um contato pode ter múltiplos leads';
COMMENT ON COLUMN public.leads.kommo_data  IS 'Campos ricos do Kommo: motivo_nao_agendamento, capacidade_financeira, urgencia, etc.';

-- ============================================================
-- messages
-- ============================================================
CREATE TABLE IF NOT EXISTS public.messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  msg_id              text,                       -- Evolution msgId
  text                text,
  normalized_text     text,
  message_type        text NOT NULL,
  direction           text NOT NULL,              -- inbound|outbound|internal
  role                text NOT NULL,              -- user|assistant|agent|system
  from_me             boolean NOT NULL DEFAULT false,
  media_url           text,                       -- URL S3 (MinIO via Evolution)
  media_mime_type     text,
  media_summary       text,
  safety_flags        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.messages           IS 'Espelho normalizado das mensagens (texto + transcrição/descrição)';
COMMENT ON COLUMN public.messages.media_url IS 'URL do objeto no MinIO S3 conectado à Evolution; não copiamos para Storage';

-- ============================================================
-- events
-- ============================================================
CREATE TABLE IF NOT EXISTS public.events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type               text NOT NULL,
  phone                    text,
  chatwoot_conversation_id integer,
  campaign_id              uuid,
  campaign_contact_id      uuid,
  workflow_name            text,
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events IS 'Log universal — toda decisão importante grava aqui';

-- ============================================================
-- assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  agent_id     integer,
  team_id      integer,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.assignments IS 'Vínculo lead → atendente humana após handoff';

-- ============================================================
-- conversation_summaries
-- ============================================================
CREATE TABLE IF NOT EXISTS public.conversation_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  summary         text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.conversation_summaries IS 'Resumo curto da conversa (usado em private note no handoff)';
