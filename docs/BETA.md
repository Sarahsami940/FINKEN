# Beta and launch

How Finken goes from a closed beta of 20–50 people to everyone, and what must be true before each step. Commands run against the environment's database (`DATABASE_URL`): `npm run beta -w @finken/api -- <command>` from a checkout, or `node dist/beta.js <command>` in the API's container.

## How the closed beta works

- **Invite-only.** With `BETA_ACCESS=invite` (the default in staging and production), anyone can sign in, but only people who enter an invite code can keep records. Until then Finken shows "Enter your invite code", and the API refuses everything except their profile, their data rights (download and delete), feedback and error reports.
- **Codes.** Codes look like `FNK-7KQM-2XHD`. Capitals, spaces and dashes don't matter when typing one. Each code lets in one person, or as many as `--uses` says. Only a hash of each code is stored, so a copy of the database can't be used to join. Wrong codes are limited to 10 an hour per person, which is far too few to guess one.
- **Waves.** Codes are made in numbered waves, so the beta widens in steps and problems can be traced to the people who joined in a particular wave.
- **Opening up.** Setting `BETA_ACCESS=open` and restarting the API lets everyone in. Nothing else changes, and everyone already in stays in.

## What the team sees

| What | Where | Holds |
| --- | --- | --- |
| Feedback | `beta feedback` | The person's own words, which screen they were on, the app version and their wave. Never their name or email. |
| Usage, for people who said yes | `beta report` | Counts of screens opened and features used per day. Never amounts, names, descriptions or anything typed. |
| People and errors per day | `beta report` | People seen, app errors and server errors per day, with nobody named. |
| Nightly reconciliation | `beta report` | Whether it ran each night, and how many problems it found. |
| Detail on an error | Logs, by request id | See [OPERATIONS.md](OPERATIONS.md). |

People are asked about sharing usage once, on Home, and can change their answer in Settings. Nothing is counted before they say yes. Saying no deletes what was counted. See [PRIVACY.md](PRIVACY.md).

## Commands

```bash
npm run beta -w @finken/api -- invite --wave 1 --count 20             # 20 codes, one person each
npm run beta -w @finken/api -- invite --wave 2 --count 5 --uses 10 --days 14 --note "shop owners"
npm run beta -w @finken/api -- waves                                   # codes, places used and people joined, per wave
npm run beta -w @finken/api -- revoke --wave 2                         # unused codes in wave 2 stop working
npm run beta -w @finken/api -- feedback                                # feedback not looked at yet (--all for everything)
npm run beta -w @finken/api -- mark --id 12 --status seen              # or done
npm run beta -w @finken/api -- report                                  # the launch gates; exits 1 until all pass (--json for a log line)
```

Codes are printed once. Send each to its person directly, never in a shared channel. A lost code can't be shown again, so make a new one.

## The plan

| Step | Who | Codes | Moves on when |
| --- | --- | --- | --- |
| 0. Staff | The team and their families | Wave 1, 5–10 codes | A week with no reconciliation problems and no server errors |
| 1. Closed beta | 20 people the team knows: personal, family and a few shop owners | Wave 2 | The first four gates pass |
| 2. Wider beta | Up to 50, including people the team doesn't know | Wave 3, codes with `--uses` | Every gate passes |
| 3. Launch | Everyone | `BETA_ACCESS=open` | — |

Each step starts only after the one before it has moved on. Widening is one command, and so is going back: `revoke` stops new people joining, while those already in keep their records.

## The launch gates

`beta report` checks these. Every gate must pass before `BETA_ACCESS=open`.

| Gate | Passes when | Why |
| --- | --- | --- |
| Enough people are in the beta | At least 20 have joined | Few enough to look after, but enough to find what testing missed |
| The beta has run long enough | 21 days since the first person joined | Covers a month end, with salaries, bills and budgets rolling over |
| Reconciliation ran every night and found nothing | Ran on each of the last 14 nights, with 0 problems | A wrong figure is the worst failure Finken can have |
| Errors are rare | At most 0.05 errors per person per day over the last 7 days, app and server together | About one error per person every three weeks |
| Every problem report has been looked at | No "something is wrong" report has waited more than 3 days | People who take the time to report something hear back |

The numbers are in `LAUNCH_THRESHOLDS` in `apps/api/src/beta.ts`. A change to them should be agreed and written down here first.

## Every day during the beta

1. Run `beta feedback`. Mark each report `seen` once someone owns it, and `done` once it's fixed or answered. Problems first.
2. Run `beta report` and look at the error and reconciliation gates.
3. If reconciliation found anything, stop widening the beta and follow "Nightly reconciliation" in [OPERATIONS.md](OPERATIONS.md). Don't make new codes until it's clean again.
4. If errors jump after a release, find the request ids in the logs, and roll back the web app or API as [ENVIRONMENTS.md](ENVIRONMENTS.md) describes.

## Launch day

1. `beta report` passes every gate, and the report is saved with the release notes.
2. These are done (from [SECURITY.md](SECURITY.md) and [ENVIRONMENTS.md](ENVIRONMENTS.md)):
   - the sign-in provider is chosen and set up (`AUTH_MODE=oidc`);
   - the penetration test is done;
   - the lawyer has answered [LEGAL-PAKISTAN.md](LEGAL-PAKISTAN.md);
   - backups are kept for 35 days and a restore drill has passed this month;
   - the VAPID keys are set.
3. Set `BETA_ACCESS=open` and restart the API. The invite screen stops appearing for new people.
4. For the first week, watch the error rate and the nightly reconciliation as closely as during the beta. Keep the feedback button: it stays in the app after launch.
