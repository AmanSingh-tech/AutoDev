import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { fixture, offer } from '../test/git-fixture';
import { DockerExecutor } from './executors';
import { JobRunner } from './job-runner';

const docker = new Docker();
const available = await docker.ping().then(() => true, () => false);

describe.skipIf(!available)('DockerExecutor', () => {
  it('runs steps in a container as the host user, with no network outside setup', async () => {
    const f = fixture();
    const runner = new JobRunner({ cacheDir: f.cache, executorFor: (o) => new DockerExecutor(docker, o.dockerImage) });
    const res = await runner.run(
      offer(f, {
        docker: true,
        config: { test: [`test "$(id -u)" = "${process.getuid!()}"`, 'grep -q hello src/app.txt', '! wget -q -T 3 -O /dev/null http://1.1.1.1', 'touch made-in-container'], timeout_min: 2 }, 
      }),
      () => {},
      new AbortController().signal,
    );
    expect(res, res.logTail).toMatchObject({ status: 'passed' });
  }, 180_000);
});
