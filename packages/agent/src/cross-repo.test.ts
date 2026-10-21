import { describe, expect, it } from 'vitest';
import { addPortedTo, buildSourceContext, MAX_SOURCE_CONTEXT_CHARS, portedToLine } from './cross-repo';
import { buildPrBody, type PrContext } from './pr-body';
import { buildTaskMessage, type TaskContext } from './prompts';

const source = { key: 'AD-1', title: 'Greet', url: 'https://app/o/acme/tasks/AD-1', repoFullName: 'acme/web', descriptionMd: 'Say hello.', summaryMd: 'greet() says hello.' };
const change = { diff: 'diff --git a/src/app.ts b/src/app.ts\n-hi\n+hello\n', from: 'pushed' as const };

describe('buildSourceContext', () => {
  it('names the source and its PR, says what it did, how the repos map, and fences the diff', () => {
    const md = buildSourceContext({ source, pr: { number: 3, url: 'https://github.com/acme/web/pull/3', state: 'merged' }, mappingNotesMd: 'src ↔ lib', change });
    expect(md).toContain('[AD-1: Greet](https://app/o/acme/tasks/AD-1) in `acme/web`, PR [#3](https://github.com/acme/web/pull/3) (merged)');
    expect(md).toContain('greet() says hello.');
    expect(md).toContain('src ↔ lib');
    expect(md).toContain('````diff\ndiff --git a/src/app.ts');
  });

  it('falls back to the description without a summary, notes missing mapping notes, and caps the size', () => {
    const md = buildSourceContext({ source: { ...source, summaryMd: null }, pr: null, mappingNotesMd: '', change: { diff: 'x'.repeat(200_000), from: 'workspace' } });
    expect(md).toContain('### The source task\nSay hello.');
    expect(md).toContain('No mapping notes');
    expect(md).toContain('not pushed yet');
    expect(md).toContain('diff truncated');
    expect(md.length).toBeLessThanOrEqual(MAX_SOURCE_CONTEXT_CHARS);
    expect(md.endsWith('````')).toBe(true);
  });
});

describe('addPortedTo', () => {
  const line = (n: number) => portedToLine({ key: `AD-${n}`, url: `https://app/t/${n}`, repoFullName: 'acme/mobile', prNumber: n, prUrl: `https://github.com/acme/mobile/pull/${n}` });
  it('adds one heading, keeps several ports under it, and never adds a line twice', () => {
    const once = addPortedTo('## Summary\nx', line(7));
    expect(once).toBe(`## Summary\nx\n\n## Ported to other repositories\n${line(7)}`);
    const twice = addPortedTo(once, line(8));
    expect(twice.match(/## Ported to/g)).toHaveLength(1);
    expect(twice).toContain(line(8));
    expect(addPortedTo(twice, line(8))).toBe(twice);
  });
});

describe('the port task in the prompt and the PR', () => {
  it('asks the agent to adapt the change, with it marked as data', () => {
    const t: TaskContext = { key: 'AD-2', title: 'Port AD-1: Greet', descriptionMd: '', acceptanceCriteriaMd: '', mode: 'direct', scopePath: null, branchMode: 'new', workBranch: 'autodev/AD-2', extraContext: null, related: null, source: { key: 'AD-1', repoFullName: 'acme/web', contextMd: 'THE CONTEXT' }, approvedPlan: null, approvedDesign: null };
    const text = JSON.stringify(buildTaskMessage('code', t));
    expect(text).toContain('## Port a change from acme/web (AD-1)');
    expect(text).toContain("don't copy it line for line");
    expect(text).toContain('<source_change>\\nTHE CONTEXT\\n</source_change>');
    expect(JSON.stringify(buildTaskMessage('code', { ...t, source: null }))).not.toContain('Port a change');
  });

  it('adds a Source section to the PR body only for ports', () => {
    const ctx: PrContext = {
      task: { key: 'AD-2', title: 'Port', url: 'https://app/t/2', summaryMd: 'Ported.', acceptanceCriteriaMd: '', mode: 'direct' },
      ownerLogin: 'dev',
      plan: null,
      lld: null,
      changes: [],
      testing: { status: 'skipped' },
      usage: { models: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    };
    expect(buildPrBody(ctx)).not.toContain('## Source');
    const body = buildPrBody({ ...ctx, source: { key: 'AD-1', title: 'Greet', url: 'https://app/t/1', repoFullName: 'acme/web', pr: { number: 3, url: 'https://github.com/acme/web/pull/3' } } });
    expect(body).toContain('## Source\nPorts [AD-1: Greet](https://app/t/1) from `acme/web` (https://github.com/acme/web/pull/3).');
    expect(body.indexOf('## Source')).toBeLessThan(body.indexOf('## Approved Plan'));
  });
});
