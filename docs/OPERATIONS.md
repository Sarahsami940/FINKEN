# Operations

Running Finken: monitoring, the nightly check, backups and restores, load testing and the automatic checks. Settings are in [ENVIRONMENTS.md](ENVIRONMENTS.md); security in [SECURITY.md](SECURITY.md).

## Monitoring

**Health.** `GET /health` answers while the process runs. `GET /ready` answers `200` only when the database can be reached. Send traffic only to ready instances, and restart any that stop answering `/health`.

**Logs.** One JSON line per request: `reqId`, `req.method`, `req.route` (the pattern, such as `/v1/records/:collection`), `res.status`, `ms` and `user` (the internal id). Server failures add a `request failed` line with the error, under the same `reqId`, which is also the id people see in the error. Nothing else is logged: no bodies, query values, tokens, emails, names, amounts or IP addresses. Keep logs 30 days.

**Metrics.** `GET /metrics`, in the Prometheus text format, with `Authorization: Bearer $METRICS_TOKEN`:

| Metric | What it counts |
| --- | --- |
| `finken_http_requests_total{route,method,status}` | Requests answered |
| `finken_http_request_duration_seconds{route,method}` | Time to answer (histogram) |
| `finken_batch_records_total` | Records saved or deleted |
| `finken_batch_refused_total{reason}` | Saves refused: `shape`, `permission`, `money_rules`, `conflict` |
| `finken_rate_limited_total{limit}` | Requests stopped by each rate limit |
| `finken_client_errors_total` | Errors reported by the web app |
| `finken_uptime_seconds` | Since the process started |

**Alerts to set up** (starting points; adjust once there is real traffic):

| Alert | When | Why it matters |
| --- | --- | --- |
| API down | `/ready` fails for 2 minutes | Nobody can sync |
| Server errors | over 1% of requests answer 5xx for 5 minutes | Something is broken |
| Slow saves | `/v1/batch` p95 over 500 ms for 10 minutes | People wait, phones retry |
| Refusals jump | `money_rules` or `permission` refusals over 5× their usual rate | A bad release, or someone probing |
| Rate limits | `signInFailures` limit reached often | Someone guessing tokens |
| App errors | `finken_client_errors_total` over 5× its usual rate | A broken screen |
| Nightly check | the reconciliation job exits 1, or does not run | Records break a rule |
| Backups | no successful backup in 26 hours | Nothing to restore from |

## Nightly reconciliation

```bash
node dist/reconcile.js   # in the API image; npm run db:reconcile -w @finken/api locally
```

Run it once a night with the host's scheduler, with the API's environment. It checks every Space against the money rules:
- refunds within what was paid, payments within what is owed;
- money owed never below what has moved, and shares within the expense;
- goals never below zero;
- every account and category used still exists;
- links point at live records;
- balances are exact, and each Space has one owner;
- no change number is used twice.

It prints one JSON line (`"msg":"reconciliation"`) with counts and up to 100 problems by id, never contents, and exits `1` if anything is wrong. In a healthy database it finds nothing, because every save already passes these rules.

It also forgets whose deleted accounts were once backups no longer hold them (35 days; see [PRIVACY.md](PRIVACY.md)), deletes usage counts older than 180 days, and records the run in `reconciliation_runs`. The launch report checks that table to see the job ran every night ([BETA.md](BETA.md)).

**If it finds something:** nothing is changed automatically. Look up the ids, work out how the record got there (a bug in a release, a manual change in the database), fix the cause, then fix the records through the app or with a reviewed SQL change.

## Reminders job

```bash
node dist/push.js   # every hour, with the API's environment and the VAPID keys
```

For each person with a device that asked for reminders, once it is past 9 in the morning in their own time zone, it sends that day's reminder if anything needs attention:
- at most once a day;
- counts only ("2 payments are due today"), never amounts or names.

Devices the push service reports gone (`404`/`410`) are forgotten, and so are devices that fail five times in a row. It prints one JSON line (`"msg":"reminders"`) with how many people and devices it reached. Without VAPID keys it does nothing and says so.

