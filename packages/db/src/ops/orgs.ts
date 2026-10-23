import { createWrappedDataKey, type KeyWrapper } from '@autodev/crypto';
import { uuidv7 } from 'uuidv7';
import type { SystemDb, Tx } from '../client';
import { orgMembers, orgs } from '../schema';

export interface NewOrgInput {
  githubAccountId: number;
  githubLogin: string;
  accountType: 'Organization' | 'User';
  name: string;
  ownerUserId: string;
  /** The deployment's DATA_REGION (B-7). */
  dataRegion?: string;
}

/** Context the org data key is wrapped under. Must match wherever the key is unwrapped. */
export const orgKeyContext = (orgId: string) => `org:${orgId}`;

/** Creates an org with a fresh wrapped data key and its first owner. System role only. */
export async function insertOrgWithOwner(
  db: SystemDb | Tx,
  kms: KeyWrapper,
  input: NewOrgInput,
): Promise<typeof orgs.$inferSelect> {
  const orgId = uuidv7();
  const { wrapped, kmsKeyId } = await createWrappedDataKey(kms, orgKeyContext(orgId));
  const [org] = await db
    .insert(orgs)
    .values({
      id: orgId,
      githubAccountId: input.githubAccountId,
      githubLogin: input.githubLogin,
      accountType: input.accountType,
      name: input.name,
      slug: input.githubLogin.toLowerCase(),
      dataKeyWrapped: wrapped,
      kmsKeyId,
      ...(input.dataRegion ? { dataRegion: input.dataRegion } : {}),
    })
    .returning();
  await db.insert(orgMembers).values({ orgId, userId: input.ownerUserId, role: 'owner' });
  return org!;
}
