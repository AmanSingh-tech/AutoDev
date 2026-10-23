-- One-time setup for a managed Postgres 16 (Supabase, RDS, Crunchy Bridge, a VM…), run as the
-- provider's admin user against the database AutoDev will use:
--   psql "$ADMIN_DATABASE_URL" -v system_password='…' -v app_password='…' -f docker/postgres/init-hosted.sql
-- Then run migrations as autodev_system (docs/deploy-backend.md).
--
-- autodev_system owns the schema and runs migrations, webhooks and cron jobs. It needs BYPASSRLS:
-- some managed providers don't allow creating BYPASSRLS roles; check yours before choosing it.
-- autodev_app serves every request and is always subject to row-level security.

CREATE ROLE autodev_system LOGIN BYPASSRLS PASSWORD :'system_password';
CREATE ROLE autodev_app LOGIN PASSWORD :'app_password';
GRANT autodev_system TO CURRENT_USER;

CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO autodev_system;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO autodev_app;
ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autodev_app;
ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO autodev_app;
