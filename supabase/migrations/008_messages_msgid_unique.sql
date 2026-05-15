-- =============================================================================
-- 008_messages_msgid_unique.sql
-- =============================================================================
-- Adiciona constraint UNIQUE parcial em public.messages(msg_id) para suportar
-- UPSERT determinístico keyed por msgId.
--
-- Workflows que dependem desta constraint:
--   - IGOR_02_Media_Normalizer (UPSERT do normalized_text/media_summary/safety_flags)
--   - IGOR_06_Chatwoot_Message_Logger (UPSERT do espelhamento de mensagens)
--
-- Idempotente — usa IF NOT EXISTS.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_msgid_partial
  ON public.messages (msg_id)
  WHERE msg_id IS NOT NULL;

COMMENT ON INDEX public.uq_messages_msgid_partial IS
  'Partial UNIQUE para suportar ON CONFLICT (msg_id) DO UPDATE em UPSERT. NULL msg_id continua permitindo múltiplas linhas (mensagens internas sem provider id).';
