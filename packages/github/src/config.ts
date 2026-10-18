export interface GitHubConfig {
  appId: number;
  appSlug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  apiUrl: string;
  webUrl: string;
}

export function githubConfigFromEnv(env: {
  GITHUB_APP_ID: number;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_API_URL: string;
  GITHUB_WEB_URL: string;
}): GitHubConfig {
  return {
    appId: env.GITHUB_APP_ID,
    appSlug: env.GITHUB_APP_SLUG,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    apiUrl: env.GITHUB_API_URL,
    webUrl: env.GITHUB_WEB_URL,
  };
}

export const installUrl = (cfg: GitHubConfig) =>
  `${cfg.webUrl}/apps/${cfg.appSlug}/installations/new`;
