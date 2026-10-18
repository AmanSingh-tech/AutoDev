-- Phase A-2: RLS, column grants, token_usage partitions, global model prices.

ALTER TABLE "org_members" ADD CONSTRAINT "org_members_primary_team_fk"
  FOREIGN KEY ("primary_team_id") REFERENCES "teams"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Standard tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['llm_credentials', 'model_policies', 'budgets', 'token_usage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- llm_credentials: the app role can write the ciphertext but never read it back.
-- Only the system role (the LLM gateway in workers) can SELECT secret_enc.
REVOKE SELECT ON llm_credentials FROM autodev_app;
--> statement-breakpoint
GRANT SELECT (id, org_id, scope, team_id, user_id, provider, label, data_key_version, last4, config,
  status, last_validated_at, last_error, created_by, rotated_from_id, created_at, updated_at)
  ON llm_credentials TO autodev_app;
--> statement-breakpoint
REVOKE DELETE ON llm_credentials FROM autodev_app;
--> statement-breakpoint

-- model_prices: everyone reads the global defaults plus their org's overrides; writes only overrides.
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_prices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY prices_read ON model_prices FOR SELECT USING (org_id IS NULL OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY prices_write ON model_prices FOR INSERT WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY prices_close ON model_prices FOR UPDATE USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE DELETE ON model_prices FROM autodev_app;
--> statement-breakpoint

-- token_usage: written only by the gateway (system role); the app role can read its org's rows.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON token_usage FROM autodev_app;
--> statement-breakpoint

-- Monthly partitions. Creates the current month plus the next months_ahead months, idempotently.
-- Partitions are only reachable through the parent (where RLS applies), so the app role gets no
-- direct grant on them. Without this, ALTER DEFAULT PRIVILEGES would let it bypass RLS on a partition.
CREATE FUNCTION ensure_token_usage_partitions(months_ahead int DEFAULT 2) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  part text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := format('token_usage_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF token_usage FOR VALUES FROM (%L) TO (%L)',
        part, m::timestamp AT TIME ZONE 'UTC', (m + interval '1 month')::timestamp AT TIME ZONE 'UTC');
      EXECUTE format('REVOKE ALL ON %I FROM autodev_app', part);
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
--> statement-breakpoint
-- Safety net for rows outside the pre-created range (e.g. if the maintenance job stopped).
CREATE TABLE token_usage_default PARTITION OF token_usage DEFAULT;
--> statement-breakpoint
REVOKE ALL ON token_usage_default FROM autodev_app;
--> statement-breakpoint
SELECT ensure_token_usage_partitions(2);
--> statement-breakpoint

-- Global Anthropic prices, USD per million tokens (first-party API rates as of 2026-10).
-- Cache writes are 1.25x input (5-minute TTL) and 2x input (1-hour TTL).
-- Admins override per org in the UI. Haiku 5.5's higher rate above 100K-token prompts isn't modeled.
INSERT INTO model_prices (id, org_id, provider, model, input_per_mtok, output_per_mtok,
  cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok) VALUES
  ('01a1503b-e9bb-7823-b6b1-f06be3e280d1', NULL, 'anthropic', 'claude-opus-5-5',   4.00, 20.00,  5.00,  8.00, 0.20),
  ('01a1503b-e9c6-74fb-83ea-6ed21626b643', NULL, 'anthropic', 'claude-sonnet-5-5', 2.00, 10.00,  2.50,  4.00, 0.20),
  ('01a1503b-e9c6-74fb-83ea-6ed36625f1e0', NULL, 'anthropic', 'claude-haiku-5-5',  0.10,  0.50,  0.125, 0.20, 0.01),
  ('01a1503b-e9c6-74fb-83ea-6ed40edc80b6', NULL, 'anthropic', 'claude-fable-5-1', 10.00, 50.00, 12.50, 20.00, 0.25),
  ('01a1503b-e9c6-74fb-83ea-6ed50a31f5af', NULL, 'anthropic', 'claude-opus-5',     5.00, 25.00,  6.25, 10.00, 0.50),
  ('01a1503b-e9c7-7eda-9b55-a522293951e2', NULL, 'anthropic', 'claude-sonnet-5',   2.00, 10.00,  2.50,  4.00, 0.20);
