# Finken API

The API keeps every user's records in PostgreSQL and checks every save with the same money rules the app uses (`packages/domain`). The web app reaches it through `ApiStorage` and `ApiAuthService` (`apps/web/src/data/api.ts`), which implement the same interfaces as browser storage, so the screens and money logic are unchanged.

## Sign-in

Every request under `/v1` needs `Authorization: Bearer <token>`. Without a valid token the answer is `401 {"error": "Sign in again."}`. Too many requests get `429` with `Retry-After` ([SECURITY.md](SECURITY.md)). Every answer has an `X-Request-Id`; a server failure answers `500 {"error": "Something went wrong. Try again.", "requestId"}`, and the details are in the log under that id.

- **`AUTH_MODE=oidc`** (staging and production): tokens come from the sign-in provider. The API checks the signature against the provider's published keys (`AUTH_JWKS_URL`), and the issuer, audience and expiry (`AUTH_ISSUER`, `AUTH_AUDIENCE`). Supabase, Clerk, Auth0 and other standard providers all work this way, so choosing one is a settings change.
- **`AUTH_MODE=dev`** (development and tests only): the API signs its own tokens with `AUTH_DEV_SECRET`, and `POST /v1/dev/token {"subject", "email"?, "name"?}` returns one. The API refuses to start in this mode when `NODE_ENV` is `staging` or `production`.

A user record is created the first time a new provider identity calls the API. The provider's subject is the link; Finken's own user id is separate.

## Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /health` | The process is running. No sign-in. |
| `GET /ready` | The database can be reached (`503` if not). No sign-in. |
| `GET /v1/me` | The signed-in user: `id`, `email`, `name`, `timeZone`. |
| `PATCH /v1/me` | Change `name` or `timeZone` (an IANA name such as `Asia/Karachi`). |
| `GET /v1/records/:collection` | Every live record of one kind in the user's Spaces. |
| `POST /v1/records/:collection/get` | `{"ids": [...]}`: those records, deleted ones included, from the user's Spaces only. |
| `POST /v1/batch` | Saves and deletes, all or nothing. See below. |
| `GET /v1/export` | Everything the person has: profile, memberships and every record of their Spaces, deleted ones marked. A JSON file (at most 10 an hour). |
| `DELETE /v1/me` | `{"confirm": "DELETE"}`: deletes the account and every Space it owns, for good ([PRIVACY.md](PRIVACY.md)). |
| `POST /v1/client-errors` | `{"message", "where"?}`: an error the web app ran into. Only the message and the page. |
| `GET /metrics` | Monitoring numbers, with `METRICS_TOKEN` ([OPERATIONS.md](OPERATIONS.md)). |
| `GET /v1/push/key` | The public key a device needs to ask for reminders. `404` when the server sends none (no VAPID keys). |
| `POST /v1/push/subscriptions` | `{"endpoint", "keys": {"p256dh", "auth"}}` from the browser's push subscription. Only the real push services are accepted (Google, Mozilla, Microsoft, Apple). |
| `DELETE /v1/push/subscriptions` | `{"endpoint"}`: this device no longer wants reminders. |
| `GET /v1/changes?since=N` | Everything changed in the user's Spaces after change number `N`, deletes included, with the next `cursor`. For sync. |

