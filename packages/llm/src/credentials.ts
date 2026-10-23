import { Envelope, last4, type KeyWrapper } from '@autodev/crypto';
import {
  and,
  eq,
  inArray,
  isNull,
  orgKeyContext,
  schema,
  withOrg,
  type AppDb,
  type CredentialScope,
  type SystemDb,
} from '@autodev/db';
import { uuidv7 } from 'uuidv7';
import { LlmError, type LlmErrorKind } from './errors';
import { notifyAdmins } from './notify';
import type { ProviderRegistry } from './registry';
import type { ProviderId } from './types';

const { auditLog, llmCredentials, orgs } = schema;

export const credentialAad = (id: string) => `llm_credentials:${id}`;

/** Metadata safe to return to the browser. Never the secret, never the ciphertext. */
export const credentialMetaColumns = {
  id: llmCredentials.id,
  scope: llmCredentials.scope,
  teamId: llmCredentials.teamId,
  userId: llmCredentials.userId,
  provider: llmCredentials.provider,
  label: llmCredentials.label,
  last4: llmCredentials.last4,
  status: llmCredentials.status,
  lastValidatedAt: llmCredentials.lastValidatedAt,
  lastError: llmCredentials.lastError,
  /** Non-secret settings (Azure resource, AWS region). */
  config: llmCredentials.config,
  createdBy: llmCredentials.createdBy,
  createdAt: llmCredentials.createdAt,
};

export class KeyRejected extends Error {
  override name = 'KeyRejected';
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface NewCredential {
  orgId: string;
  actorUserId: string;
  scope: CredentialScope;
  teamId?: string | null;
  userId?: string | null;
  provider: ProviderId;
  label: string;
  apiKey: string;
  config?: Record<string, string>;
  ip?: string | null;
  userAgent?: string | null;
}

export class CredentialService {
  constructor(
    private readonly deps: { app: AppDb; sys: SystemDb; kms: KeyWrapper; providers: ProviderRegistry },
  ) {}

  /**
   * Validates the key with a tiny provider call, then stores it encrypted. If the slot already has an
   * active key it's superseded in the same transaction, so there's no window without a key.
   * Calls already running keep using the old key they decrypted.
   */
  async create(input: NewCredential) {
    const apiKey = input.apiKey.trim();
    const config = input.config ?? {};
    const check = await this.deps.providers.get(input.provider).validateKey({ apiKey, config });
    if (!check.ok) throw new KeyRejected(check.kind, describeRejection(check.kind));

    const id = uuidv7();
    return withOrg(this.deps.app, input.orgId, input.actorUserId, async (tx) => {
      const [org] = await tx
        .select({ dataKeyWrapped: orgs.dataKeyWrapped, dataKeyVersion: orgs.dataKeyVersion })
        .from(orgs)
        .where(eq(orgs.id, input.orgId));
      if (!org) throw new Error('org not found');
      const env = new Envelope(this.deps.kms, org.dataKeyWrapped, orgKeyContext(input.orgId));
      const secretEnc = await env.encrypt(apiKey, credentialAad(id));

      const target = slotFilter(input);
      const superseded = await tx
        .update(llmCredentials)
        .set({ status: 'superseded' })
        .where(and(eq(llmCredentials.orgId, input.orgId), eq(llmCredentials.status, 'active'), ...target))
        .returning({ id: llmCredentials.id });

      const [row] = await tx
        .insert(llmCredentials)
        .values({
          id,
          orgId: input.orgId,
          scope: input.scope,
          teamId: input.scope === 'team' ? input.teamId! : null,
          userId: input.scope === 'user' ? input.userId! : null,
          provider: input.provider,
          label: input.label,
          secretEnc,
          dataKeyVersion: org.dataKeyVersion,
          last4: last4(apiKey),
          config,
          status: 'active',
          lastValidatedAt: new Date(),
          createdBy: input.actorUserId,
          rotatedFromId: superseded[0]?.id ?? null,
        })
        .returning(credentialMetaColumns);

      await tx.insert(auditLog).values({
        orgId: input.orgId,
        actorType: 'user',
        actorUserId: input.actorUserId,
        action: superseded.length ? 'llm_key.rotated' : 'llm_key.created',
        targetType: 'llm_credential',
        targetId: id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: { scope: input.scope, provider: input.provider, last4: row!.last4, replaced: superseded[0]?.id ?? null },
      });
      return row!;
    });
  }

