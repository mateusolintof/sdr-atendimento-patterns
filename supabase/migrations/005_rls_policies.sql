-- Igor — 005_rls_policies.sql
-- RLS ligado em todas as tabelas. service_role do n8n bypassa RLS automaticamente.
-- NÃO usar FORCE ROW LEVEL SECURITY (manteria service_role bloqueado).
-- authenticated tem leitura (para painel humano futuro). Escrita só via service_role.

ALTER TABLE public.contacts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_contacts       ENABLE ROW LEVEL SECURITY;

-- Policy de leitura para authenticated
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'contacts','conversations','leads','messages','events','assignments',
      'conversation_summaries','settings','campaign_runs','campaign_contacts'
    ])
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I_authenticated_read ON public.%I;',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY %I_authenticated_read ON public.%I FOR SELECT TO authenticated USING (true);',
      t, t
    );
  END LOOP;
END$$;
