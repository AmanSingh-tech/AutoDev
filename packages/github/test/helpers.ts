import { setupServer } from 'msw/node';
import type { GitHubConfig } from '../src/config';

export const API = 'http://github.test/api';
export const WEB = 'http://github.test';

export const testCfg: GitHubConfig = {
  appId: 1,
  appSlug: 'autodev-test',
  privateKey: 'unused',
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  webhookSecret: 'whsec_test_123456',
  apiUrl: API,
  webUrl: WEB,
};

export const server = setupServer();
