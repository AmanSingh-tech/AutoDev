# AutoDev Helm chart

Runs AutoDev's backend on Kubernetes: the **API**, the **worker**, the **builder gateway**, a
**migration Job** on every install and upgrade, and optionally the **web app**. Postgres 16 (with
pgvector) and Redis 7 are yours: managed services or your own.

## 1. Images

```
docker build -t <registry>/autodev:<tag> .                                   # backend (all services)
docker build --target web --build-arg API_URL=https://api.example.com \
  -t <registry>/autodev-web:<tag> .                                          # web app, only if not on Vercel
```

The web app reads `API_URL` when it's built, so build it for this cluster's API address.

## 2. Database

Create the two roles once (see [docs/deploy-backend.md](../../../docs/deploy-backend.md#1-postgres)):
`autodev_system` (owns the schema, needs `BYPASSRLS`) and `autodev_app` (everything else, always under
row-level security).

## 3. Settings

Put secrets in a Secret you manage and pass its name, or let the chart create one from `secrets`:

```
kubectl create secret generic autodev-settings \
  --from-literal=DATABASE_URL=postgres://autodev_app:…@db:5432/autodev \
  --from-literal=DATABASE_URL_SYSTEM=postgres://autodev_system:…@db:5432/autodev \
  --from-literal=REDIS_URL=redis://redis:6379 \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=AUTH_SECRET="$(openssl rand -base64 48)" \
  --from-literal=GITHUB_APP_ID=… --from-literal=GITHUB_APP_SLUG=… \
  --from-literal=GITHUB_APP_CLIENT_ID=… --from-literal=GITHUB_APP_CLIENT_SECRET=… \
  --from-literal=GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" --from-literal=GITHUB_WEBHOOK_SECRET=…
```

Keep `MASTER_KEY` safe: losing it loses every stored token and key. Optional settings (Stripe,
WorkOS, S3…) go in the same Secret; the full list is in docs/deploy-backend.md.

## 4. Install

```
helm install autodev deploy/helm/autodev \
  --set image.repository=<registry>/autodev --set image.tag=<tag> \
  --set existingSecret=autodev-settings \
  --set env.WEB_URL=https://autodev.example.com \
  --set env.API_URL=https://api.autodev.example.com \
  --set env.BUILDER_GATEWAY_URL=wss://gateway.autodev.example.com/builder \
  --set api.ingress.enabled=true --set api.ingress.host=api.autodev.example.com \
  --set gateway.ingress.enabled=true --set gateway.ingress.host=gateway.autodev.example.com
```

Add `--set web.enabled=true` (and its ingress) to run the web app here too. The web pod only gets the
settings sign-in needs; it never sees the GitHub App's private key or webhook secret.

| Value | Default | What it does |
|---|---|---|
| `existingSecret` | `""` | A Secret with the settings; empty = the chart creates one from `secrets` |
| `env.*` | see values.yaml | Non-secret settings for every service |
| `env.TRUST_PROXY` | `"1"` | Proxies in front of the API (the ingress controller); matters for IP allowlists |
| `api.replicas` / `gateway.replicas` / `worker.replicas` | 2 / 1 / 1 | |
| `*.ingress.*` | off | Ingress per public service (api, gateway, web) |
| `worker.embeddingsCache.persistence` | `false` | Keep the code index's model (about 160 MB) on a volume instead of downloading it per pod |
| `migrations.enabled` | `true` | Runs migrations as a pre-install/pre-upgrade Job |

## 5. After installing

- GitHub App: webhook `https://<api host>/webhooks/github`, callback and setup URLs on the web app
  (see docs/github-app.md).
- The gateway keeps builders' WebSockets open for a long time; the default values raise nginx's
  timeouts. Other ingress controllers need the equivalent.
- Check: `kubectl get pods`, then `https://<api host>/healthz` returns `{"ok":true}`.
