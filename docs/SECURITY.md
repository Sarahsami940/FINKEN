# Security

How Finken protects people's financial records, what is tested, and what is still to do before launch. Privacy (what is kept, for how long, and people's rights) is in [PRIVACY.md](PRIVACY.md); running the service is in [OPERATIONS.md](OPERATIONS.md).

## What we protect, and from whom

Finken holds a person's whole financial picture: balances, spending, debts, who owes them money. The main risks:

| Risk | Example | Main protection |
| --- | --- | --- |
| Someone reads or changes another person's records | Guessing record ids, replaying a request with another id | Every read and write goes through `space_members`. A record id can never be reused in another Space. The same `403` answer whether a record is someone else's or does not exist. |
| A stolen or forged sign-in | A token copied from a log, a token signed by someone else | Tokens are checked against the sign-in provider's published keys, issuer, audience and expiry. Tokens never appear in logs. Development sign-in cannot be switched on in staging or production. |
| Records that break the money rules | A refund larger than the expense, sent by a modified app | The server runs the same money rules as the app on every save, all or nothing, and the database checks its own constraints at commit. |
| Floods and guessing | Scripts hammering the API, trying tokens | Rate limits per person, per address, and for failed sign-ins (below). An 8 MB cap on request size, and 5,000 records of one kind per batch. |
| Leaks through logs and errors | Amounts, emails or stack traces in a log or error page | Log lines carry only ids, routes, status and timing. Server errors return a fixed message and a request id; the details stay in the log. |
| Injection | SQL in an id or a description | Every query uses parameters; tested with hostile ids and names. |
| Losing data | A bad release, a deleted table, a failed disk | Soft delete with change history on every record. Nightly reconciliation. Backups with a tested restore drill ([OPERATIONS.md](OPERATIONS.md)). |
| The browser copy | A shared or stolen computer | The account's offline copy is cleared on logging out. Browser data from before accounts can only be moved after the password of the local account that made it. |

## Controls in place

**Sign-in.** `AUTH_MODE=oidc` checks tokens against `AUTH_JWKS_URL`, `AUTH_ISSUER` and `AUTH_AUDIENCE`, and the API refuses to start without them in staging and production. The provider (not yet chosen) handles passwords, email verification, recovery and multi-factor sign-in.

**Permissions.** Roles are owner, editor and viewer. Only owners delete Spaces. Records cannot move between Spaces, and ids cannot be borrowed across them.

**Rate limits** (per minute unless stated; `apps/api/src/security.ts`):

| Limit | Budget | Key |
| --- | --- | --- |
| Everything from one address | 2,000 | IP address, kept in memory only and never logged |
| Requests with a token that fails | 30 | IP address |
| Development sign-in | 30 | IP address |
| Each signed-in person | `RATE_LIMIT_PER_MINUTE` (300) | user id |
| Saves (`/v1/batch`) | 120 | user id |
| Data exports | 10 an hour | user id |
| Error reports from the app | 20 | user id |

**Pushed reminders** go only to addresses at the real push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`). Anything else is refused when a device registers, so nobody can make Finken's server send requests to an address of their choosing. Messages are signed with the VAPID key and encrypted for the device.

Over a limit, the answer is `429` with `Retry-After`, and nothing is done. The counts live in each API process: with several instances, each keeps its own, so move them to a shared store before running more than a few.

**Headers on every answer.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, and HSTS in staging and production. Every answer carries `X-Request-Id`; an id passed in by the proxy is kept if it is a plain token.

**The web app's host** must add its own headers (the API's do not cover the static site): a Content-Security-Policy allowing only the app's own scripts and styles and `connect-src 'self'`, `frame-ancestors 'none'`, HSTS, and `Referrer-Policy: no-referrer`. Serve `/api/*` from the same domain so no cross-origin requests are needed.

**Metrics** (`/metrics`) exist outside development only when `METRICS_TOKEN` is set, and then need it.

**Dependencies.** `npm audit` reports no known vulnerabilities (20 November 2026). Dependabot proposes updates weekly.

## Tested

`apps/api/src/security.test.ts`, `records.test.ts`, `app.test.ts` and `tests/e2e`:
- rate limits stop one person without touching another, and slow down token guessing;
- headers, including HSTS in production;
- logs never contain tokens, emails, names, amounts, descriptions, query values or IP addresses;
- server failures show a fixed message with a request id, never the cause;
- hostile ids and names are stored as text, never run as SQL;
- unknown collections, oversized and broken requests are refused;
- someone else's records can be neither read nor changed;
- development sign-in and metrics do not exist in production without their settings;
- export holds only the person's own Spaces, and deleting an account leaves everyone else's data alone.

CI also checks that a real API's logs hold no tokens or emails after a load test.

## Before launch

- Choose the sign-in provider and set `AUTH_MODE=oidc`. Turn on multi-factor sign-in there.
- An independent penetration test of the API and web app, after the sign-in provider is in place.
- Rate-limit counts in a shared store once there is more than one API instance.
- The web host's headers above, checked with a scanner.
- Secrets in the host's secret store; database credentials for the API without permission to drop tables; a separate migration user.
- A way for people to report security problems (for example `security@` and a `/.well-known/security.txt`), and someone responsible for answering.
