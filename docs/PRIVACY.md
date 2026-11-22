# Privacy

What Finken keeps about people, why, for how long, and how they get a copy or have it deleted. This is the engineering side; the privacy policy people read must be written with a lawyer (see [LEGAL-PAKISTAN.md](LEGAL-PAKISTAN.md)).

## What is kept

| Data | Where | Why |
| --- | --- | --- |
| Email and sign-in identity | `users` table | To know whose records are whose, and where to send password reset links |
| Password | Only a scrypt hash in the `users` table: it cannot be turned back into the password, by anyone | Signing in |
| Signed-in devices | `sessions`: when each started and was last used, and a hash of its refresh token. No IP address, device name or location | Keeping people signed in, and signing devices out |
| Emailed links | `email_tokens`: hashes only, removed with the account | Confirming the email and resetting the password |
| Name and time zone | `users` table | To greet them and to know what "today" means |
| Spaces and everything in them: accounts, categories, transactions, money owed, people they record, recurring items, budgets, goals | The Space tables | It is the service |
| Who changed each record and when | Columns on each record | Change history, sync and conflict handling |
| A copy on their device | The browser (IndexedDB) | Opening instantly and working offline |
| Request logs | The host's log store | Running and fixing the service. Only request ids, routes, status codes, timings and internal user ids; never amounts, descriptions, names, emails, tokens or IP addresses |
| Error reports from the app | Logs | Fixing bugs. Only the error message and the page; never records or anything typed |
| Devices that asked for reminders | `push_subscriptions` table | Sending the daily reminder. The browser's push address and encryption keys, removed when the person turns reminders off, logs out, deletes the account, or the push service says the device is gone |
| When the last reminder went | `users` table | Sending at most one a day |
| Metrics | Monitoring | Counts and timings by route, never by person |
| Who is in each Space, and their role | `space_members` | Sharing a Space. Members see each other's names; only the owner sees members' emails |
| Space invites | `space_invites`: a hash of the code, the role, who made it, and when it was used | Letting one person in. Removed with the Space or with the account that made it |
| Beta invite | `users` table: when they joined and their wave. `beta_invites`: a hash of each code, never the code | Running the closed beta |
| Feedback they send | `feedback` table: their words, the screen, the app version | Fixing what they report. The team reads it without their name or email |
| Usage, only if they said yes | `usage_events` table: per day, how often each screen and feature was used | Seeing what to improve. Fixed event names only, never amounts, names, descriptions or anything typed |
| Their answer about usage | `users` table | Asking only once |
| People and errors per day | `daily_health` table: counts only, nobody named; `users.last_seen_on` so each person counts once a day | Knowing whether Finken is healthy enough to launch |

**People they record** (a friend who owes them money, a supplier) are kept as names and optional phone numbers inside the person's own Space. They are never contacted by Finken and never shared.

Nothing is sold, used for advertising or shared with third parties beyond the sign-in provider and the hosting providers that run the service.

## People's rights, in the app

- **A copy of everything** (Settings → Download all your data): their profile, Spaces, every record (deleted ones marked), as JSON. `GET /v1/export`.
- **Delete the account** (Settings → Delete account, after typing DELETE). Every Space they own and everything in it is deleted from the database for good, in one go. In Spaces owned by others they are removed as a member, and their name comes off the change history. The internal user id (never the email or name) is kept for 35 days, as long as backups last, so a restored backup can be cleaned again; after that only the date and counts remain. `DELETE /v1/me`.
- **Data from before accounts** stays in the browser until they move it or remove it ("Remove moved Spaces from this browser").
- **Correcting** anything is done in the app itself.
- **Reminders** are off until the person turns them on (Settings → This device). They never contain amounts or names, because they can show on a locked screen. Reminder messages are encrypted for the device by the push service.
- **Sharing a Space** is the owner's choice, one person at a time. Everyone in a Space sees all of its records. A member removed from a Space loses it on their devices at their next sync. Records they added stay in the Space, which belongs to its owner. When the owner deletes their account, the Space and everything in it go for every member.
- **Usage sharing** is off until they say yes. They are asked once, on Home, and can change it any time in Settings → The Finken beta. Saying no deletes what was counted. Their feedback, usage counts and answer are in their download, and are deleted with their account.
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
| Usage counts | 180 days, then deleted by the nightly job; at once if they say no |
| Feedback | While the account exists |
| People and errors per day | Indefinitely (counts only, nobody named) |
| Account deletion dates and counts | Indefinitely (they hold no personal data) |

If a backup is ever restored, accounts deleted since that backup was taken must be deleted again before the service reopens. The `account_deletions` table keeps the internal ids of the last 35 days for exactly that, and `restore.js` names any that came back ([OPERATIONS.md](OPERATIONS.md)).

## Still to do

- The privacy policy and terms, with a lawyer.
- The 35-day backup retention set on the database host, and the 30-day log retention on the log store.
- The sign-in provider's own data handling, once chosen.
