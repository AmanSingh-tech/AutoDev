import { and, eq, isNull, schema, withOrg, type OrgRole } from '@autodev/db';
import type { Topic } from '@autodev/protocol';
import type { Deps } from '../deps';

export class TopicDenied extends Error {
  override name = 'TopicDenied';
}

/**
 * Checks every topic before a stream opens. The caller must be an active member of the org, and:
 *   task:<id>  the task is in this org and the caller can see its repo
 *   repo:<id>  the repo is in this org and the caller can see it on GitHub (cached access row)
 *   user:<id>  is the caller
 *   org        any active member
 *   org:admin  owners and admins
 */
export async function authorizeTopics(
  deps: Pick<Deps, 'app'>,
  orgId: string,
  userId: string,
  topics: Topic[],
): Promise<{ role: OrgRole }> {
  return withOrg(deps.app, orgId, userId, async (tx) => {
    const [member] = await tx
      .select({ role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, orgId),
          eq(schema.orgMembers.userId, userId),
          eq(schema.orgMembers.status, 'active'),
        ),
      );
    if (!member) throw new TopicDenied('Not a member of this org');

    for (const topic of topics) {
      if (topic === 'org') continue;
      if (topic === 'org:admin') {
        if (member.role !== 'owner' && member.role !== 'admin')
          throw new TopicDenied('org:admin is for owners and admins');
        continue;
      }
      const [kind, id] = topic.split(':') as ['task' | 'repo' | 'user', string];
      if (kind === 'user') {
        if (id !== userId) throw new TopicDenied('user topics are only for that user');
        continue;
      }
      // A task is readable by whoever can read its repo.
      let repoId = id;
      if (kind === 'task') {
        const [task] = await tx
          .select({ repoId: schema.tasks.repoId })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, id), eq(schema.tasks.orgId, orgId)));
        if (!task) throw new TopicDenied(`No access to ${topic}`);
        repoId = task.repoId;
      }
      const [access] = await tx
        .select({ repoId: schema.repos.id })
        .from(schema.repos)
        .innerJoin(
          schema.userRepoAccess,
          and(
            eq(schema.userRepoAccess.repoId, schema.repos.id),
            eq(schema.userRepoAccess.userId, userId),
          ),
        )
        .where(
          and(
            eq(schema.repos.id, repoId),
            eq(schema.repos.orgId, orgId),
            isNull(schema.repos.deletedAt),
          ),
        );
      if (!access) throw new TopicDenied(`No access to ${topic}`);
    }
    return { role: member.role };
  });
}
