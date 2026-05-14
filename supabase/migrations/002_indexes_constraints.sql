-- Igor — 002_indexes_constraints.sql
-- Índices nomeados + CHECKs de enum.

CREATE INDEX IF NOT EXISTS idx_contacts_phone               ON public.contacts (phone);
CREATE INDEX IF NOT EXISTS idx_conversations_contact        ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_state          ON public.conversations (state);
CREATE INDEX IF NOT EXISTS idx_leads_contact                ON public.leads (contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_status                 ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_source                 ON public.leads (source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time   ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid               ON public.messages (msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_type_time             ON public.events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_conv                  ON public.events (chatwoot_conversation_id) WHERE chatwoot_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_campaign              ON public.events (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_lead             ON public.assignments (lead_id);

-- conversations.state
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_state_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_state_check CHECK (state IN (
    'new','after_hours_candidate','ai_after_hours','collecting_name','quick_qualification',
    'collecting_callback_time','handoff_pending','human_assigned','human_locked','closed',
    'opt_out','compliance_hold',
    'campaign_active','campaign_replied','campaign_interested','campaign_collecting_callback',
    'campaign_handoff_pending','campaign_handoff_done','campaign_opt_out'
  ));

-- leads.status
ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check CHECK (status IN (
    'novo','em_atendimento_ia_fora_expediente','qualificacao_rapida','callback_solicitado',
    'callback_horario_coletado','aguardando_atendente','humano_em_atendimento','agendado',
    'nao_interessado','opt_out'
  ));

-- messages enums
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_type_check CHECK (message_type IN ('text','audio','image','document','unknown'));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_direction_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_direction_check CHECK (direction IN ('inbound','outbound','internal'));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_role_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant','agent','system'));

-- events.event_type — só letras minúsculas e underscore (snake_case)
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_type_check CHECK (event_type ~ '^[a-z_]+$');
