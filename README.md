# Finken

**Your Money, Made Simple.** A personal, family and small-business money companion: simple on the surface, intelligent underneath.

This repository is the interactive prototype described in `FINKEN — BUILD PROMPT PACK.txt` (Prompts 0–11), built on the decisions in `FINKEN — MASTER PRODUCT CONTEXT.txt`. Its purpose is to validate the product experience, workflows, navigation, calculations and feature behaviour before production engineering begins.

---

## 1. Product overview

Finken answers five questions for each of the user's Spaces:

1. **Where is my money?** Accounts, balances, money owed in both directions.
2. **Where is it going?** Spending by category, trends, budgets, Insights.
3. **What's coming up?** Recurring bills and income, invoices, loan instalments, in a list, week or month calendar.
4. **What can I afford?** Safe to Spend, explained line by line.
5. **What should I do next?** "Finken noticed" insights, each with a reason, the figures and one suggested action.

Money lives in **Spaces** (Personal, Family, Business, Other). Each Space has its own accounts, categories, people and records; nothing mixes unless the user asks for an "All Spaces" view. A business Space adds **Business Mode**: customers and suppliers, receivables and payables with ageing, profit and loss, cash flow and CSV reports, all on the same records.

People can try everything as a **guest** with demo data, then create a (local, simulated) account that keeps their data.

## 2. Application architecture

- **React 19 + TypeScript (strict) + Vite**, styled with **Tailwind CSS v4** design tokens in `apps/web/src/index.css`; icons from `lucide-react`; routing with `react-router-dom`; the Plus Jakarta Sans font bundled from `@fontsource-variable`. No other runtime dependencies.
- **One Money Engine.** All figures come from pure functions in the shared `@finken/domain` package (`packages/domain/src/`). They take records and return numbers; no React, no storage, nothing cached. Every screen, report, insight and search answer calls the same functions, so they always agree. The API will run the same functions to check every save on the server.
- **One store.** `apps/web/src/data/store.ts` holds all state in memory and is the only place records are written. Every write is validated (`checkTransaction` and friends), applied to state, and saved through the storage adapter in the background. Screens subscribe with `useAppState` / `useSpaceData` (`apps/web/src/data/hooks.ts`).
- **Storage abstraction.** The store only talks to `StorageAdapter` (`apps/web/src/data/storage.ts`). `IndexedDbAdapter` is used in the browser; `MemoryAdapter` is used in tests and when IndexedDB is unavailable. An API-backed adapter will replace it in Phase 2 without touching logic or UI.
- **Auth abstraction.** `AuthService` (`apps/web/src/data/auth.ts`) with a local, prototype-only implementation.
- **Space isolation.** `useSpaceData()` returns only the active Space's records; `useSpaceRecords(id)` returns one named Space's. Cross-Space views (Transactions, Analytics, Search) filter explicitly.
- **API.** `apps/api` is a Fastify server on PostgreSQL. It stores every record in typed tables whose constraints keep money whole and every link inside its Space. It checks sign-in tokens from any standard provider, limits every read and write to the Spaces the user belongs to, and runs the same money rules as the app before any save commits. See [docs/API.md](docs/API.md).
- **Two kinds of storage, one interface.** `ApiStorage` and `ApiAuthService` (`apps/web/src/data/api.ts`) implement the same interfaces as browser storage and local sign-in, so the store, money rules and screens run unchanged on either. `SyncedStorage` (`apps/web/src/data/sync.ts`) adds an offline copy and an outbox: the app reads and writes on the device and syncs only changes, and the later edit wins when two devices change the same record. The web app still uses browser storage until a sign-in provider is chosen; `tests/e2e` runs the store against the real API, directly and through sync.
- **Code splitting.** Home, Transactions, Money and More load with the app; the other screens load the first time they are opened (`apps/web/src/App.tsx`).

