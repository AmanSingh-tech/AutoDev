import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { GitHubConfig } from './config';

/** Acts as the user (user-to-server token). Everything a user does in GitHub goes through this. */
export function userOctokit(cfg: GitHubConfig, token: string): Octokit {
  return new Octokit({ auth: token, baseUrl: cfg.apiUrl, userAgent: 'autodev' });
}

/** Acts as the App itself (JWT). Used only for installation metadata. */
export function appOctokit(cfg: GitHubConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: cfg.appId, privateKey: cfg.privateKey },
    baseUrl: cfg.apiUrl,
    userAgent: 'autodev',
  });
}

/** Installation token. Used for background repo sync, never for pushes or PRs. */
export function installationOctokit(cfg: GitHubConfig, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: cfg.appId, privateKey: cfg.privateKey, installationId },
    baseUrl: cfg.apiUrl,
    userAgent: 'autodev',
  });
}

export type { Octokit };
