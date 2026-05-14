-- RPC usada apenas pelos asserts de teste. Restrita a service_role.
-- Permite ao orquestrador executar SELECT arbitrário e receber jsonb.

CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  FOR result IN EXECUTE format('SELECT to_jsonb(t) FROM (%s) t', query) LOOP
    RETURN NEXT result;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM anon;

COMMENT ON FUNCTION public.exec_sql IS 'Apenas para testes — SELECT arbitrário via service_role';
