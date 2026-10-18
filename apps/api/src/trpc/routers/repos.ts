import { and, eq, isNull, schema } from '@autodev/db';
import { installUrl } from '@autodev/github';
import { authedProcedure, orgProcedure, router } from '../trpc';

const { installations } = schema;

export const reposRouter = router({
  /** Only repos where the caller has push, maintain or admin on GitHub (15-minute cache). */
  list: orgProcedure.query(({ ctx }) => ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId)),

  refresh: orgProcedure.mutation(({ ctx }) =>
    ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId, { force: true }),
  ),
});

export const installationsRouter = router({
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg((tx) =>
      tx
        .select({
          id: installations.id,
          githubInstallationId: installations.githubInstallationId,
          accountLogin: installations.accountLogin,
          suspendedAt: installations.suspendedAt,
          createdAt: installations.createdAt,
        })
        .from(installations)
        .where(and(eq(installations.orgId, ctx.orgId), isNull(installations.deletedAt))),
    ),
  ),
});

export const githubRouter = router({
  /** Where to send someone who wants to install the App on a GitHub org (works before they have one). */
  installUrl: authedProcedure.query(({ ctx }) => ({ url: installUrl(ctx.deps.cfg) })),
});
