# Environments

Finken runs in three environments. Each one has its own database, its own settings and its own secrets. Data never moves from production to the other two.

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Who uses it | One developer, on their own computer | The team, to check changes before release | Real users |
| Database | Docker Postgres 18 (`npm run db:up`, port 5433) | Managed Postgres 18, small instance | Managed Postgres 18, with automatic backups and point-in-time restore |
| Data | Demo data only | Demo and test data only, never real users' data | Real users' data |
| `NODE_ENV` | `development` | `staging` | `production` |
| Deployed | Not deployed | Automatically, from `main` once checks pass (to set up once a host is chosen) | By hand, from a tagged release that already ran on staging |

## API settings

The API reads these settings when it starts (`apps/api/src/config.ts`). It stops with a list of what is missing or wrong, naming each setting without printing its value.

| Setting | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | none | Postgres connection, `postgres://user:password@host:port/db`. In staging and production, add `?sslmode=require`. |
| `NODE_ENV` | No | `development` | `development`, `test`, `staging` or `production` |
| `HOST` | No | `127.0.0.1` | Address to listen on. The container sets `0.0.0.0`. |
| `PORT` | No | `4000` | Port to listen on |
| `LOG_LEVEL` | No | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `AUTH_MODE` | Yes outside development | `dev` | `password`: Finken's own sign-in (accounts, password hashes and sessions in Finken's database; [SIGN-IN.md](SIGN-IN.md)). `oidc`: an outside provider's tokens. `dev`: tokens for any identity, for tests; refused in staging and production. |
| `AUTH_SECRET` | With `password` | none | At least 32 random characters; signs Finken's access tokens. A secret. |
| `APP_URL` | With `password` | `http://localhost:5173` | The web app's address, for links in emails. https in staging and production. |
| `SMTP_URL`, `MAIL_FROM` | With `password`, in staging and production | none | The mail server that sends "confirm your email" and "set a new password", and who the emails are from. Without them (development), emails are written to the log instead. |
| `AUTH_ISSUER` | With `oidc` | none | The provider's token issuer, exactly as it appears in its tokens |
| `AUTH_AUDIENCE` | With `oidc` | none | The audience the provider puts in tokens meant for Finken |
| `AUTH_JWKS_URL` | With `oidc` | none | The provider's public keys (https), for checking token signatures |
| `AUTH_DEV_SECRET` | With `dev` | none | At least 32 characters. Development and tests only. |
| `RATE_LIMIT_PER_MINUTE` | No | `300` | Requests each signed-in person may make per minute. Other limits are in [SECURITY.md](SECURITY.md). |
| `BETA_ACCESS` | No | `invite` in staging and production, `open` otherwise | `invite`: only people with an invite code can keep records (the closed beta). `open`: anyone who signs in. Set `open` on launch day ([BETA.md](BETA.md)). |
| `METRICS_TOKEN` | No | none | At least 32 characters. Outside development, `GET /metrics` exists only when this is set, and needs it as a bearer token. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | For pushed reminders | none | The key pair that signs reminders sent to devices. Make one with `npx web-push generate-vapid-keys`, once per environment; changing it means every device must turn reminders on again. The private key is a secret. |
| `VAPID_SUBJECT` | For pushed reminders | none | How push services can reach Finken about its messages: `mailto:…` or `https://…` |
| `SOURCE_DATABASE_URL` | No | none | Only for `restore.js`: the live database to compare a restored copy with ([OPERATIONS.md](OPERATIONS.md)). |

For development, copy `apps/api/.env.example` to `apps/api/.env`. Git ignores every `.env` file except the example.

## Secrets

- Staging and production secrets (database passwords and any sign-in provider keys) are kept in the hosting provider's secrets manager. They are never put in the repository, in CI logs or in chat.
- Each environment has its own database user. The production user can only reach the Finken database.
- Logs never contain request bodies, cookies or authorisation headers. The API removes those headers from its logs.

## Releasing the API

1. Build the image from the repository root: `docker build -f apps/api/Dockerfile .`
2. Run the migrations as a separate step before the new version takes traffic: `node dist/migrate.js` in the same image.
3. Start the new version. The host should send traffic only once `GET /ready` returns 200, and restart the process if `GET /health` stops answering.

Migrations only ever add. An applied migration file is never edited (the runner refuses to continue if one changes). Each new migration must work with the version of the API that is already running, so a release can be rolled back without undoing the database.

## Releasing the web app

The web app has one setting, read when it is built:

| Setting | Meaning |
| --- | --- |
| `VITE_API_URL` | Where the API is, for example `/api`. Set: account mode (records on the server, offline copy in the browser). Not set: everything stays in the browser, as before. `npm run dev:account` sets it from `apps/web/.env.account`. |
| `VITE_AUTH_ISSUER`, `VITE_AUTH_CLIENT_ID` | The sign-in provider's address and the client id it gives Finken ([SIGN-IN.md](SIGN-IN.md)). Set: people sign in on the provider's page. Not set: the development sign-in, which only a development API accepts. `npm run dev:sign-in` sets them for the stand-in provider. |


`npm run build -w @finken/web` writes a static site to `apps/web/dist`, which any static host or CDN can serve. Point `/api/*` at the API on the same domain, so the browser never makes a cross-origin request.

## Still to decide

- The hosting provider for the API, the database and the web app. Everything above works with any provider that runs containers and offers managed Postgres.
- The domain names for staging and production.
