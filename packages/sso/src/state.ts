import { and, eq, or, schema, sql, type OrgRole, type SystemDb } from '@autodev/db';
import type { WorkosProfile } from './workos';

const { auditLog, directoryUsers, orgMembers, orgSso, ssoIdentities, workosEvents } = schema;

export type SsoCheck = { required: false } | { required: true; ok: boolean; reason?: 'not_linked' | 'expired' | 'deactivated' };

/**
 * Whether a member needs a fresh SSO sign-in for this org (B-7). Only when the org requires SSO;
 * owners are exempt so a broken identity provider never locks the org out.
 */
export async function ssoCheck(sys: SystemDb, orgId: string, userId: string, role: OrgRole, now = new Date()): Promise<SsoCheck> {
  const [cfg] = await sys.select().from(orgSso).where(eq(orgSso.orgId, orgId));
  if (!cfg?.ssoRequired || role === 'owner') return { required: false };
  const [identity] = await sys.select().from(ssoIdentities).where(and(eq(ssoIdentities.orgId, orgId), eq(ssoIdentities.userId, userId)));
  if (!identity) return { required: true, ok: false, reason: 'not_linked' };
  const [dir] = await sys
    .select({ state: directoryUsers.state })
    .from(directoryUsers)
    .where(and(eq(directoryUsers.orgId, orgId), eq(directoryUsers.userId, userId)));
  if (dir && dir.state !== 'active') return { required: true, ok: false, reason: 'deactivated' };
  const fresh = identity.lastLoginAt.getTime() + cfg.sessionHours * 3_600_000 > now.getTime();
  return fresh ? { required: true, ok: true } : { required: true, ok: false, reason: 'expired' };
}

export class SsoLinkError extends Error {}

/**
 * Records an SSO sign-in for the signed-in GitHub user. The profile must come from this org's own
 * WorkOS organization, and an identity-provider account links to one AutoDev user only.
 */
export async function linkIdentity(sys: SystemDb, input: { orgId: string; userId: string; profile: WorkosProfile; ip?: string | null }, now = new Date()) {
  const [cfg] = await sys.select().from(orgSso).where(eq(orgSso.orgId, input.orgId));
  if (!cfg) throw new SsoLinkError('SSO isn’t set up for this organization');
  if (input.profile.organization_id !== cfg.workosOrganizationId) throw new SsoLinkError('That sign-in belongs to another organization’s identity provider');
  return sys.transaction(async (tx) => {
    const [other] = await tx
      .select({ userId: ssoIdentities.userId })
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.orgId, input.orgId), eq(ssoIdentities.profileId, input.profile.id)));
    if (other && other.userId !== input.userId) throw new SsoLinkError('This identity-provider account is already linked to another AutoDev user');
    const email = input.profile.email.toLowerCase();
    const values = { orgId: input.orgId, userId: input.userId, profileId: input.profile.id, idpId: input.profile.idp_id ?? null, email, lastLoginAt: now };
    const [existing] = await tx.select({ id: ssoIdentities.id }).from(ssoIdentities).where(and(eq(ssoIdentities.orgId, input.orgId), eq(ssoIdentities.userId, input.userId)));
    if (existing) await tx.update(ssoIdentities).set(values).where(eq(ssoIdentities.id, existing.id));
    else await tx.insert(ssoIdentities).values(values);
    // Match the directory entry (if the directory is synced) by the IdP's id, else by email.
    await tx
      .update(directoryUsers)
      .set({ userId: input.userId })
      .where(and(eq(directoryUsers.orgId, input.orgId), or(input.profile.idp_id ? eq(directoryUsers.idpId, input.profile.idp_id) : sql`false`, eq(sql`lower(${directoryUsers.email})`, email))));
    await tx.insert(auditLog).values({ orgId: input.orgId, actorType: 'user', actorUserId: input.userId, action: existing ? 'sso.signed_in' : 'sso.linked', metadata: { email }, ip: input.ip ?? null });
    return { linked: !existing };
  });
}

interface DirectoryUserData {
  id: string;
  directory_id: string;
  organization_id?: string | null;
  idp_id?: string | null;
  email?: string | null;
  emails?: { primary?: boolean; value: string }[];
  first_name?: string | null;
  last_name?: string | null;
  state?: string;
}

