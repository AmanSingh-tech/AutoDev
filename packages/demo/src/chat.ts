import { and, eq, schema, type SystemDb } from '@autodev/db';
import { demoFiles } from './content';

const { channelMessages, chatMessages, chatSessions, repoChannels, repos } = schema;

/** A short, believable answer for a demo repo, built from its sample files. No model is called. */
export function demoAnswer(question: string, repoName: string): string {
  const files = demoFiles({ key: 'DEMO', title: question.slice(0, 60), descriptionMd: '', repoName });
  const entry = files.find((f) => f.op === 'modify')!.path;
  const q = question.toLowerCase();
  const lines: string[] = [];
  if (/test|spec|coverage/.test(q)) {
    lines.push(`Tests in \`acme/${repoName}\` sit next to the code they cover (\`*.test.ts${/web|app|mobile/.test(repoName) ? 'x' : ''}\`) and run with Vitest: \`npm test\` on the builder.`);
    lines.push('A new module gets its own test file covering the normal case, edge cases and one error case; the shared helpers keep setup to a line or two.');
  } else if (/where|which file|find|located/.test(q)) {
    lines.push(`Start at \`${entry}\`: it wires every route and component together, so whatever you're looking for is registered there and points to its module.`);
    lines.push(`Feature code lives under \`${files[0]!.path.split('/').slice(0, 2).join('/')}\`, one file per feature.`);
  } else {
    lines.push(`In \`acme/${repoName}\`, requests enter through \`${entry}\`, which hands each one to a small module that returns a typed result instead of throwing.`);
    lines.push('Errors are mapped to HTTP status codes in one place, so a new case is usually one branch in the module plus a test.');
  }
  lines.push('', '_Demo answer. In a real organization this comes from your repository’s code index and your AI model, with links to the exact lines._');
  return lines.join('\n\n');
}

/** Answers a pending private-chat message in a demo org. */
export async function answerDemoChat(sys: SystemDb, orgId: string, messageId: string) {
  const [reply] = await sys.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.orgId, orgId)));
  if (!reply || reply.role !== 'assistant' || reply.status !== 'pending' || !reply.replyToId) return;
  const [question] = await sys.select().from(chatMessages).where(eq(chatMessages.id, reply.replyToId));
  const [repo] = await sys.select({ name: repos.name }).from(chatSessions).innerJoin(repos, eq(repos.id, chatSessions.repoId)).where(eq(chatSessions.id, reply.sessionId));
  await new Promise((r) => setTimeout(r, 1200));
  await sys
    .update(chatMessages)
    .set({ status: 'done', content: demoAnswer(question?.content ?? '', repo?.name ?? 'app'), citations: [], completedAt: new Date() })
    .where(eq(chatMessages.id, reply.id));
  await sys.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, reply.sessionId));
}

/** Answers a pending Repo Agent mention in a demo org's team room. */
export async function answerDemoRoom(sys: SystemDb, orgId: string, messageId: string) {
  const [reply] = await sys.select().from(channelMessages).where(and(eq(channelMessages.id, messageId), eq(channelMessages.orgId, orgId)));
  if (!reply || reply.status !== 'pending' || !reply.replyToId) return;
  const [mention] = await sys.select().from(channelMessages).where(eq(channelMessages.id, reply.replyToId));
  const [repo] = await sys.select({ name: repos.name }).from(repoChannels).innerJoin(repos, eq(repos.id, repoChannels.repoId)).where(eq(repoChannels.id, reply.channelId));
  await new Promise((r) => setTimeout(r, 1200));
  await sys
    .update(channelMessages)
    .set({ status: 'done', content: demoAnswer(mention?.content ?? '', repo?.name ?? 'app'), citations: [], completedAt: new Date() })
    .where(eq(channelMessages.id, reply.id));
}
