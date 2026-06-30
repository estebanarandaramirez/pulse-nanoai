-- ============================================================
-- Pulse: Daily Earnings Log
-- Run this in: Supabase dashboard → SQL Editor
-- ============================================================

-- 1. Create the earnings_log table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.earnings_log (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  date        date        NOT NULL,
  user_email  text        NOT NULL,
  octa_usd    numeric(10, 4) DEFAULT 0,
  clore_usd   numeric(10, 4) DEFAULT 0,
  total_usd   numeric(10, 4) DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (date, user_email)
);

-- Keep updated_at fresh on every upsert
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS earnings_log_updated_at ON public.earnings_log;
CREATE TRIGGER earnings_log_updated_at
  BEFORE UPDATE ON public.earnings_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Row-level security (read-own-rows, service role bypasses RLS)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.earnings_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own earnings" ON public.earnings_log;
CREATE POLICY "users read own earnings"
  ON public.earnings_log FOR SELECT
  USING (user_email = auth.jwt() ->> 'email');

-- 3. Enable pg_cron and pg_net extensions
-- ─────────────────────────────────────────────────────────────
-- NOTE: pg_cron and pg_net must be enabled first in:
--   Supabase Dashboard → Database → Extensions
-- Then run the lines below.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 4. Schedule the Edge Function to run daily at 1:17 AM UTC
-- ─────────────────────────────────────────────────────────────
-- Replace YOUR_PROJECT_REF and YOUR_ANON_KEY below before running.
-- Find them in: Supabase Dashboard → Settings → API

SELECT cron.schedule(
  'pulse-snapshot-daily-earnings',   -- job name (unique)
  '17 1 * * *',                      -- 1:17 AM UTC every day
  $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/snapshot-daily-earnings',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb,
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- To check scheduled jobs:
--   SELECT * FROM cron.job;
-- To check recent runs:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
-- To remove the job if needed:
--   SELECT cron.unschedule('pulse-snapshot-daily-earnings');

-- 5. Backfill seed data (run once)
-- ─────────────────────────────────────────────────────────────
-- Replace your-email@gmail.com with your actual email.

INSERT INTO public.earnings_log (date, user_email, octa_usd, clore_usd, total_usd)
VALUES
  ('2026-06-25', 'YOUR_EMAIL', 0,    0, 0   ),
  ('2026-06-26', 'YOUR_EMAIL', 0.95, 0, 0.95),
  ('2026-06-27', 'YOUR_EMAIL', 0.95, 0, 0.95),
  ('2026-06-28', 'YOUR_EMAIL', 0.95, 0, 0.95),
  ('2026-06-29', 'YOUR_EMAIL', 0.95, 0, 0.95),
  ('2026-06-30', 'YOUR_EMAIL', 0.95, 0, 0.95)
ON CONFLICT (date, user_email) DO UPDATE
  SET octa_usd = EXCLUDED.octa_usd,
      clore_usd = EXCLUDED.clore_usd,
      total_usd = EXCLUDED.total_usd;
