import { describe, expect, it } from 'vitest';
import { parseAutodevConfig, parseBuilderMessage, parseFailedTests, parseGatewayMessage, steps } from './index';

describe('.autodev.yml', () => {
  it('parses commands as lists and applies defaults', () => {
    const res = parseAutodevConfig('setup: pnpm install\ntest:\n  - pnpm lint\n  - pnpm test\n');
    expect(res).toEqual({ ok: true, config: { setup: ['pnpm install'], test: ['pnpm lint', 'pnpm test'], timeout_min: 15 } });
    if (res.ok) expect(steps(res.config).map((s) => s.step)).toEqual(['setup', 'test']);
  });

  it('rejects unknown keys, a missing test command, a timeout over 30 min, and bad images', () => {
    expect(parseAutodevConfig('test: x\nrun_as_root: true').ok).toBe(false);
    expect(parseAutodevConfig('setup: x').ok).toBe(false);
    expect(parseAutodevConfig('test: x\ntimeout_min: 120')).toMatchObject({ ok: false, error: expect.stringContaining('timeout_min') });
    expect(parseAutodevConfig('test: x\ndocker_image: "img; rm -rf /"').ok).toBe(false);
    expect(parseAutodevConfig('test: x\ndocker_image: ghcr.io/acme/ci:1.2@sha256:' + 'a'.repeat(64)).ok).toBe(true);
    expect(parseAutodevConfig('{{{')).toMatchObject({ ok: false, error: expect.stringContaining('not valid YAML') });
  });
});

describe('messages', () => {
  it('accepts valid messages and rejects malformed or unknown ones', () => {
    expect(parseBuilderMessage(JSON.stringify({ type: 'heartbeat', ts: 1 }))).toEqual({ type: 'heartbeat', ts: 1 });
    expect(parseBuilderMessage('{"type":"job.accept","jobId":"nope"}')).toBeNull();
    expect(parseBuilderMessage('{"type":"exec","cmd":"rm -rf /"}')).toBeNull();
    expect(parseBuilderMessage('not json')).toBeNull();
    expect(parseGatewayMessage(JSON.stringify({ type: 'job.cancel', jobId: '018f0000-0000-7000-8000-000000000000' }))).toBeTruthy();
  });
});

describe('parseFailedTests', () => {
  it('extracts names from common runners', () => {
    const log = [
      ' FAIL  src/login.test.ts > login > keeps the return URL',
      'FAILED tests/test_api.py::test_404 - AssertionError: 500 != 404',
      '--- FAIL: TestGreet (0.00s)',
      'test parser::tests::empty ... FAILED',
    ].join('\n');
    expect(parseFailedTests(log)).toEqual([
      { file: 'src/login.test.ts', name: 'login > keeps the return URL' },
      { file: 'tests/test_api.py', name: 'test_404', message: 'AssertionError: 500 != 404' },
      { name: 'TestGreet' },
      { name: 'parser::tests::empty' },
    ]);
  });
});
