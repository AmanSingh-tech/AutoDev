import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { users } from './identity';
import { orgs } from './orgs';

/**
 * An org's single sign-on and directory sync through WorkOS (B-7). GitHub stays the sign-in (the
 * agent acts as the user on GitHub); SSO is a second check per org. Owners are exempt from
 * "SSO required", so a broken identity provider can't lock everyone out.
 */
export const orgSso = pgTable(
  'org_sso',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workosOrganizationId: text('workos_organization_id').notNull().unique(),
    /** Set from WorkOS's directory events once the admin connects a directory (SCIM). */
    workosDirectoryId: text('workos_directory_id'),
    ssoRequired: boolean('sso_required').notNull().default(false),
    /** How long an SSO sign-in counts before members must sign in again. */
    sessionHours: integer('session_hours').notNull().default(24),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('org_sso_session_hours_range', sql`${t.sessionHours} between 1 and 720`)],
);

/** A member's identity-provider account, linked the first time they sign in with SSO. */
export const ssoIdentities = pgTable(
  'sso_identities',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** WorkOS profile id (stable per identity-provider user and connection). */
    profileId: text('profile_id').notNull(),
    /** The identity provider's own user id, which directory sync also reports. */
    idpId: text('idp_id'),
    email: text('email').notNull(),
    lastLoginAt: tsz('last_login_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('sso_identities_org_user_uq').on(t.orgId, t.userId), unique('sso_identities_org_profile_uq').on(t.orgId, t.profileId), index('sso_identities_email_idx').on(t.orgId, t.email)],
);

/** People in the org's company directory, as WorkOS Directory Sync reports them. */
export const directoryUsers = pgTable(
  'directory_users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    directoryUserId: text('directory_user_id').notNull(),
    idpId: text('idp_id'),
    email: text('email'),
    name: text('name'),
    state: text('state').notNull(),
    /** The AutoDev user it was matched to (through their SSO identity), if any. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [unique('directory_users_org_dir_uq').on(t.orgId, t.directoryUserId), index('directory_users_email_idx').on(t.orgId, t.email)],
);

/** WorkOS webhook events already handled. */
export const workosEvents = pgTable('workos_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: createdAt(),
});