export interface WorkosEventDeps {
  sys: SystemDb;
  /** Called after someone is removed, e.g. to update billed seats. */
  onRemoved?: (orgId: string, userId: string) => Promise<unknown>;
}

/** Finds the org a directory event is about, by directory id or WorkOS organization id. */
async function orgFor(sys: SystemDb, d: { directory_id?: string; organization_id?: string | null }) {
  const [row] = await sys
    .select({ orgId: orgSso.orgId })
    .from(orgSso)
    .where(or(d.directory_id ? eq(orgSso.workosDirectoryId, d.directory_id) : sql`false`, d.organization_id ? eq(orgSso.workosOrganizationId, d.organization_id) : sql`false`));
  return row?.orgId ?? null;
}

/**
 * Applies a WorkOS Directory Sync event (SCIM). People deactivated or deleted in the directory lose
 * their AutoDev membership (owners are kept, and admins are told). Each event is applied once.
 */
export async function applyWorkosEvent(deps: WorkosEventDeps, event: { id: string; event: string; data: Record<string, unknown> }): Promise<string> {
  const { sys } = deps;
  const [seen] = await sys.select({ id: workosEvents.id }).from(workosEvents).where(eq(workosEvents.id, event.id));
  if (seen) return 'duplicate';
  const result = await handle(deps, event);
  await sys.insert(workosEvents).values({ id: event.id, type: event.event }).onConflictDoNothing();
  return result;
}

async function handle(deps: WorkosEventDeps, event: { event: string; data: Record<string, unknown> }): Promise<string> {
  const { sys } = deps;
  const d = event.data;
  if (event.event === 'dsync.activated' || event.event === 'dsync.deleted') {
    const orgId = await orgFor(sys, { organization_id: d.organization_id as string });
    if (!orgId) return 'unknown_org';
    await sys
      .update(orgSso)
      .set({ workosDirectoryId: event.event === 'dsync.activated' ? (d.id as string) : null, updatedAt: new Date() })
      .where(eq(orgSso.orgId, orgId));
    return event.event === 'dsync.activated' ? 'directory:connected' : 'directory:removed';
  }
  if (!event.event.startsWith('dsync.user.')) return 'ignored';

  const u = d as unknown as DirectoryUserData;
  const orgId = await orgFor(sys, u);
  if (!orgId) return 'unknown_org';
  const email = (u.email ?? u.emails?.find((e) => e.primary)?.value ?? u.emails?.[0]?.value ?? null)?.toLowerCase() ?? null;
  const state = event.event === 'dsync.user.deleted' ? 'deleted' : (u.state ?? 'active');
  // The AutoDev user it maps to: through their SSO identity (IdP id first, then email).
  const [identity] = await sys
    .select({ userId: ssoIdentities.userId })
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.orgId, orgId), or(u.idp_id ? eq(ssoIdentities.idpId, u.idp_id) : sql`false`, email ? eq(ssoIdentities.email, email) : sql`false`)));
  const values = {
    orgId,
    directoryUserId: u.id,
    idpId: u.idp_id ?? null,
    email,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
    state,
    userId: identity?.userId ?? null,
    raw: d,
    updatedAt: new Date(),
  };
  await sys.insert(directoryUsers).values(values).onConflictDoUpdate({ target: [directoryUsers.orgId, directoryUsers.directoryUserId], set: values });

  if (state === 'active' || !identity) return `directory_user:${state}`;
  const [member] = await sys
    .select({ role: orgMembers.role, status: orgMembers.status })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, identity.userId)));
  if (!member || member.status !== 'active') return `directory_user:${state}`;
  if (member.role === 'owner') {
    await sys.insert(auditLog).values({ orgId, actorType: 'system', action: 'member.deprovision_skipped', targetType: 'user', targetId: identity.userId, metadata: { reason: 'owner', directoryState: state } });
    return 'owner_kept';
  }
  await sys.transaction(async (tx) => {
    await tx.update(orgMembers).set({ status: 'removed' }).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, identity.userId)));
    await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.orgId, orgId), eq(schema.teamMembers.userId, identity.userId)));
    await tx.insert(auditLog).values({ orgId, actorType: 'system', action: 'member.deprovisioned', targetType: 'user', targetId: identity.userId, metadata: { directoryState: state, email } });
  });
  await deps.onRemoved?.(orgId, identity.userId).catch(() => null);
  return 'member_removed';
}