```
 UI (pages, components) ──reads──▶ hooks.ts ──▶ store state
        │                                         ▲
        └──calls──▶ domain/* (pure calculations)  │
        └──writes─▶ store.ts actions ─────────────┘──saves──▶ StorageAdapter (IndexedDB | memory)
```

## 3. Folder structure

```
packages/
  domain/              @finken/domain: pure business logic shared by web and API (no React, no storage)
    src/
      types.ts           Data models, documented field by field
      money.ts           Money Engine: totals, balances, categories, refunds, money owed, integrity checks
      planning.ts        Budgets (periods, pace, projection, history), goals, recurring schedules
      upcoming.ts        Expected events for Coming up (recurring items and money owed)
      dashboard.ts       Reporting periods, fair comparisons, chart buckets, budget left today
      insights.ts        "Finken noticed" rules, grouped by topic
      analytics.ts       Monthly totals, category trends, weekday habits, budget adherence, regular payments
      health.ts          Safe to Spend and Money Health
      business.ts        Profit and loss, cash flow, ageing, customers and suppliers
      reports.ts         Business reports as tables, and CSV export
      search.ts          Search Your Money: question parser and runner
      capture.ts         "Type it": a sentence into a draft transaction
      defaults.ts        Default categories and accounts per Space type
      seed.ts            Demo data for three Spaces, generated relative to today
      dates.ts, format.ts, palette.ts
      *.test.ts          Unit tests beside the code they test
apps/
  web/                 @finken/web: the React app
    src/
      data/              State and persistence
        store.ts           Central store and every write action
        storage.ts         StorageAdapter + IndexedDB and in-memory adapters
        auth.ts            AuthService + LocalAuthService (prototype sign-in)
        hooks.ts           useAppState, useSpaceData, useSpaceRecords
        api.ts             ApiStorage and ApiAuthService: the same interfaces, backed by the API
        sync.ts            SyncedStorage: offline copy, outbox, change feed, conflicts
        scenarios.ts       The data-consistency scenarios, shared by browser and API runs
        integration.test.ts  The 12 data-consistency scenarios, run against the real store
      components/
        ui/                Design system: Button, Card, Field, Modal, Dropdown, Toast, Misc (Badge, Segmented, ProgressBar…)
        charts/            MonthlyBars, FlowBars, DonutChart, MiniBars
        money/             Add flow, transaction form, Receive/Pay and Loan forms, money-owed sheets, dashboard parts
      app/               Shell (sidebar, mobile header, bottom nav), navigation config, Space switcher
      onboarding/        Welcome, sign-up, login, guest and first-Space steps
      pages/             One file per area (PlanningPages.tsx: Budgets, Goals, Recurring; OwedPages.tsx: People, Loans, To receive, To pay)
  api/                 @finken/api: Fastify + PostgreSQL
    src/
      config.ts          Environment settings, checked at start-up
      db.ts              Database interface and the postgres.js connection
      migrate.ts         Migration runner (npm run db:migrate)
      app.ts             Routes: health, sign-in check, /v1 records, batch and changes
      auth.ts            Sign-in token checks (provider or development) and user records
      collections.ts     How each kind of record maps onto its table
      records.ts         Reads and all-or-nothing batches: permissions and money rules
      server.ts          Starts the server and shuts it down cleanly
      testing.ts         In-memory Postgres (PGlite) for tests
    migrations/        Numbered SQL files, applied in order and never edited once applied
    Dockerfile         Production image
tests/e2e/            The web store against the real API and Postgres
docs/API.md            Endpoints, sign-in, permissions and the server's checks
docs/ENVIRONMENTS.md   Development, staging and production
docker-compose.yml     Local Postgres for development
.github/               Automatic checks (CI) and dependency updates
```

## 4. Data models

