import type { FailedTest } from './messages';

/**
 * Best-effort extraction of failing test names from common runners (vitest/jest, pytest, go test,
 * mocha, rspec, cargo). The agent always gets the raw log tail too; this is just a summary.
 */
const PATTERNS: { re: RegExp; map: (m: RegExpMatchArray) => FailedTest }[] = [
  // vitest / jest: " FAIL  src/a.test.ts > suite > name" or "  × suite > name"
  { re: /^\s*(?:FAIL|×|✕)\s+(\S+\.(?:test|spec)\.[jt]sx?)\s+>\s+(.+)$/gm, map: (m) => ({ file: m[1]!, name: m[2]!.trim() }) },
  { re: /^\s*(?:×|✕)\s+(.+?)(?:\s+\d+ms)?$/gm, map: (m) => ({ name: m[1]!.trim() }) },
  // pytest: "FAILED tests/test_a.py::test_x - AssertionError"
  { re: /^FAILED\s+([^\s:]+)::(\S+)(?:\s+-\s+(.*))?$/gm, map: (m) => ({ file: m[1]!, name: m[2]!, ...(m[3] ? { message: m[3] } : {}) }) },
  // go test: "--- FAIL: TestName (0.00s)"
  { re: /^\s*--- FAIL: (\S+)/gm, map: (m) => ({ name: m[1]! }) },
  // cargo: "test tests::name ... FAILED"
  { re: /^test (\S+) \.\.\. FAILED$/gm, map: (m) => ({ name: m[1]! }) },
  // rspec: "rspec ./spec/a_spec.rb:12 # does x"
  { re: /^rspec (\.\/\S+?):\d+ # (.+)$/gm, map: (m) => ({ file: m[1]!, name: m[2]! }) },
];

export function parseFailedTests(log: string, max = 50): FailedTest[] {
  const out: FailedTest[] = [];
  const seen = new Set<string>();
  for (const { re, map } of PATTERNS) {
    for (const m of log.matchAll(re)) {
      const t = map(m);
      const key = `${t.file ?? ''}::${t.name}`;
      if (seen.has(key) || [...seen].some((k) => k.endsWith(`::${t.name}`) || key.endsWith(k))) continue;
      seen.add(key);
      out.push({ ...t, name: t.name.slice(0, 500) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
