import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Schema = typeof schema;
type Database = PostgresJsDatabase<Schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Connection as `autodev_app`, so RLS applies. Use it only through withRls/withOrg/withUser:
 * outside those, the session settings are empty and every tenant table returns no rows.
 */
export type AppDb = Database & { readonly __role: 'app' };
/** Connection as `autodev_system` (BYPASSRLS). Every use must scope by org_id explicitly. */
export type SystemDb = Database & { readonly __role: 'system' };

export interface DbHandle<T> {
  db: T;
  close: () => Promise<void>;
}

function connect(url: string, max: number) {
  const client = postgres(url, { max, prepare: true, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export function createAppDb(url: string, max = 10): DbHandle<AppDb> {
  const { db, close } = connect(url, max);
  return { db: db as unknown as AppDb, close };
}

export function createSystemDb(url: string, max = 5): DbHandle<SystemDb> {
  const { db, close } = connect(url, max);
  return { db: db as unknown as SystemDb, close };
}

export interface RlsContext {
  orgId?: string | null;
  userId?: string | null;
}

/** Runs `fn` in a transaction with app.org_id / app.user_id set (SET LOCAL), which the RLS policies read. */
export function withRls<T>(db: AppDb, ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.orgId ?? ''}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

export const withOrg = <T>(db: AppDb, orgId: string, userId: string | null, fn: (tx: Tx) => Promise<T>) =>
  withRls(db, { orgId, userId }, fn);

/** For cross-org reads of the user's own memberships (e.g. the org switcher). */
export const withUser = <T>(db: AppDb, userId: string, fn: (tx: Tx) => Promise<T>) =>
  withRls(db, { userId }, fn);