Alert if it has not run for three hours.

## Backups and restores

**Backups.** Use the database host's automatic backups with point-in-time recovery, kept **35 days** (the Delete account screen promises this). Also take a nightly logical backup (`pg_dump -Fc`) to separate storage in another region, encrypted, kept 35 days.

**Restore drill: monthly, and before launch.**
1. Restore the latest backup into a new, empty database (never over the live one).
2. Check it against the live database:
   ```bash
   DATABASE_URL=<restored> SOURCE_DATABASE_URL=<live> node dist/restore.js
   ```
   This compares every migration, row count and the last change number, names any account deleted since the backup that has come back, and runs reconciliation. It exits `1` with every difference listed. A backup older than the live database shows the rows written since; that is expected in a drill, and tells you how much a real restore would lose.
3. Write down the time it took and what it reported. That is the real recovery time.
4. Delete the restored copy.

CI runs this drill on every push: back up with `pg_dump`, restore into a second database, `restore.js` against the original.

**A real restore.**
1. Stop the API, so nothing writes to the damaged database.
2. Restore into a new database and run `restore.js` against it, without `SOURCE_DATABASE_URL` if the original is gone.
3. Delete again every account deleted since the backup. `restore.js` names them when it can see the original. If the original is gone, use the `account deleted` log lines from the period since the backup.
4. Point the API at the restored database, start it, and check `/ready`.
5. Devices re-sync on their own. Changes they made after the backup are still in their outboxes and are sent again.

## Load testing

```bash
npm run load -w @finken/e2e                                      # in-process, in-memory Postgres
LOAD_API_URL=https://staging.example/api LOAD_USERS=50 npm run load -w @finken/e2e
```

Each virtual person:
- saves a Space of sample data;
- records expenses one by one (some sent twice, as a retrying phone would);
- syncs changes and reads their transaction list.

The test then checks that every expense arrived exactly once with matching balances, and that reconciliation finds nothing. It fails on more than 1% errors, or on a p95 over 300 ms against a real server (`LOAD_P95_MS` changes it). Against a real server, raise its rate limits or spread the test over several addresses.

**Baseline**, 20 November 2026, a developer laptop, in-process (the API and an in-memory Postgres on one thread):

| | 1 person | 20 people at once |
| --- | --- | --- |
| Record one expense, median / p95 | 39 / 48 ms | 627 / 754 ms |
| Sync changes, median / p95 | 19 / 26 ms | 288 / 383 ms |
| Read all transactions, median / p95 | 27 / 31 ms | 389 / 505 ms |
| Requests | 72, none failed | 1,440, none failed |
| Expenses arriving exactly once, balances right, reconciliation | yes | yes |

With 20 people, everything queues on the single thread, so those times are the in-memory database, not the design. CI repeats the test against a real Postgres 18 with 5 people and the 300 ms limit. Measure staging the same way before launch.

**Known limits, in order of when they will matter:**
- Every save takes one database lock (so the change feed never skips). Throughput is one batch at a time across all users. Lock per Space when saves start waiting on each other.
- Every save loads its whole Space to check the money rules, so a Space with tens of thousands of transactions saves more slowly. Check only what the batch touches before Spaces get that large.
- Rate-limit counts live in each process (see [SECURITY.md](SECURITY.md)).

## Automatic checks (CI)

On every push and pull request (`.github/workflows/ci.yml`):
- **Lint, types, tests, build.**
- **Real Postgres:**
  - migrations twice;
  - API start;
  - load test;
  - reconciliation;
  - restore drill;
  - a check that the API's logs hold no tokens or emails.
- **Browser:**
  - Playwright in Chromium (`tests/browser`): the money flow, the account flow (move, download, delete), importing a statement, opening offline, and the daily reminder;
  - axe accessibility scans of 27 screens and dialogs against WCAG 2.1 AA.
- **Container:** the API image builds.

Locally: `npm run check` (lint, types, unit and API tests, builds) and `npm run test:browser` (uses the Edge or Chrome already installed; `FINKEN_BROWSER=chrome` picks Chrome).
