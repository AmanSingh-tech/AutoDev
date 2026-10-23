import { steps, type AutodevConfig } from '@autodev/protocol';

export interface PrContext {
  task: { key: string; title: string; url: string; summaryMd: string | null; acceptanceCriteriaMd: string; mode: 'plan_lld' | 'plan_only' | 'direct' };
  ownerLogin: string;
  /** Cross-repo sync (B-3): the task in a linked repo this PR ports. */
  source?: { key: string; title: string; url: string; repoFullName: string; pr: { number: number; url: string } | null } | null;
  plan: { version: number; contentMd: string; reviewerLogin: string | null } | null;
  lld: { version: number; contentMd: string; reviewerLogin: string | null } | null;
  changes: { path: string; op: 'create' | 'modify' | 'delete'; note: string | null }[];
  testing:
    | { status: 'passed'; builderName: string | null; docker: boolean; image: string | null; config: AutodevConfig; durationMs: number | null }
    | { status: 'skipped' };
  usage: { models: string[]; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  /** A Group Agent fix (B-5): opened by the GitHub App bot, not a person. */
  groupAgent?: { recommendationUrl: string } | null;
}

const MAX_DOC_CHARS = 15_000;
const MAX_BODY_CHARS = 60_000; // GitHub's limit is 65,536

const OP = { create: 'added', modify: 'modified', delete: 'deleted' } as const;
const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString('en-US'));

function doc(label: string, d: PrContext['plan']) {
  if (!d) return null;
  const text = d.contentMd.length > MAX_DOC_CHARS ? `${d.contentMd.slice(0, MAX_DOC_CHARS)}\n\n_[truncated; the full version is on the task page]_` : d.contentMd;
  return `<details>\n<summary>${label} v${d.version}${d.reviewerLogin ? `, approved by @${d.reviewerLogin}` : ''}</summary>\n\n${text}\n\n</details>`;
}

function changesSection(c: PrContext['changes']) {
  return c.length ? c.map((x) => `- \`${x.path}\` (${OP[x.op]})${x.note ? `: ${x.note}` : ''}`).join('\n') : '_No file changes._';
}

function testingSection(t: PrContext['testing']) {
  if (t.status === 'skipped') return '⚠️ Not run: the base branch has no `.autodev.yml`.';
  const cmds = steps(t.config).flatMap((s) => s.commands.map((c) => `$ ${c}`)).join('\n');
  const where = `${t.builderName ? `**${t.builderName}**` : 'a local builder'} (${t.docker ? `Docker, \`${t.image}\`` : 'no Docker'})`;
  return `✅ Passed on ${where}${t.durationMs ? ` in ${Math.round(t.durationMs / 1000)}s` : ''}.\n\n\`\`\`console\n${cmds}\n\`\`\``;
}

function usageSection(ctx: PrContext) {
  const u = ctx.usage;
  const approvals =
    ctx.task.mode === 'direct'
      ? 'direct mode (no approval steps)'
      : [ctx.plan?.reviewerLogin && `plan approved by @${ctx.plan.reviewerLogin}`, ctx.lld?.reviewerLogin && `LLD approved by @${ctx.lld.reviewerLogin}`].filter(Boolean).join(', ') || 'no approvals recorded';
  return `${u.models.join(', ') || 'unknown model'} · ${k(u.inputTokens)} input / ${k(u.outputTokens)} output tokens${u.cacheReadTokens ? ` (+${k(u.cacheReadTokens)} cached)` : ''} · $${u.costUsd.toFixed(2)} · ${approvals}`;
}

/** The PR description, with the spec's sections. */
export function buildPrBody(ctx: PrContext): string {
  const sections = [
    `## Summary\n${ctx.task.summaryMd ?? '_No summary._'}`,
    `## Task\n[${ctx.task.key}: ${ctx.task.title}](${ctx.task.url})\n\n**Acceptance criteria**\n${ctx.task.acceptanceCriteriaMd.trim() || '_None given._'}`,
    ctx.source &&
      `## Source\nPorts [${ctx.source.key}: ${ctx.source.title}](${ctx.source.url}) from \`${ctx.source.repoFullName}\`${ctx.source.pr ? ` (${ctx.source.pr.url})` : ''}.`,
    `## Approved Plan\n${doc('Plan', ctx.plan) ?? '_No plan step for this task._'}`,
    `## Approved LLD\n${doc('Low-level design', ctx.lld) ?? '_No design step for this task._'}`,
    `## Changes\n${changesSection(ctx.changes)}`,
    `## Testing\n${testingSection(ctx.testing)}`,
    `## AI usage\n${usageSection(ctx)}`,
    ctx.groupAgent
      ? `<sub>Opened by the [AutoDev Group Agent](${ctx.groupAgent.recommendationUrl}) as the GitHub App bot. Tests ran on @${ctx.ownerLogin}'s builder. Merging is up to a person.</sub>`
      : `<sub>Opened by [AutoDev](${ctx.task.url}) on behalf of @${ctx.ownerLogin}. Every commit in this PR was pushed with their GitHub account.</sub>`,
  ];
  return sections.filter(Boolean).join('\n\n').slice(0, MAX_BODY_CHARS);
}

/** What gets appended when new commits land on a branch whose PR is already open. */
export function buildUpdateSection(ctx: PrContext, at: Date): string {
  return [
    `---`,
    `## AutoDev update · [${ctx.task.key}](${ctx.task.url}) · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `### Summary\n${ctx.task.summaryMd ?? '_No summary._'}`,
    ctx.plan || ctx.lld ? [doc('Plan', ctx.plan), doc('Low-level design', ctx.lld)].filter(Boolean).join('\n\n') : null,
    `### Changes\n${changesSection(ctx.changes)}`,
    `### Testing\n${testingSection(ctx.testing)}`,
    `### AI usage\n${usageSection(ctx)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function appendToBody(existing: string, section: string): string {
  const out = `${existing.trimEnd()}\n\n${section}`;
  if (out.length <= MAX_BODY_CHARS) return out;
  // Keep the newest information: drop the oldest update sections first.
  return `${existing.slice(0, Math.max(0, MAX_BODY_CHARS - section.length - 200))}\n\n_[earlier updates trimmed]_\n\n${section}`.slice(0, MAX_BODY_CHARS);
}
