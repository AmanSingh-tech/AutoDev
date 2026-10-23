import { sweepBlobs } from '@autodev/agent';
import { sql, type SystemDb } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';
import { StripeClient, syncAllSeats, type BillingConfig } from '@autodev/billing';
import type { KeyWrapper } from '@autodev/crypto';
import { purgeAll, pushAllAudit } from '@autodev/governance';
import { runInsights } from './insights';

/**
 * Housekeeping jobs on one queue, told apart by job name. Both are idempotent, so retries are safe.
 *  - partitions: keeps token_usage partitions for this month plus the next two.
 *  - blob-retention: applies each org's log and snapshot retention, then removes unreferenced blobs.
 *  - insights: B-4 rollups and leaderboards, nightly for every org, or for one org on an admin's Recompute.
 *  - seats: B-6, sets each Stripe subscription's quantity to the org's active members (when billing is on).
 *  - retention: B-7, purges chat, agent traces and notifications past each org's retention (before blob-retention).
 *  - siem: B-7, every few minutes, pushes new audit entries to each org's SIEM endpoint.
 */
export const createMaintenanceProcessor =
  (deps: {
    sys: SystemDb;
    blobs: BlobStore;
    billing?: BillingConfig;
    kms?: KeyWrapper;
    outboundAllowPrivate?: boolean;
  }) =>
  async (job: { name: string; data?: { orgId?: string } }) => {
    if (job.name === 'retention') return purgeAll(deps.sys);
    if (job.name === 'siem')
      return deps.kms
        ? pushAllAudit({
            sys: deps.sys,
            kms: deps.kms,
            outbound: { allowPrivate: deps.outboundAllowPrivate },
          })
        : { siem: 'no kms' };
    if (job.name === 'seats') {
      if (!deps.billing?.STRIPE_SECRET_KEY) return { seats: 'billing off' };
      return syncAllSeats({
        sys: deps.sys,
        stripe: new StripeClient({
          secretKey: deps.billing.STRIPE_SECRET_KEY,
          apiUrl: deps.billing.STRIPE_API_URL,
        }),
      });
    }
    if (job.name === 'blob-retention') return sweepBlobs(deps);
    if (job.name === 'insights') return runInsights(deps.sys, { orgId: job.data?.orgId });
    await deps.sys.execute(sql`select ensure_token_usage_partitions(2)`);
    return { partitions: 'ok' };
  };
