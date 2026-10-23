import { randomBytes } from 'node:crypto';
import { LocalMasterKeyWrapper } from '@autodev/crypto';
import { isNull, sql } from 'drizzle-orm';
import type { SystemDb } from '../src/client';
import { insertOrgWithOwner } from '../src/ops/orgs';
import { installations, modelPrices, repos, users } from '../src/schema';

export const testKms = new LocalMasterKeyWrapper(randomBytes(32).toString('base64'), 'test');

export async function truncateAll(db: SystemDb) {
  // TRUNCATE … CASCADE also empties model_prices (it references orgs), so keep the global seed.
  const globalPrices = await db.select().from(modelPrices).where(isNull(modelPrices.orgId));
  await db.execute(sql`
    TRUNCATE users, github_tokens, orgs, org_members, teams, team_members, installations,
      repos, user_repo_access, repo_policies, notifications, audit_log,
      llm_credentials, model_policies, budgets, token_usage, tasks, task_events,
      agent_runs, agent_steps, task_documents, task_questions, workspaces, workspace_files, blobs,
      builders, builder_repo_bindings, builder_jobs, pull_requests, code_chunks, code_index_state, repo_links, stripe_events CASCADE`);
  await db.execute(sql`TRUNCATE model_prices`);
  if (globalPrices.length) await db.insert(modelPrices).values(globalPrices);
}

let seq = 1000;

/** One org with an owner, an installation and one repo. */
export async function makeOrg(db: SystemDb, login: string) {
  const n = seq++;
  const [owner] = await db
    .insert(users)
    .values({ githubUserId: n, githubLogin: `${login}-owner` })
    .returning();
  const org = await insertOrgWithOwner(db, testKms, {
    githubAccountId: n,
    githubLogin: login,
    accountType: 'Organization',
    name: login,
    ownerUserId: owner!.id,
  });
  const [inst] = await db
    .insert(installations)
    .values({
      orgId: org.id,
      githubInstallationId: n,
      accountLogin: login,
      accountType: 'Organization',
    })
    .returning();
  const [repo] = await db
    .insert(repos)
    .values({
      orgId: org.id,
      installationId: inst!.id,
      githubRepoId: n,
      owner: login,
      name: 'web',
      fullName: `${login}/web`,
      defaultBranch: 'main',
      private: true,
    })
    .returning();
  return { org, owner: owner!, installation: inst!, repo: repo! };
}