  async revoke(orgId: string, actorUserId: string, credentialId: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
    return withOrg(this.deps.app, orgId, actorUserId, async (tx) => {
      const [row] = await tx
        .update(llmCredentials)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(llmCredentials.orgId, orgId),
            eq(llmCredentials.id, credentialId),
            inArray(llmCredentials.status, ['active', 'invalid']),
          ),
        )
        .returning(credentialMetaColumns);
      if (!row) return null;
      await tx.insert(auditLog).values({
        orgId,
        actorType: 'user',
        actorUserId,
        action: 'llm_key.revoked',
        targetType: 'llm_credential',
        targetId: credentialId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { scope: row.scope, last4: row.last4 },
      });
      return row;
    });
  }

  /** Decrypts a key for one call, inside the system role. The plaintext buffer is zeroed after. */
  async withSecret<T>(credentialId: string, fn: (apiKey: string, config: Record<string, string>) => Promise<T>): Promise<T> {
    const [row] = await this.deps.sys
      .select({
        orgId: llmCredentials.orgId,
        secretEnc: llmCredentials.secretEnc,
        config: llmCredentials.config,
        dataKeyWrapped: orgs.dataKeyWrapped,
      })
      .from(llmCredentials)
      .innerJoin(orgs, eq(orgs.id, llmCredentials.orgId))
      .where(eq(llmCredentials.id, credentialId));
    if (!row) throw new Error('credential not found');
    const env = new Envelope(this.deps.kms, row.dataKeyWrapped, orgKeyContext(row.orgId));
    return env.useSecret(row.secretEnc, credentialAad(credentialId), (key) => fn(key, row.config));
  }

  /** Marks a key invalid after a key failure and tells admins, but only once per transition. */
  async markInvalid(credentialId: string, error: LlmError) {
    const [row] = await this.deps.sys
      .update(llmCredentials)
      .set({ status: 'invalid', lastError: error.message })
      .where(and(eq(llmCredentials.id, credentialId), eq(llmCredentials.status, 'active')))
      .returning({ orgId: llmCredentials.orgId, scope: llmCredentials.scope, last4: llmCredentials.last4, userId: llmCredentials.userId, label: llmCredentials.label });
    if (!row) return;
    await this.deps.sys.insert(auditLog).values({
      orgId: row.orgId,
      actorType: 'system',
      action: 'llm_key.invalidated',
      targetType: 'llm_credential',
      targetId: credentialId,
      metadata: { kind: error.kind, last4: row.last4 },
    });
    await notifyAdmins(
      this.deps.sys,
      row.orgId,
      {
        type: 'llm_key.invalid',
        title: `LLM key "${row.label}" (…${row.last4}) stopped working`,
        body: `${describeRejection(error.kind)} Tasks using it are paused until a working key is added.`,
        link: '/settings/ai-keys',
        payload: { credentialId, kind: error.kind },
      },
      row.userId ? [row.userId] : [],
    );
  }

  /**
   * Daily job: re-checks active and invalid keys. A key that fails auth becomes invalid. A key that
   * works again goes back to active if its slot is free. Network trouble leaves the status alone.
   */
  async revalidateAll(): Promise<{ checked: number; invalidated: number; restored: number }> {
    const rows = await this.deps.sys
      .select({
        id: llmCredentials.id,
        orgId: llmCredentials.orgId,
        status: llmCredentials.status,
        provider: llmCredentials.provider,
        scope: llmCredentials.scope,
        teamId: llmCredentials.teamId,
        userId: llmCredentials.userId,
      })
      .from(llmCredentials)
      .where(inArray(llmCredentials.status, ['active', 'invalid']));
    let invalidated = 0;
    let restored = 0;
    for (const c of rows) {
      const check = await this.withSecret(c.id, (apiKey, config) =>
        this.deps.providers.get(c.provider).validateKey({ apiKey, config }),
      );
      if (check.ok) {
        if (c.status === 'invalid') {
          const free = await this.deps.sys
            .select({ id: llmCredentials.id })
            .from(llmCredentials)
            .where(and(eq(llmCredentials.orgId, c.orgId), eq(llmCredentials.status, 'active'), ...slotFilter(c)));
          if (!free.length) {
            await this.deps.sys
              .update(llmCredentials)
              .set({ status: 'active', lastError: null, lastValidatedAt: new Date() })
              .where(eq(llmCredentials.id, c.id));
            restored++;
            continue;
          }
        }
        await this.deps.sys
          .update(llmCredentials)
          .set({ lastValidatedAt: new Date(), lastError: null })
          .where(eq(llmCredentials.id, c.id));
      } else if (['auth', 'permission', 'billing'].includes(check.kind)) {
        if (c.status === 'active') {
          await this.markInvalid(c.id, new LlmError(check.kind, check.message));
          invalidated++;
        }
      } else {
        await this.deps.sys.update(llmCredentials).set({ lastError: check.message }).where(eq(llmCredentials.id, c.id));
      }
    }
    return { checked: rows.length, invalidated, restored };
  }
}

function slotFilter(t: { scope: CredentialScope; provider: ProviderId; teamId?: string | null; userId?: string | null }) {
  return [
    eq(llmCredentials.provider, t.provider),
    eq(llmCredentials.scope, t.scope),
    t.scope === 'team' ? eq(llmCredentials.teamId, t.teamId!) : isNull(llmCredentials.teamId),
    t.scope === 'user' ? eq(llmCredentials.userId, t.userId!) : isNull(llmCredentials.userId),
  ];
}

export function describeRejection(kind: LlmErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'The provider rejected this key.';
    case 'permission':
      return "This key isn't allowed to use the API (check workspace or model permissions).";
    case 'billing':
      return 'The provider account has a billing problem (out of credit?).';
    case 'rate_limit':
    case 'overloaded':
    case 'server':
    case 'connection':
      return "We couldn't reach the provider to check this key. Try again in a minute.";
    default:
      return 'The provider returned an unexpected error for this key.';
  }
}
