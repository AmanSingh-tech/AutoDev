import { describe, expect, it } from 'vitest';
import { PLAN, scripted, text, toolUse } from '../test/scripted';
import { mentionedPaths, missingSections } from './documents';
import { runLoop, type LoopDeps, type StepRecord } from './loop';
import { MemoryOverlayStore } from './overlay';
import { MemoryRepoReader } from './repo-reader';
import { toolDefs } from './tools';
import { VirtualWorkspace } from './workspace';

const files = { 'src/app.ts': 'export const greet = () => "hi";\n', 'src/other.ts': 'x\n' };

function deps(over: Partial<LoopDeps> & Pick<LoopDeps, 'call' | 'phase'>) {
  const steps: StepRecord[] = [];
  const persisted: number[] = [];
  const d: LoopDeps = {
    workspace: new VirtualWorkspace(new MemoryRepoReader(files), new MemoryOverlayStore(), { scope: '' }),
    allowedPaths: null,
    isCancelled: async () => false,
    onStep: async (s) => void steps.push(s),
    persist: async (s) => void persisted.push(s.transcript.length),
    ...over,
  };
  return { d, steps, persisted };
}
const start = [{ role: 'user' as const, content: [text('Task: greet properly')] }];

describe('runLoop', () => {
  it('explores, gets a missing-section error, then pauses on a complete plan', async () => {
    const m = scripted([
      [toolUse('read_file', { path: 'src/app.ts' })],
      [toolUse('submit_plan', { markdown: '## Approach\nonly this' })],
      [text('Revising.'), toolUse('submit_plan', { markdown: PLAN })],
    ]);
    const { d, steps } = deps({ phase: 'plan', call: m.call });
    const res = await runLoop(d, [], start);
    expect(res.outcome).toMatchObject({ type: 'submitted', kind: 'plan', markdown: PLAN });
    // The second request carried the file content back as a tool result.
    expect(JSON.stringify(m.requests[1]!.messages.at(-1))).toContain('export const greet');
    expect(JSON.stringify(m.requests[2]!.messages.at(-1))).toContain('missing these sections');
    expect(steps.filter((s) => s.kind === 'tool_call').map((s) => [s.toolName, s.isError])).toEqual([
      ['read_file', false],
      ['submit_plan', true],
      ['submit_plan', false],
    ]);
    // Planning offers no write tools.
    expect(m.requests[0]!.tools!.map((t) => t.name)).not.toContain('edit_file');
  });

  it('reports invalid or truncated tool input back to the model instead of crashing', async () => {
    const m = scripted([[toolUse('read_file', { pathh: 'x' })], [toolUse('submit_plan', { markdown: PLAN })]]);
    const { d } = deps({ phase: 'plan', call: m.call });
    await runLoop(d, [], start);
    expect(JSON.stringify(m.requests[1]!.messages.at(-1))).toMatch(/Invalid input for read_file/);
  });

  it('codes only within the approved design, and finishes', async () => {
    const m = scripted([
      [toolUse('edit_file', { path: 'src/other.ts', old_string: 'x', new_string: 'y' })],
      [toolUse('edit_file', { path: 'src/app.ts', old_string: '"hi"', new_string: '"hello"' })],
      [toolUse('finish', { summary: 'Greets with hello.' })],
    ]);
    const { d } = deps({ phase: 'code', call: m.call, allowedPaths: mentionedPaths(PLAN) });
    const res = await runLoop(d, [], start);
    expect(JSON.stringify(m.requests[1]!.messages.at(-1))).toContain("isn't part of the approved design");
    expect(res.outcome).toMatchObject({ type: 'finished', summary: 'Greets with hello.' });
    expect(await d.workspace.changes()).toEqual([{ path: 'src/app.ts', op: 'modify' }]);
  });

  it('pauses on ask_user and keeps the results of the other calls in that turn for the resume', async () => {
    const m = scripted([[toolUse('list_dir', {}), toolUse('ask_user', { question: 'Which redirect?', kind: 'question' })]]);
    const { d } = deps({ phase: 'plan', call: m.call });
    const res = await runLoop(d, [], start);
    expect(res.outcome).toMatchObject({ type: 'question', question: 'Which redirect?', kind: 'question' });
    expect(res.pendingResults).toHaveLength(1);
    expect(res.pendingResults[0]!.content).toContain('src/');
    expect(res.transcript.at(-1)!.role).toBe('assistant');
  });

  it('refuses finish without changes and a second hand-off in the same turn', async () => {
    const m = scripted([
      [toolUse('finish', { summary: 'done' })],
      [toolUse('create_file', { path: 'src/new.ts', content: 'x' }), toolUse('finish', { summary: 'a' }), toolUse('request_local_test', {})],
    ]);
    const { d } = deps({ phase: 'code', call: m.call });
    const res = await runLoop(d, [], start);
    expect(JSON.stringify(m.requests[1]!.messages.at(-1))).toContain("haven't changed any files");
    expect(res.outcome.type).toBe('finished');
    expect(res.pendingResults.map((r) => r.isError ?? false)).toEqual([false, true]);
  });

  it('stops when the task is cancelled, nudges a silent model, and enforces the turn limit', async () => {
    let cancelled = false;
    const m = scripted([[toolUse('list_dir', {})]]);
    const { d } = deps({ phase: 'plan', call: async (r) => ((cancelled = true), m.call(r)), isCancelled: async () => cancelled });
    expect((await runLoop(d, [], start)).outcome).toEqual({ type: 'cancelled' });

    const silent = scripted([[text('thinking')], [text('still')], [text('hmm')]]);
    expect((await runLoop(deps({ phase: 'plan', call: silent.call }).d, [], start)).outcome).toMatchObject({ type: 'failed', reason: expect.stringMatching(/without using its tools/) });

    const busy = scripted(Array.from({ length: 10 }, () => [toolUse('list_dir', {})]));
    expect((await runLoop({ ...deps({ phase: 'plan', call: busy.call }).d, maxTurns: 3 }, [], start)).outcome).toMatchObject({ type: 'failed', reason: expect.stringMatching(/3-step limit/) });
  });

  it('persists the transcript after every turn', async () => {
    const m = scripted([[toolUse('list_dir', {})], [toolUse('list_dir', {})], [toolUse('submit_plan', { markdown: PLAN })]]);
    const { d, persisted } = deps({ phase: 'plan', call: m.call });
    await runLoop(d, [], start);
    expect(persisted).toEqual([3, 5, 6]);
  });
});

describe('documents', () => {
  it('finds missing sections case-insensitively', () => {
    expect(missingSections('plan', PLAN)).toEqual([]);
    expect(missingSections('lld', '## files and functions\n## Edge cases')).toEqual(['Schema and API changes', 'Test cases to add']);
  });

  it('extracts file paths and directories from a design', () => {
    const paths = mentionedPaths('Change `src/auth/login.ts` and packages/web/app.tsx, plus everything in `src/routes/`. Bump to 1.2.3, e.g. later. See README.md.');
    expect([...paths].sort()).toEqual(['README.md', 'packages/web/app.tsx', 'src/auth/login.ts', 'src/routes/']);
  });
});

describe('tool definitions', () => {
  it('produce closed JSON schemas', () => {
    const edit = toolDefs('code').find((t) => t.name === 'edit_file')!;
    expect(edit.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'] });
    expect(edit.inputSchema).not.toHaveProperty('$schema');
  });
});
