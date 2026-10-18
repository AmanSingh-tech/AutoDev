/** The user must sign in with GitHub again (token revoked, or refresh token expired). */
export class GitHubReauthRequired extends Error {
  override name = 'GitHubReauthRequired';
}

/** A live permission check failed. Thrown before any push or PR. */
export class PushNotAllowed extends Error {
  override name = 'PushNotAllowed';
  constructor(readonly repoFullName: string) {
    super(`You no longer have write access to ${repoFullName}`);
  }
}
