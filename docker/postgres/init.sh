#!/bin/bash
# Runs once on first container start. Creates the two login roles and the dev + test databases.
#   autodev_system: owns the schema and runs migrations. BYPASSRLS, so it is only used by
#                   migrations, webhook routing and cross-org cron jobs.
#   autodev_app:    used by every request path. Not the owner and no BYPASSRLS, so RLS always applies.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
  CREATE ROLE autodev_system LOGIN PASSWORD 'autodev_system' BYPASSRLS;
  CREATE ROLE autodev_app LOGIN PASSWORD 'autodev_app';
  CREATE DATABASE autodev OWNER autodev_system;
  CREATE DATABASE autodev_test OWNER autodev_system;
SQL

for db in autodev autodev_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-SQL
    CREATE EXTENSION IF NOT EXISTS vector;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO autodev_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autodev_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO autodev_app;
SQL
done
