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

For development, copy `apps/api/.env.example` to `apps/api/.env`. Git ignores every `.env` file except the example.

## Secrets

- Staging and production secrets (database passwords, and sign-in provider keys from Phase 2) are kept in the hosting provider's secrets manager. They are never put in the repository, in CI logs or in chat.
- Each environment has its own database user. The production user can only reach the Finken database.
- Logs never contain request bodies, cookies or authorisation headers. The API removes those headers from its logs.

## Releasing the API

1. Build the image from the repository root: `docker build -f apps/api/Dockerfile .`
2. Run the migrations as a separate step before the new version takes traffic: `node dist/migrate.js` in the same image.
3. Start the new version. The host should send traffic only once `GET /ready` returns 200, and restart the process if `GET /health` stops answering.

Migrations only ever add. An applied migration file is never edited (the runner refuses to continue if one changes). Each new migration must work with the version of the API that is already running, so a release can be rolled back without undoing the database.

## Releasing the web app

`npm run build -w @finken/web` writes a static site to `apps/web/dist`, which any static host or CDN can serve. Point `/api/*` at the API on the same domain, so the browser never makes a cross-origin request.

## Still to decide

- The hosting provider for the API, the database and the web app. Everything above works with any provider that runs containers and offers managed Postgres.
- The domain names for staging and production.
