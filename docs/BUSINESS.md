# Business Mode

A business Space uses the same records and money rules as a personal one. What it adds is the business view (More → Business, or Business in the sidebar), sharing with a team, and reports to download.

## The business view

| Tab | Shows |
| --- | --- |
| Overview | Revenue, expenses, profit, cash, and money owed each way, for the chosen period, compared with the period before |
| Customers & suppliers | Each contact's sales, purchases, and what they still owe or are owed |
| Receivables & payables | What is owed, and by how long it is overdue (current, 30, 60, 90 days, older) |
| Profit & loss | Revenue − cost of goods sold = gross profit; − operating expenses = net profit |
| Cash flow | Cash at the start + received − paid = cash at the end, month by month, and a forecast |
| Reports | The reports below, to view, download or print |

Every figure comes from recorded transactions. Money owed counts once, when it is paid, and loans are never revenue or cost. These are management summaries, not audited or tax-ready statements, and the screens say so.

## Reports

Revenue, expenses, categories, receivables, payables, profit and loss, cash flow, and the **monthly statement**: profit, cash in each account, money owed at the end of the period, and every transaction.

Each one downloads as:
- **Excel** (`.xlsx`). Amounts are real numbers in rupees, so they add up in Excel. Dates are dates. Text is stored as text, never as a formula, so a description like `=SUM(…)` can't run.
- **CSV**, for any other tool. Text that starts like a formula is prefixed with `'`.
- **Print or PDF.** The browser's print shows only the report, with the Space and period on it, and "Save as PDF" in the print dialog makes the PDF.

The reports agree with one another, and tests check it on the demo business for several months:
- the statement's profit equals the profit and loss report;
- each account's start + in − out equals its end, and the accounts add up to the summary;
- the transactions listed move the accounts by exactly that difference;
- cash at the end of today equals the balance on Home.

## Sharing a Space

With an account, the owner opens Spaces → the people icon on a Space → **Make an invite**, and chooses what the person may do:

| Role | Who it's for | Can |
| --- | --- | --- |
| Can edit | Staff, a partner, an accountant who keeps the books | Add and change records |
| Can view | An accountant or investor who only reviews | See every record and report; change nothing |

Each invite is a code like `SPC-7KQM-2XHD`, or a link that fills the code in. It works once, for 7 days, and the owner can cancel it before then. The other person enters it under Spaces → **Join a Space**, the Space appears with all its history, and Finken switches to it.

The owner can change anyone's role or remove them at any time. Someone removed loses the Space on all their devices at their next sync; what they added stays. A member can leave on their own. The owner can't leave, but can archive or delete the Space.

Someone who can only view sees a note saying so, has no Add button, and is told why if they try to change anything. The server refuses their changes whatever their app does. A change that gets through an old or modified app is undone on their device, with the reason shown.

## Not done yet

- **Handing a Space to a new owner.** Today the owner stays the owner.
- **A separate accountant role.** For example, one who can recategorise but not add money.
- **Paid plans.** Business is not a paid tier yet.
- **Business budgets by team member, and per-person activity reports.** The change history already records who made each change.
