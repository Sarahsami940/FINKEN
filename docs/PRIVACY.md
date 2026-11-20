# Privacy

What Finken keeps about people, why, for how long, and how they get a copy or have it deleted. This is the engineering side; the privacy policy people read must be written with a lawyer (see [LEGAL-PAKISTAN.md](LEGAL-PAKISTAN.md)).

## What is kept

| Data | Where | Why |
| --- | --- | --- |
| Sign-in identity (provider subject) and email | `users` table; the provider holds passwords | To know whose records are whose |
| Name and time zone | `users` table | To greet them and to know what "today" means |
| Spaces and everything in them: accounts, categories, transactions, money owed, people they record, recurring items, budgets, goals | The Space tables | It is the service |
| Who changed each record and when | Columns on each record | Change history, sync and conflict handling |
| A copy on their device | The browser (IndexedDB) | Opening instantly and working offline |
| Request logs | The host's log store | Running and fixing the service. Only request ids, routes, status codes, timings and internal user ids; never amounts, descriptions, names, emails, tokens or IP addresses |
| Error reports from the app | Logs | Fixing bugs. Only the error message and the page; never records or anything typed |
| Devices that asked for reminders | `push_subscriptions` table | Sending the daily reminder. The browser's push address and encryption keys, removed when the person turns reminders off, logs out, deletes the account, or the push service says the device is gone |
| When the last reminder went | `users` table | Sending at most one a day |
| Metrics | Monitoring | Counts and timings by route, never by person |

**People they record** (a friend who owes them money, a supplier) are kept as names and optional phone numbers inside the person's own Space. They are never contacted by Finken and never shared.

Nothing is sold, used for advertising or shared with third parties beyond the sign-in provider and the hosting providers that run the service.

## People's rights, in the app

- **A copy of everything** (Settings → Download all your data): their profile, Spaces, every record (deleted ones marked), as JSON. `GET /v1/export`.
- **Delete the account** (Settings → Delete account, after typing DELETE). Every Space they own and everything in it is deleted from the database for good, in one go. In Spaces owned by others they are removed as a member, and their name comes off the change history. The internal user id (never the email or name) is kept for 35 days, as long as backups last, so a restored backup can be cleaned again; after that only the date and counts remain. `DELETE /v1/me`.
- **Data from before accounts** stays in the browser until they move it or remove it ("Remove moved Spaces from this browser").
- **Correcting** anything is done in the app itself.
- **Reminders** are off until the person turns them on (Settings → This device). They never contain amounts or names, because they can show on a locked screen. Reminder messages are encrypted for the device by the push service.
- **Imported files** are read on the device. Only the transactions the person chooses to import are saved; the file itself is never uploaded or kept.

Deleting the Finken account does not delete the sign-in provider's account; the screens should link to it once the provider is chosen.

## How long things are kept

These are the proposed defaults. Each needs confirming (see [LEGAL-PAKISTAN.md](LEGAL-PAKISTAN.md)).

| Data | Kept |
| --- | --- |
| Records | While the account exists. Deleted records stay as deleted (for undo, history and sync) until the account is deleted. |
| Database backups | 35 days, then gone. A deleted account disappears from backups when the last backup holding it expires. The Delete account screen says so. |
| Request and error logs | 30 days |
| Metrics | 13 months, as counts only |
| Deleted account ids | 35 days, then cleared by the nightly job |
| Account deletion dates and counts | Indefinitely (they hold no personal data) |

If a backup is ever restored, accounts deleted since that backup was taken must be deleted again before the service reopens. The `account_deletions` table keeps the internal ids of the last 35 days for exactly that, and `restore.js` names any that came back ([OPERATIONS.md](OPERATIONS.md)).

## Still to do

- The privacy policy and terms, with a lawyer.
- The 35-day backup retention set on the database host, and the 30-day log retention on the log store.
- The sign-in provider's own data handling, once chosen.
