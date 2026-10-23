import { describe, expect, it } from 'vitest';
import { bumpKind, lockfilePaths, parseLockfile } from './lockfiles';
import { errorSignature } from './scans';

const pick = (deps: ReturnType<typeof parseLockfile>) => deps.map((d) => `${d.name}@${d.version}${d.direct ? '*' : ''}`).sort();

describe('lockfiles', () => {
  it('finds lockfiles anywhere except vendored folders, shallowest first', () => {
    expect(lockfilePaths(['apps/web/package-lock.json', 'package-lock.json', 'node_modules/x/package-lock.json', 'svc/go.mod', 'README.md', 'vendor/a/go.mod'])).toEqual([
      'package-lock.json',
      'svc/go.mod',
      'apps/web/package-lock.json',
    ]);
  });

  it('package-lock.json: every package, direct ones marked', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { lodash: '^4.17.0' }, devDependencies: { vitest: '^2.0.0' } },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/vitest': { version: '2.1.0' },
        'node_modules/@scope/inner': { version: '1.0.0' },
        'node_modules/vitest/node_modules/lodash': { version: '4.17.15' },
      },
    });
    expect(pick(parseLockfile('package-lock.json', lock))).toEqual(['@scope/inner@1.0.0', 'lodash@4.17.15', 'lodash@4.17.20*', 'vitest@2.1.0*']);
  });

  it('pnpm-lock.yaml (v9): packages, with importers marking the direct ones', () => {
    const lock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      "        specifier: ^4.17.0",
      '        version: 4.17.20',
      '      react:',
      '        specifier: ^19',
      '        version: 19.0.0(react-dom@19.0.0)',
      'packages:',
      '  lodash@4.17.20:',
      '    resolution: {integrity: sha512-x}',
      '  react@19.0.0:',
      '    resolution: {integrity: sha512-y}',
      "  '@babel/core@7.26.0':",
      '    resolution: {integrity: sha512-z}',
    ].join('\n');
    expect(pick(parseLockfile('pnpm-lock.yaml', lock))).toEqual(['@babel/core@7.26.0', 'lodash@4.17.20*', 'react@19.0.0*']);
  });

  it('yarn.lock v1 and Berry', () => {
    const v1 = ['# yarn lockfile v1', '', 'lodash@^4.17.0, lodash@^4.17.15:', '  version "4.17.21"', '  resolved "https://x"', '', '"@babel/core@^7.0.0":', '  version "7.26.0"'].join('\n');
    expect(pick(parseLockfile('yarn.lock', v1))).toEqual(['@babel/core@7.26.0', 'lodash@4.17.21']);
    const berry = ['__metadata:', '  version: 8', '', '"lodash@npm:^4.17.21":', '  version: 4.17.21', '  resolution: "lodash@npm:4.17.21"'].join('\n');
    expect(pick(parseLockfile('yarn.lock', berry))).toEqual(['lodash@4.17.21']);
  });

  it('requirements.txt pins, poetry.lock and go.mod', () => {
    expect(pick(parseLockfile('requirements.txt', 'Django==4.2.1  # web\nrequests>=2\nurllib3[socks]==1.26.5\n# x==1\n'))).toEqual(['django@4.2.1*', 'urllib3@1.26.5*']);
    expect(pick(parseLockfile('poetry.lock', '[[package]]\nname = "Jinja2"\nversion = "3.1.2"\n\n[[package]]\nname = "markupsafe"\nversion = "2.1.3"\n'))).toEqual(['jinja2@3.1.2', 'markupsafe@2.1.3']);
    const mod = ['module example.com/app', '', 'go 1.22', '', 'require github.com/pkg/errors v0.9.1', 'require (', '\tgolang.org/x/net v0.17.0', '\tgithub.com/x/y v1.2.3 // indirect', ')'].join('\n');
    expect(pick(parseLockfile('go.mod', mod))).toEqual(['github.com/pkg/errors@0.9.1*', 'github.com/x/y@1.2.3', 'golang.org/x/net@0.17.0*']);
  });

  it('skips a file it cannot parse instead of failing the scan', () => {
    expect(parseLockfile('package-lock.json', '{not json')).toEqual([]);
  });
});

describe('versions and signatures', () => {
  it('classifies upgrades', () => {
    expect([bumpKind('4.17.20', '4.17.21'), bumpKind('4.17.20', '4.18.0'), bumpKind('4.17.20', '5.0.0'), bumpKind('4.17.21', '4.17.21'), bumpKind('1.0.0-beta', '1.0.0'), bumpKind('2.0.0', '1.9.9')]).toEqual([
      'patch',
      'minor',
      'major',
      null,
      null,
      null,
    ]);
  });

  it('normalises errors so the same failure matches across repos', () => {
    expect(errorSignature('Error: connect ECONNREFUSED 127.0.0.1:5432 at /home/ci/app/src/db.ts:12')).toBe(errorSignature('Error: connect ECONNREFUSED 10.0.0.7:5433 at /srv/other/db.js:99'));
    expect(errorSignature("Expected 'a' to equal 'b'")).toBe(errorSignature("Expected 'x' to equal 'y'"));
  });
});
