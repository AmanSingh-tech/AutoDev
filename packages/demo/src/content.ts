/**
 * What the demo agent "writes": a plan, a design, a code change and a test log, generated from the
 * task's own title and repository so any task a prospect creates gets a believable result.
 * Nothing here calls a model.
 */

export interface DemoTaskInput {
  key: string;
  title: string;
  descriptionMd: string;
  repoName: string;
}

export interface DemoFile {
  path: string;
  op: 'create' | 'modify';
  before: string;
  after: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'change';
const camel = (s: string) => slug(s).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());

/** Web repos get a React component; everything else a service module. */
const isWeb = (repo: string) => /web|app|site|front|ui|mobile/i.test(repo);

function area(t: DemoTaskInput) {
  const name = slug(t.title.replace(/^(add|fix|implement|create|support|make|update|improve|return|migrate|remove|paginate|document)\s+/i, ''));
  return isWeb(t.repoName)
    ? { dir: 'src/components', file: `src/components/${pascal(name)}.tsx`, test: `src/components/${pascal(name)}.test.tsx`, entry: 'src/app/routes.tsx', name }
    : { dir: 'src/services', file: `src/services/${name}.ts`, test: `src/services/${name}.test.ts`, entry: 'src/server.ts', name };
}

export function demoPlan(t: DemoTaskInput, version: number, feedback?: string | null): string {
  const a = area(t);
  return [
    `## Plan: ${t.title}`,
    version > 1 && feedback ? `> Updated after review: “${feedback.trim().slice(0, 300)}”` : null,
    '### What I found',
    `- The behaviour lives around \`${a.entry}\`; there is no dedicated module for it yet.`,
    `- Existing tests in \`${a.dir}\` use the shared test helpers, so the new tests will follow the same style.`,
    `- No public API or database schema changes are needed.`,
    '### Steps',
    `1. Add \`${a.file}\` with the new logic, small and covered by unit tests.`,
    `2. Wire it into \`${a.entry}\`, keeping the current behaviour behind the same entry point.`,
    `3. Add \`${a.test}\` covering the normal case, the edge cases and an error case.`,
    `4. Run the repository's test suite on the builder and fix anything it finds.`,
    '### Risks',
    '- Low. The change is additive and the old path stays until the new one passes its tests.',
    '### Acceptance criteria',
    '- The behaviour described in the task works end to end.',
    '- New and existing tests pass.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function demoDesign(t: DemoTaskInput, version: number, feedback?: string | null): string {
  const a = area(t);
  const fn = camel(a.name);
  return [
    `## Design: ${t.title}`,
    version > 1 && feedback ? `> Updated after review: “${feedback.trim().slice(0, 300)}”` : null,
    '### Module',
    `\`${a.file}\` exports \`${isWeb(t.repoName) ? pascal(a.name) : fn}\`, a pure function of its inputs, so it can be tested without the server.`,
    '### Interface',
    '```ts',
    isWeb(t.repoName) ? `export function ${pascal(a.name)}(props: { title: string; items: string[] }): JSX.Element` : `export function ${fn}(input: Request, opts?: { limit?: number }): Result`,
    '```',
    '### Data flow',
    `Request → \`${a.entry}\` → \`${a.file}\` → response. Errors are returned as typed results, never thrown across the boundary.`,
    '### Tests',
    `- \`${a.test}\`: happy path, empty input, the limit, and an invalid input.`,
    '### Out of scope',
    '- Refactoring neighbouring modules; I will note anything worth a follow-up task in the summary.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function demoFiles(t: DemoTaskInput): DemoFile[] {
  const a = area(t);
  const fn = camel(a.name);
  const C = pascal(a.name);
  if (isWeb(t.repoName)) {
    return [
      {
        path: a.file,
        op: 'create',
        before: '',
        after: `import { useState } from 'react';

/** ${t.title}. */
export function ${C}({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return <p className="empty">Nothing here yet.</p>;
  return (
    <section aria-labelledby="${a.name}-title">
      <button id="${a.name}-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
      </button>
      {open && (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
`,
      },
      {
        path: a.test,
        op: 'create',
        before: '',
        after: `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ${C} } from './${C}';

test('shows the items and collapses', async () => {
  render(<${C} title="Things" items={['a', 'b']} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: 'Things' }));
  expect(screen.queryByRole('listitem')).toBeNull();
});

test('says so when there is nothing to show', () => {
  render(<${C} title="Things" items={[]} />);
  expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
});
`,
      },
      {
        path: a.entry,
        op: 'modify',
        before: `import { Dashboard } from './dashboard';
import { Settings } from './settings';

export const routes = [
  { path: '/', element: <Dashboard /> },
  { path: '/settings', element: <Settings /> },
];
`,
        after: `import { ${C} } from '../components/${C}';
import { Dashboard } from './dashboard';
import { Settings } from './settings';

export const routes = [
  { path: '/', element: <Dashboard /> },
  { path: '/settings', element: <Settings /> },
  { path: '/${a.name}', element: <${C} title="${t.title.replace(/"/g, '')}" items={[]} /> },
];
`,
      },
    ];
  }
  return [
    {
      path: a.file,
      op: 'create',
      before: '',
      after: `/** ${t.title}. */
export interface ${C}Options {
  limit?: number;
}

export type ${C}Result = { ok: true; value: string[] } | { ok: false; error: string };

export function ${fn}(input: string[], opts: ${C}Options = {}): ${C}Result {
  const limit = opts.limit ?? 50;
  if (!Array.isArray(input)) return { ok: false, error: 'input must be a list' };
  if (limit < 1 || limit > 500) return { ok: false, error: 'limit must be between 1 and 500' };
  return { ok: true, value: input.slice(0, limit) };
}
`,
    },
    {
      path: a.test,
      op: 'create',
      before: '',
      after: `import { describe, expect, it } from 'vitest';
import { ${fn} } from './${a.name}';

describe('${fn}', () => {
  it('returns up to the limit', () => {
    expect(${fn}(['a', 'b', 'c'], { limit: 2 })).toEqual({ ok: true, value: ['a', 'b'] });
  });
  it('handles an empty list', () => {
    expect(${fn}([])).toEqual({ ok: true, value: [] });
  });
  it('rejects a bad limit', () => {
    expect(${fn}(['a'], { limit: 0 })).toMatchObject({ ok: false });
  });
});
`,
    },
    {
      path: a.entry,
      op: 'modify',
      before: `import Fastify from 'fastify';
import { health } from './routes/health';

export const app = Fastify();
app.register(health);
`,
      after: `import Fastify from 'fastify';
import { health } from './routes/health';
import { ${fn} } from './services/${a.name}';

export const app = Fastify();
app.register(health);

app.get('/${a.name}', async (req, reply) => {
  const result = ${fn}([], { limit: Number((req.query as { limit?: string }).limit ?? 50) });
  return result.ok ? result.value : reply.code(400).send({ error: result.error });
});
`,
    },
  ];
}

export function demoTestLog(t: DemoTaskInput, files: DemoFile[]): { log: string; durationMs: number } {
  const tests = files.filter((f) => /\.test\./.test(f.path));
  const web = isWeb(t.repoName);
  const lines = [
    '$ docker run --rm -v /workspace:/app node:20 sh -c "npm ci && npm test"',
    '',
    'added 612 packages in 9.8s',
    '',
    `> ${t.repoName}@1.0.0 test`,
    `> ${web ? 'vitest run --environment jsdom' : 'vitest run'}`,
    '',
    ...tests.map((f) => ` ✓ ${f.path} (${web ? 2 : 3} tests) ${120 + f.path.length}ms`),
    ` ✓ src/${web ? 'app/dashboard.test.tsx' : 'routes/health.test.ts'} (4 tests) 88ms`,
    ` ✓ src/${web ? 'app/settings.test.tsx' : 'routes/auth.test.ts'} (9 tests) 341ms`,
    '',
    ` Test Files  ${tests.length + 2} passed (${tests.length + 2})`,
    `      Tests  ${tests.length * (web ? 2 : 3) + 13} passed (${tests.length * (web ? 2 : 3) + 13})`,
    '   Duration  4.12s',
    '',
  ];
  return { log: lines.join('\n'), durationMs: 18_400 };
}

export function demoSummary(t: DemoTaskInput, files: DemoFile[]): string {
  return [
    `**${t.title}**: done.`,
    '',
    ...files.map((f) => `- ${f.op === 'create' ? 'Added' : 'Updated'} \`${f.path}\``),
    '',
    'All tests pass on the builder. No follow-ups needed.',
  ].join('\n');
}