All models are in `packages/domain/src/types.ts` with comments on every field. Amounts are whole numbers of paisa (cents for USD): Rs. 1,250.50 is stored as `125050`. They are positive; direction comes from the type. Dates are `YYYY-MM-DD` calendar dates with no time zone. Every money record also carries change history (`createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `version`, and `deletedAt`/`deletedBy` once deleted), written by the storage layer.

| Model | What it is | Key fields |
| --- | --- | --- |
| `User` | A guest or a local account | `name`, `email?`, `isGuest` |
| `Space` | A separate money world owned by one user | `type` (personal, business, family, other), `currency`, `status` |
| `Account` | Where money sits | `kind` (cash, bank, wallet, other), `openingBalance`, `archived?` |
| `Category` | How money is grouped, with subcategories | `kind` (expense, income), `subcategories`, `costType?` (business P&L: direct or operating) |
| `Transaction` | The only thing that moves money | `type`, `amount`, `date`, `accountId`, `toAccountId?`, `categoryId?`, `personId?`, `obligationId?`, `refundOfId?`, `recurringId?` |
| `Person` | Someone money is owed to or by | `phone?`, `email?`, `notes?`, `role?` (customer, supplier, lender, other) |
| `Obligation` | Money owed: receivable, payable, lent, borrowed | `amount`, `date`, `dueDate?`, instalments, `interestRate?`, `status` (open or written off). Outstanding is always calculated. |
| `Recurring` | An expected repeating event; never records anything by itself | `frequency`, `startDate`, `nextDueDate`, `endDate?`, `reminderDays?`, `obligationId?`, `status` |
| `Budget` | A spending limit for a period | `amount`, `frequency`, `categoryId?`, `subcategoryId?`, dates |
| `Goal` / `GoalEntry` | A savings target and money set aside for it | entries are allocations, not transactions |

Transaction types:

| Type | Meaning | Counts as |
| --- | --- | --- |
| `expense` | Money spent | Spending |
| `income` | Money received | Income |
| `transfer` | Between two accounts in one Space | Neither |
| `refund` | Money back for an expense | Lowers spending in that category; never income |
| `principal_in` | A loan received, or money you lent coming back | Neither |
| `principal_out` | Money lent, or a loan repaid | Neither |

## 5. Business rules

**Exact money, time and history** (`packages/domain/src/format.ts`, `dates.ts`, `units.ts`; `apps/web/src/data/storage.ts`)
- Money is stored and added up in whole paisa, so totals are exact. Typed amounts are read digit by digit (`parseMoney`), never through decimals, and accept at most two decimal places. A save with anything other than whole paisa is refused.
- Recorded amounts show exactly: "Rs. 1,250" or "Rs. 1,250.50". A calculated estimate that is not whole paisa, such as an average or a projection, shows to the nearest rupee. "About X a day" figures round down to a whole rupee; a goal's monthly target rounds up to one. Equal shares of a whole-rupee expense stay in whole rupees and always add up to the total.
- CSV exports give money columns in rupees with two decimals.
- "Today", and so this week and this month, is the calendar date in the user's time zone (Settings → Time zone; new users and guests take the device's zone, then Asia/Karachi if it cannot be read). Records keep their calendar dates wherever they are viewed. Timestamps are UTC.
- Every save to a money record stamps who and when, and the next version number; the original creation is kept and cannot be overwritten by the caller. Deleting marks a record deleted instead of erasing it: it disappears from every screen and figure, is kept for undo and sync, and comes back if saved again. Only resetting the demo erases records for good. Sign-in data is erased for real.
- Saves are safe to retry. Each form picks the id of the record it will create when it opens, so pressing Save twice records the money once. Marking a recurring payment paid uses that occurrence as the id, so the same occurrence can never be paid twice.
- Data saved by earlier versions is converted from rupees to paisa when the browser database upgrades to version 5, in one transaction.

**Records and Spaces**
- Every record belongs to exactly one Space, and every Space to one user. Screens read through `useSpaceData`; cross-Space views filter explicitly and hide totals when currencies differ.
- Creating an account from guest mode moves the guest's Spaces into it.
- Every save is checked: accounts and categories must belong to the Space, and linked amounts must stay within limits.

**Money**
- Transfers are never income or spending. Loan principal is never income or spending, in either direction.
- A refund lowers spending in the original category, is never income, and cannot exceed what is left of the expense. An expense with refunds cannot be deleted or reduced below them.
- Deleting a category leaves its transactions as Uncategorised. An account with transactions can only be archived.

**Money owed**
- Receivables and payables are cash basis: creating one records nothing; each payment is counted once, when the money moves.
- What is still owed is always calculated from linked transactions, so editing or deleting a payment updates it.
- Someone's share of an expense you paid comes back as a refund of that expense, not income. Shares can never exceed the expense.
- Loan interest is real spending (or income, on money lent) and never reduces what is owed; the rate is a reminder only. A loan's next due date comes from its instalments, capped at the final date.
- A person with history cannot be removed; an obligation with payments can be written off but not deleted.

**Planning**
- Budgets count expenses less refunds in their category and dates. Transfers, loans and goal savings never count. Projections use up to three earlier periods; a new budget uses a straight line and stays quiet for the first fifth of its period. Overlapping budgets are separate limits.
- Goal money is an allocation: it changes no balance and is never spending.
- Recurring items are expectations; nothing is recorded until confirmed. One linked to a loan is confirmed as a repayment. Dates are counted from the start date so month-end payments never drift.
- Coming up expects only what is outstanding; a loan paid by a recurring item appears once. Only the next occurrence can be marked paid. Snoozing hides the reminder, not the amount.

**Intelligence**
- Comparisons for a period still in progress use the same number of days of the period before. Nothing recorded yet shows no percentage.
- Insights appear only when records support them (for example category changes need at least Rs. 1,000 last month; unusual spending needs four earlier expenses in that category).
- Safe to Spend runs from today to month end: available money, less money set aside for goals, bills and regular payments, repayments and money owed falling due, what budgets still plan to spend (less bills already counted), and what dated goals still need this month. Expected income is shown, never counted.
- Money Health averages up to six factors and shows nothing until at least two can be measured. It is not a credit score.
- Search answers only from matching records; words it does not recognise are searched as text, and unknown names are reported rather than guessed.

**Business**
- Business Mode uses the same records; there is no second ledger. Revenue is income; costs are expenses less refunds; loans are never revenue or cost.
- Profit and loss: revenue − cost of goods sold = gross profit; − operating expenses = net profit. Each spending category is set as cost of goods sold or operating; moving one never changes net profit. It is a management view, not an audited or tax-compliant statement.
- Cash flow covers active accounts and always reconciles: opening + received − paid = closing.
- Ageing counts from each invoice's or bill's due date.

## 6. Current functional modules

| Module | What it does |
| --- | --- |
| Onboarding | Welcome, Get Started, Try Finken (guest with demo data), sign up, log in, first Space |
| Spaces | Switch, create, edit, archive, delete; Personal, Family, Business and Other |
| Home | Period choice (today, week, month, last month, custom); income, spent and net with fair comparisons; income and spending chart; spending by category; recent transactions; financial overview with Safe to Spend; coming up; budgets; goals; money owed; Finken noticed. Every figure opens its records. Business Spaces read Revenue, Expenses, Net position |
| Today | Spent and received today, what is due and overdue, budget left with a daily amount, recent activity, one insight |
| Add | Expense, income, transfer, receive/pay, loan; business wording in business Spaces (sale, business expense, customer payment, supplier payment, unpaid invoice, unpaid bill); "Type it" capture; refunds and splits from a transaction |
| Transactions | Search, filters (type, period, Space, category, account), sorting, grouping, detail sheet with edit, duplicate, delete and undo, notes |
| Money | Accounts and balances; Coming up (list, week, month; mark paid, snooze, edit); Budgets; Goals; Recurring; People; Loans; To receive; To pay |
| Insights | Safe to Spend (switchable lines), Money Health (six factors, change over 30 days), Analytics (monthly income and spending, categories, trends, budget adherence, regular payments, daily and weekly habits; Space and date filters), Finken noticed feed by topic |
| Business | Dashboard, customers and suppliers, receivables and payables with ageing, profit and loss with cost types, cash flow with forecast, seven reports with CSV export |
| Search Your Money | Plain-language questions ("How much did I spend on fuel last month?", "How much does Ahmed owe me?", "What are my payments this week?"), with the interpretation shown, matching records, totals and an honest empty state. Open from the sidebar, the phone header, More, or the `/` key |
| More | Spaces, Categories (with P&L cost type in business Spaces), Settings and profile, demo reset, leaving Finken |

## 7. How to run the application

Requires Node.js 24 or later. The API also needs Docker (for the local database).

**The web app**

```bash
npm install
npm run dev
```

Open http://localhost:5173 and choose **Try Finken** to explore with demo data, or **Get Started** for an empty account. The web app does not need the API yet.

**The API and database**

```bash
cp apps/api/.env.example apps/api/.env   # local settings; never commit .env
npm run db:up                            # Postgres 18 in Docker, on port 5433
npm run db:migrate                       # apply database migrations
npm run dev:api                          # http://127.0.0.1:4000/health and /ready
```

In development the web app forwards `/api/*` to the API, so the browser never needs a cross-origin request.

**Account mode** (records on the API, with an offline copy in the browser):

```bash
npm run dev:api          # or, without Docker: npm run dev:api:local (keeps data in apps/api/.local-data), or dev:api:memory (emptied when stopped)
npm run dev:account      # the web app with VITE_API_URL=/api (apps/web/.env.account)
```

Sign in with any email: until the sign-in provider is chosen, a development API hands out sign-in tokens with no password. If this browser has data saved before accounts, Finken offers to move it into the account (see [docs/API.md](docs/API.md#moving-data-saved-in-a-browser-into-an-account)). Browser data is kept per address, so run both modes on the same port (5173) to see the browser-only data from account mode.

**Checks**

```bash
npm run lint       # Biome: lint and formatting (npm run format fixes what it can)
npm run typecheck  # TypeScript, every package
npm test           # 288 tests: money rules (with CSV import and reminders), the web store, the API (with security, reconciliation, restore and push), the store against the API and through sync, and moving browser data
npm run build      # web app into apps/web/dist, API into apps/api/dist
npm run check      # all of the above, as CI runs it
```

Tests cover the Money Engine, planning, Coming up, dashboard, insights, analytics, Money Health, Safe to Spend, business calculations and reports, search, typed capture, and the 12 data-consistency scenarios (in `apps/web/src/data/integration.test.ts`): expense, income, transfer, budget use, part-settled receivable and payable, loan repayment, recurring in Coming up, goal contribution, Space isolation, edit and delete, and persistence after a refresh. Six more cover the production rules: a repeated save, a recurring payment marked paid twice, whole paisa, soft delete after a refresh, change history, and time zones. Separate tests cover reading and showing paisa, time zones around midnight and daylight saving, and the change-history storage. API tests run migrations and the health checks against PGlite, an in-memory build of real Postgres, so no database is needed to run them.

**Automatic checks.** On every push to `main` and every pull request, GitHub Actions (`.github/workflows/ci.yml`) runs lint, type-checks, tests and both builds; applies the migrations to a real Postgres 18 twice (the second run must change nothing) and checks the API reaches it; and builds the API container. Dependabot proposes dependency updates weekly.

**Lint rules switched off, and why:** non-null assertions (used deliberately after checks); assignment inside a condition (the `if ((m = text.match(…)))` idiom in the parsers); "use Math.min/max" (its automatic fix breaks date comparisons, because dates are compared as text); semantic-element suggestions (the custom radio and group controls use correct ARIA roles). Single exceptions are marked in the code with `biome-ignore` and a reason.

**Browser, accessibility and load tests**

```bash
npm run test:browser         # Playwright: the money, account and beta flows, and axe scans of 30 screens (uses the installed Edge or Chrome)
npm run load -w @finken/e2e  # 20 people at once; checks every expense arrives exactly once and every balance matches
```

**Documents:**
- [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md): settings and environments;
- [docs/API.md](docs/API.md): the API, sync and moving browser data;
- [docs/SECURITY.md](docs/SECURITY.md): threats, protections and tests;
- [docs/PRIVACY.md](docs/PRIVACY.md): what is kept, for how long, export and deletion;
- [docs/OPERATIONS.md](docs/OPERATIONS.md): monitoring, the nightly check, backups and restores, load testing;
- [docs/LEGAL-PAKISTAN.md](docs/LEGAL-PAKISTAN.md): questions for a lawyer before launch;
- [docs/BETA.md](docs/BETA.md): the closed beta, invite codes, feedback and the launch gates;
- [docs/BUSINESS.md](docs/BUSINESS.md): Business Mode, sharing a Space, and the reports;
- [docs/SIGN-IN.md](docs/SIGN-IN.md): signing in through a provider, connecting one, and trying it with the stand-in.

## 8. Known limitations

- **Storage and sign-in.** Data lives only in this browser (IndexedDB), with no server, sync or backup. Sign-in is simulated and **not production-secure**: accounts and salted password hashes sit in the same browser storage, with no email verification or password recovery.
- **Reminders** come once a day and never show amounts or names. In browser-only mode they arrive only while Finken is open. Pushed reminders (when Finken is closed) need an account and the server's VAPID keys. iPhones receive them only when Finken is installed to the home screen.
- **Import** reads CSV only (not PDF or Excel files; save those as CSV first). Each line becomes money out or in: an ATM withdrawal or a transfer between your own accounts is imported as spending, to change by hand.
- **Search** is English pattern matching, not a language model. It understands periods, categories and subcategories, people, accounts, amounts and Space names; other words become a text search. It does not answer "why" or advice questions.
- **Typed capture** is English pattern matching for amounts, dates and everyday words.
- **Money owed** is cash basis: nothing counts until money moves. Undated money owed is listed on Coming up but left out of totals and the calendar.
- **Recurring.** Deleting a transaction created by "mark paid" does not move the item's due date back.
- **Spaces.** No transfers between Spaces. People belong to one Space. Splitting covers expenses you paid.
- **Goals** are not tied to an account, so Finken cannot check the money is there.
- **Business.** No inventory, payroll processing, tax, invoicing documents or double-entry accounting. Business Spaces created before Business Mode treat every category as operating until changed.
- **Tests** cover logic, the store, the API, sync and moving data, with browser tests for the main money and account flows and accessibility scans. Many screens (budgets, goals, money owed, business) are checked for accessibility but not yet driven step by step in the browser.
- **API.** No sign-in provider is chosen yet. The web app saves to the browser unless it is built for account mode (`VITE_API_URL`), which for now signs in with a development-only, password-free sign-in. Sharing a Space with other people has no screens or endpoint yet.

## 9. Suggested next steps for production development

1. **Backend and real accounts.** Implement `StorageAdapter` and `AuthService` against the Postgres API in `apps/api`. Enforce per-user and per-Space access on the server, not only in the client.
2. **Sync and conflicts.** Add server timestamps and a sync strategy for multiple devices; keep IndexedDB as an offline cache.
3. **Server-side validation.** Run `checkTransaction` and the obligation rules on the server too; the domain modules are framework-free and can be shared.
4. **Multi-currency.** Amounts are already exact minor units; add exchange rates so All Spaces totals can mix currencies.
5. **Notifications.** Email reminders as well as push, and reminders for budgets running out.
6. **Imports.** PDF statements, recognising transfers between your own accounts, and remembering each bank's column layout.
7. **Search.** Keep the current parser for transparency, optionally adding a language-model layer that maps questions onto the same structured query, so answers still come only from records.
8. **Business.** Invoice documents, tax settings and accountant export formats.
9. **Quality.** Component and end-to-end tests (for example Playwright) for the main flows; accessibility audit; performance budget per route.
10. **PWA.** Service worker and install prompt for offline use on phones.
