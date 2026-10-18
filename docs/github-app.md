# Registering the GitHub App

AutoDev signs users in through a **GitHub App**, not an OAuth App. That gives us
*user-to-server* tokens: every push and PR is made **as the user**, limited to both the App's
permissions and the user's own repo permissions.

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**, or create it from
[`github-app-manifest.json`](../github-app-manifest.json).

| Setting | Value |
|---|---|
| Callback URL | `{WEB_URL}/api/auth/callback/github` |
| Setup URL | `{WEB_URL}/api/github/setup`, with **Redirect on update** checked |
| Request user authorization (OAuth) during installation | off |
| **Expire user authorization tokens** | **on** (8h access tokens + refresh tokens) |
| Webhook URL | `{API_URL}/webhooks/github`, which must be reachable by GitHub (use a tunnel in dev, e.g. `cloudflared` or `ngrok`) |
| Webhook secret | a long random string, same as `GITHUB_WEBHOOK_SECRET` |

**Permissions** (exactly these):

- Repository → Contents: **Read & write**
- Repository → Pull requests: **Read & write**
- Repository → Metadata: **Read**
- Organization → Members: **Read**

There's deliberately **no Workflows permission**, so AutoDev can't change `.github/workflows/*`.
GitHub rejects such pushes, and the agent is told not to try.

**Subscribe to events:** Member, Membership, Organization, Repository, Team, Team add.
Installation events are always sent. Pull request events are added in phase A-6.

## 2. Fill in `.env`

```
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=autodev-dev          # from https://github.com/apps/<slug>
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=...
```

To turn the downloaded `.pem` into one line:
`awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.private-key.pem`

## 3. Install on an org

Sign in to AutoDev, then click **Install on a GitHub org**. After installing, GitHub sends you to
the Setup URL, and AutoDev:

1. checks that the installation appears in **your** `/user/installations` (the `installation_id`
   in the URL is never trusted on its own);
2. checks that you're a **GitHub org admin** (or the owner of a personal account), and only then
   creates the AutoDev org with you as **owner**;
3. queues a repo sync.

Other GitHub org members join automatically with the org's default role (developer) the first
time they sign in. Someone an admin removed from AutoDev is not re-added automatically.

## What GitHub may still block

Branch protection and rulesets apply to the user as usual. AutoDev pushes to `autodev/*` branches
and opens PRs. Orgs that enforce SAML SSO need the user to have an active SSO session, and orgs
with an IP allow list must allow AutoDev's worker IPs.
