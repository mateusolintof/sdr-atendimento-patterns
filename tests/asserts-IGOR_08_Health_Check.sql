-- =============================================================================
-- asserts-IGOR_08_Health_Check.sql
-- =============================================================================
-- Run these queries against Supabase AFTER one manual execution of the
-- workflow `IGOR_08_Health_Check` (or after the cron has fired at least once)
-- to confirm the contract has been honored end-to-end.
--
-- All assertions return rows shaped as (assertion, ok, observed, expected).
-- An assertion is satisfied when ok = TRUE.
-- =============================================================================

-- A1: at least one health_check event was written in the last 15 minutes
WITH r AS (
  SELECT count(*) AS n
  FROM public.events
  WHERE event_type = 'health_check'
    AND created_at > now() - interval '15 minutes'
)
SELECT
  'A1_health_check_row_exists_last_15min' AS assertion,
  (r.n >= 1)                              AS ok,
  r.n::text                               AS observed,
  '>= 1'                                  AS expected
FROM r;


-- A2: latest health_check has overall_status in the valid enum
WITH latest AS (
  SELECT payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT
  'A2_overall_status_in_enum'                                       AS assertion,
  (latest.payload->>'overall_status') IN ('healthy','degraded','critical')
                                                                    AS ok,
  COALESCE(latest.payload->>'overall_status', '<missing>')          AS observed,
  'one of {healthy, degraded, critical}'                            AS expected
FROM latest;


-- A3: latest health_check carries exactly 5 service pings
WITH latest AS (
  SELECT payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT
  'A3_services_array_length_eq_5'                              AS assertion,
  (jsonb_array_length(latest.payload->'services') = 5)         AS ok,
  jsonb_array_length(latest.payload->'services')::text         AS observed,
  '5'                                                          AS expected
FROM latest;


-- A4: latest health_check has all mandatory top-level keys
WITH latest AS (
  SELECT payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
), keys_check AS (
  SELECT
    (latest.payload ? 'health_id')             AS has_health_id,
    (latest.payload ? 'started_at')            AS has_started_at,
    (latest.payload ? 'ended_at')              AS has_ended_at,
    (latest.payload ? 'services')              AS has_services,
    (latest.payload ? 'counts')                AS has_counts,
    (latest.payload ? 'race_count')            AS has_race_count,
    (latest.payload ? 'orphan_batches_count')  AS has_orphan_batches_count,
    (latest.payload ? 'threshold_breaches')    AS has_threshold_breaches,
    (latest.payload ? 'overall_status')        AS has_overall_status
  FROM latest
)
SELECT
  'A4_payload_has_all_required_keys' AS assertion,
  (has_health_id
   AND has_started_at
   AND has_ended_at
   AND has_services
   AND has_counts
   AND has_race_count
   AND has_orphan_batches_count
   AND has_threshold_breaches
   AND has_overall_status)           AS ok,
  jsonb_build_object(
    'health_id',            has_health_id,
    'started_at',           has_started_at,
    'ended_at',             has_ended_at,
    'services',             has_services,
    'counts',               has_counts,
    'race_count',           has_race_count,
    'orphan_batches_count', has_orphan_batches_count,
    'threshold_breaches',   has_threshold_breaches,
    'overall_status',       has_overall_status
  )::text                            AS observed,
  'all true'                         AS expected
FROM keys_check;


-- A5: every service entry has the required sub-keys
WITH latest AS (
  SELECT payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
), svc AS (
  SELECT
    jsonb_array_elements(latest.payload->'services') AS s
  FROM latest
), audit AS (
  SELECT
    bool_and(s ? 'service')    AS all_have_service,
    bool_and(s ? 'status')     AS all_have_status,
    bool_and(s ? 'latency_ms') AS all_have_latency,
    array_agg(s->>'service')   AS services_seen
  FROM svc
)
SELECT
  'A5_service_entries_shape'         AS assertion,
  (all_have_service
   AND all_have_status
   AND all_have_latency
   AND services_seen @> ARRAY['n8n','chatwoot','evolution','openai','supabase'])
                                     AS ok,
  jsonb_build_object(
    'all_have_service',  all_have_service,
    'all_have_status',   all_have_status,
    'all_have_latency',  all_have_latency,
    'services_seen',     services_seen
  )::text                            AS observed,
  '{service,status,latency_ms} on every entry + services_seen covers {n8n,chatwoot,evolution,openai,supabase}'
                                     AS expected
FROM audit;


-- A6: counts object has the six business counters
WITH latest AS (
  SELECT payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT
  'A6_counts_object_has_six_counters' AS assertion,
  (latest.payload->'counts' ? 'events_24h'
   AND latest.payload->'counts' ? 'infra_errors_24h'
   AND latest.payload->'counts' ? 'opt_outs_24h'
   AND latest.payload->'counts' ? 'messages_24h'
   AND latest.payload->'counts' ? 'leads_24h'
   AND latest.payload->'counts' ? 'campaign_24h') AS ok,
  (latest.payload->'counts')::text               AS observed,
  '{events_24h,infra_errors_24h,opt_outs_24h,messages_24h,leads_24h,campaign_24h}' AS expected
FROM latest;


-- A7: when overall_status='critical', a matching health_alert row exists
--    (skips assertion when overall_status != 'critical')
WITH latest AS (
  SELECT id, created_at, payload
  FROM public.events
  WHERE event_type = 'health_check'
  ORDER BY created_at DESC
  LIMIT 1
), alert_match AS (
  SELECT count(*) AS n
  FROM public.events e
  WHERE e.event_type = 'health_alert'
    AND e.created_at >= (SELECT created_at FROM latest) - interval '30 seconds'
    AND e.payload->>'health_id' = (SELECT payload->>'health_id' FROM latest)
)
SELECT
  'A7_critical_implies_health_alert' AS assertion,
  CASE
    WHEN (SELECT payload->>'overall_status' FROM latest) = 'critical'
      THEN (alert_match.n >= 1)
    ELSE TRUE
  END AS ok,
  jsonb_build_object(
    'latest_status', (SELECT payload->>'overall_status' FROM latest),
    'matching_alert_count', alert_match.n
  )::text AS observed,
  'IF latest.overall_status=critical THEN alert_count>=1 ELSE skip' AS expected
FROM alert_match;
