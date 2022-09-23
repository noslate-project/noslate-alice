import assert from 'assert';
import { once } from 'events';
import mm from 'mm';
import path from 'path';

import { bufferFromStream } from '#self/lib/util';

import { testWorker, daemonProse, FIXTURES_DIR, ProseContext } from '#self/test/util';
import * as common from '#self/test/common';
import { killWorker } from './util';
import { config } from '#self/config';

const codeDir = path.join(FIXTURES_DIR, 'worker-integrated');

const defaultSeedCases: any = [
  {
    name: 'service_worker_math_random',
    profile: {
      name: 'service_worker_math_random',
      runtime: 'aworker',
      url: `file://${codeDir}/serverless-worker`,
      sourceFile: 'math-random.js',
      signature: 'md5:234234',
    },
    input: {
      data: Buffer.from('foobar'),
    },
  },
];

const seedScriptCases: any = [
  {
    name: 'service_worker_seed_userland',
    seedScript: `${codeDir}/serverless-worker/seed-userland.js`,
    profile: {
      name: 'service_worker_seed_userland',
      runtime: 'aworker',
      url: `file://${codeDir}/serverless-worker`,
      // This is ignored
      sourceFile: 'seed-userland.js',
      signature: 'md5:234234',
    },
    input: {
      data: Buffer.from('foobar'),
    },
    expect: {
      data: Buffer.from('deserialized'),
    },
  },
  {
    name: 'service_worker_seed_userland_error',
    seedScript: `${codeDir}/serverless-worker/seed-userland-serialize-error.js`,
    profile: {
      name: 'service_worker_seed_userland_error',
      runtime: 'aworker',
      url: `file://${codeDir}/serverless-worker`,
      // This is ignored
      sourceFile: 'seed-userland-serialize-error.js',
      signature: 'md5:234234',
    },
    input: {
      data: Buffer.from('foobar'),
    },
    expect: {
      // Should serve the request with non-seed mode as seed process failed to start.
      data: Buffer.from('before-serialize'),
    },
  },
];

const prose = process.platform === 'darwin' ? it.skip : it;
describe(common.testName(__filename), function() {
  // Debug version of Node.js may take longer time to bootstrap.
  this.timeout(30_000);

  beforeEach(async () => {
    // Default CI is non seed mode. Mock it to seed mode and then restart all roles.
    mm(process.env, 'ALICE_FORCE_NON_SEED_MODE', '');
  });
  afterEach(async () => {
    mm.restore();
  });

  describe('default seed', () => {
    const ctx: ProseContext<{}> = {};
    daemonProse(ctx);

    for (const item of defaultSeedCases) {
      prose(item.name, async () => {
        await ctx.agent!.setFunctionProfile([ item.profile ]);
        let first;
        {
          const response = await ctx.agent!.invoke(item.name, item.input.data, item.input.metadata);
          first = await bufferFromStream(response);
        }

        await killWorker(ctx.control!, item.name);

        await once(ctx.control!.capacityManager.workerStatsSnapshot, 'workerStopped');

        let second;
        {
          const response = await ctx.agent!.invoke(item.name, item.input.data, item.input.metadata);
          second = await bufferFromStream(response);
        }
        assert.notStrictEqual(first.toString(), second.toString());
      });
    }
  });

  describe('seed userland script', () => {
    for (const item of seedScriptCases) {
      describe(item.name, () => {
        beforeEach(async () => {
          mm(config.starter.aworker, 'defaultSeedScript', item.seedScript);
        });

        const ctx: any = {};
        daemonProse(ctx);
        prose('testing invoke result', async () => {
          await ctx.agent.setFunctionProfile([ item.profile ]);
          await testWorker(ctx.agent, item);
        });
      });
    }
  });
});
