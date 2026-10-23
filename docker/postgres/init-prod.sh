#!/bin/bash
# First-start setup for the Postgres in docker-compose.prod.yml. Same roles as development
# (docker/postgres/init.sh) but with passwords from the environment and only one database.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v system_password="$AUTODEV_SYSTEM_PASSWORD" -v app_password="$AUTODEV_APP_PASSWORD" <<-'SQL'
  CREATE ROLE autodev_system LOGIN BYPASSRLS PASSWORD :'system_password';
  CREATE ROLE autodev_app LOGIN PASSWORD :'app_password';
  CREATE DATABASE autodev OWNER autodev_system;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname autodev <<-SQL
  CREATE EXTENSION IF NOT EXISTS vector;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT ALL ON SCHEMA public TO autodev_system;
  GRANT USAGE ON SCHEMA public TO autodev_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autodev_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE autodev_system IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO autodev_app;
SQL
