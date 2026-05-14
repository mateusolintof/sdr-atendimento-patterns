-- Igor — 003_settings_seed.sql
-- Tabela settings + seed mínimo.
-- ON CONFLICT DO NOTHING permite reaplicar sem reset.

CREATE TABLE IF NOT EXISTS public.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.settings IS 'Configuração runtime do Igor — alterar aqui pausa/destrava workflows sem reimportar';

INSERT INTO public.settings (key, value) VALUES
  -- kill switch global
  ('ai_enabled_global',
   'true'::jsonb),

  -- granular por workflow (todos OFF até serem testados)
  ('workflows_enabled',
   '{
      "IGOR_01": false, "IGOR_02": false, "IGOR_03": false, "IGOR_04": false,
      "IGOR_05": false, "IGOR_06": false, "IGOR_07": true,  "IGOR_08": false,
      "IGOR_09": false, "IGOR_10": false, "IGOR_11": false, "IGOR_12": false,
      "IGOR_13": false
    }'::jsonb),

  -- janela receptiva (fora_expediente quando hora ∉ [end, start])
  ('after_hours_window',
   '{"start": "18:30", "end": "07:30", "timezone": "America/Sao_Paulo"}'::jsonb),

  -- feriados = comportamento idêntico a fora_expediente (ver IMPLEMENTATION_PLAN P1 #2)
  ('holidays',
   '[]'::jsonb),

  -- palavras-chave PT-BR para detecção determinística de opt-out
  ('do_not_contact_keywords',
   '["pare","parar","para","remova","remover","cancela","cancelar","sair","saia","nao quero","não quero","sem interesse","nao envia","não envia","stop","unsubscribe"]'::jsonb),

  -- threshold auto-pausa de campanha (3 opt-outs nas últimas 20 mensagens)
  ('campaign_optout_threshold',
   '{"window_size": 20, "max_optouts": 3}'::jsonb),

  -- IDs Chatwoot (a preencher quando inbox for criada na Fase 5)
  ('human_team_id',  '1'::jsonb),
  ('human_inbox_id', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;