Collections: `spaces`, `accounts`, `categories`, `people`, `obligations`, `recurring`, `transactions`, `budgets`, `goals`, `goalEntries`. Records have the shapes in `packages/domain/src/types.ts`, with money in whole paisa. Each also carries `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `version` and, once deleted, `deletedAt` and `deletedBy`.

## Saving: `POST /v1/batch`

```json
{
  "puts": { "transactions": [{ "id": "…", "spaceId": "…", "type": "expense", "amount": 125050, "…": "…" }] },
  "deletes": { "budgets": ["…"] }
}
```

The app sends everything it saves in the same moment as one batch. The server:

1. **Checks each record's shape**: known kinds and statuses, text lengths, real dates, money as whole paisa. Failure: `400`.
2. **Checks permission.** The user must be an owner or editor of every Space the batch touches. Only the owner can delete a Space. A record's id can never be reused to overwrite a record in another Space, and records cannot move between Spaces. Failure: `403`, with the same message whether the record is someone else's or does not exist, so nothing leaks.
3. **Writes**, in one database transaction. Ids are chosen by the app, so a retried batch finds its records already there. Saving a record exactly as stored changes nothing, not even its version. The same record twice in one batch: the last copy wins. Deleting marks records deleted, and deleting one that is already deleted does nothing.
4. **Runs the money rules** on the Spaces as they will be after the batch:
   - each saved transaction passes `checkTransaction` (accounts and categories from its Space, refunds within what is left, payments within what is owed, and so on);
   - transactions and money owed are in their Space's currency;
   - money owed never drops below what has been paid or handed over, and shares never add up to more than the expense;
   - no goal has more taken out than was put in;
   - nothing still in use points at a record being deleted.
   Failure: `422`, with the message the app would show, plus `collection` and `id`.
5. **Commits.** The database then checks its own rules (below). If any of them fails, nothing in the batch is saved.

The creator of a new Space becomes its owner.

A batch may carry `editedAt`, the moment the changes were made on the device. See the next section.

The answer is `{ "written", "deleted", "superseded" }`. `superseded` lists records the batch did not change because a later edit was already stored.

## Sync, offline use and conflicts

The web app's `SyncedStorage` (`apps/web/src/data/sync.ts`) keeps a copy of the account's records on the device:

- **Reads** come from that copy, so the app opens instantly and works offline.
- **Writes** change the copy at once. They also go into an **outbox** saved on the device, one entry per action, so nothing is lost if the app closes while offline.
- **Syncing** sends the outbox in order, then asks `GET /v1/changes?since=N` for only what changed since the last sync, deletes included.
  - It runs straight after each change, every 30 seconds, and when the connection or the tab comes back.
  - A change still waiting in the outbox is never overwritten by an older one arriving from the server.
  - A failed connection is never treated as a refusal: the outbox simply waits.

**Conflicts: the later edit wins.**
- Every record keeps `editedAt`, the time of its last edit on the device that made it.
- When two devices change the same record, the server keeps the later edit, whichever reaches it first. The other device takes the winning version on its next sync. This applies to deletes too: a delete made before a later edit is ignored.
- The server never accepts an edit time in the future, so a device with a wrong clock cannot win for good.

**Every change still has to pass the money rules.** Say two devices each refund the rest of the same expense while offline. The server accepts the first refund and refuses the second. The refused device then:
- undoes the change on its copy and puts back the server's version;
- shows the reason: "A change made earlier could not be saved: That expense has already been refunded in full."

Balances are always worked out from the stored transactions, so they can never be left half-updated.

**The change feed never skips a change.** Batches are written one at a time, so change numbers are handed out in the order batches commit. This uses one database lock, which is simple and plenty for launch; locking per Space would scale further.

## Moving data saved in a browser into an account

Before accounts lived on the server, Finken saved everything in the browser: a guest's Spaces, and the Spaces of accounts made on that device. `LocalDataMover` (`apps/web/src/data/migration.ts`) moves chosen Spaces into the signed-in account. Right after signing in, the app offers it if the browser has any (Settings has it too).

- **One Space at a time, all or nothing.** Each Space and everything in it goes up as one `POST /v1/batch`, so the server checks the whole Space with the usual money rules and keeps all of it or none. A Space with more than 5,000 records of one kind is not moved automatically; the person is asked to contact support.
- **Checked once it arrives.** Every record is read back and compared with the browser's copy, field by field, and the Space's total balance is worked out from both. Only a Space that matches is marked as moved (`moved:<spaceId>` in the browser's settings), and the screen says what was moved and what its balance is.
- **Safe to repeat.** Ids stay the same, so a retry never makes a second copy, and a Space already moved is skipped. The batch carries the time of the Space's latest edit in the browser as `editedAt`, so if the account changed a record after an earlier attempt (say the answer was lost on the way), the account's newer version is kept.
- **Whose data it is.** A guest's Spaces can be moved by whoever is signed in on that browser, as the guest could always open them. Spaces of an account made on the device need that account's password first. A Space already moved to one account cannot be moved into another: the browser's mark says so, and the server refuses, since the ids belong to a Space in another account.
- **When the server refuses.** Nothing in that Space is moved, and the message names the record ("Lunch on 2025-01-02: 900 of this has already been refunded…"), so the person can fix it in the browser and try again. A record saved in a form the account cannot take is named too, with a suggestion to contact support.
- **Nothing is deleted** from the browser unless the person asks ("Remove moved Spaces from this browser"), and only Spaces marked as moved can be removed. They can also save a backup file of everything first.

In account mode, the account's own offline copy lives in a separate browser database (`finken-account`), which is cleared on logging out. Logging out warns first if changes have not been sent yet. The last known profile is kept with it, so Finken opens without a connection or when the server is down.

## What the database enforces on its own

`apps/api/migrations/0002_money_records.sql`:

- money columns are whole numbers within JavaScript's exact range, and positive where the model says so;
- kinds, types and statuses are one of the known values;
- a transfer has a destination and only a transfer does, and a refund points at the expense it refunds;
- every link (account, category, person, loan, refund, recurring item, goal) points at a record in the **same Space**. This uses composite foreign keys on `(space_id, id)`, checked at commit, so a batch can save records that point at each other in any order.

## Permissions

`space_members` links users to Spaces with a role: `owner`, `editor` or `viewer`. Viewers can read but not write. Every read and write is filtered through this table. Sharing a Space with someone (adding members) has no endpoint yet; the table is ready for it.

## Not done yet

- Choosing the sign-in provider, and the sign-in screens in the web app (`ApiAuthService` is ready for the provider's token).
- Turning account mode on for real users: it needs the provider's sign-in. Until then account mode (`VITE_API_URL`) signs in with a development-only sign-in that a staging or production API refuses.
- Sync state is shown in Settings only; there is no indicator elsewhere on screen yet.
- Rate-limit counts are kept per API process; move them to a shared store before running several instances ([SECURITY.md](SECURITY.md)).
- Reading a large Space in pages, and checking a batch without loading the whole Space: before Spaces get very large.
