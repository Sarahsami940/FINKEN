import {
  type AmountSign,
  type ColumnMap,
  type DateFormat,
  detectColumns,
  detectDateFormat,
  MAX_IMPORT_ROWS,
  type PlannedLine,
  parseCsv,
  planImport,
  readRows,
} from '@finken/domain/csvImport';
import { formatDay } from '@finken/domain/dates';
import { formatMoney } from '@finken/domain/format';
import type { ID } from '@finken/domain/types';
import { CircleAlert, FileUp } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Select } from '../components/ui/Field';
import { Badge, PageHeader } from '../components/ui/Misc';
import { useToast } from '../components/ui/Toast';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import { track } from '../data/usage';
import { BackLink } from './MoneyPages';

/** Lines shown in the preview; all of them are imported. */
const PREVIEW = 100;

interface Loaded {
  name: string;
  rows: string[][];
  headerRow: number;
}

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'DMY', label: 'Day first (25/11/2026)' },
  { value: 'MDY', label: 'Month first (11/25/2026)' },
  { value: 'YMD', label: 'Year first (2026-11-25)' },
];

const SIGNS: { value: AmountSign; label: string }[] = [
  { value: 'negative-is-out', label: 'Minus means money out, plus means money in' },
  { value: 'all-out', label: 'Every line is money out (spending)' },
  { value: 'all-in', label: 'Every line is money in' },
];

function ColumnSelect({
  label,
  value,
  headers,
  onChange,
  optional,
}: {
  label: string;
  value: number | undefined;
  headers: string[];
  onChange: (i: number | undefined) => void;
  optional?: boolean;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value ?? -1} onChange={(e) => onChange(Number(e.target.value) < 0 ? undefined : Number(e.target.value))}>
          {optional && <option value={-1}>None</option>}
          {headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are identified by position
            <option key={i} value={i}>
              {h || `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function ImportPage() {
  const { spaces, activeSpaceId, accounts, categories, transactions } = useAppState();
  const toast = useToast();
  const fileId = useId();
  const space = spaces.find((s) => s.id === activeSpaceId);
  const spaceAccounts = accounts.filter((a) => a.spaceId === activeSpaceId && !a.archived);
  const spaceCategories = categories.filter((c) => c.spaceId === activeSpaceId);
  const [file, setFile] = useState<Loaded | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnMap | null>(null);
  const [dateFormat, setDateFormat] = useState<DateFormat>('DMY');
  const [ambiguous, setAmbiguous] = useState(false);
  const [sign, setSign] = useState<AmountSign>('negative-is-out');
  const [accountId, setAccountId] = useState<ID>('');
  const [chosen, setChosen] = useState<Record<ID, ID | ''>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; skipped: number; account: string } | null>(null);
  const account = spaceAccounts.find((a) => a.id === accountId) ?? spaceAccounts[0];

  async function load(f: File | undefined) {
    setFileError(null);
    setDone(null);
    setError(null);
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return setFileError('That file is larger than 10 MB. Export a shorter period and try again.');
    const rows = parseCsv(await f.text());
    const found = detectColumns(rows);
    if (!found.columns) {
      setFile({ name: f.name, rows, headerRow: rows.length ? 0 : -1 });
      setColumns(rows.length ? { date: 0, description: 1, amount: 2 } : null);
      if (!rows.length) return setFileError('That file is empty, or not a CSV file.');
      setFileError('Finken could not tell which column is which. Choose them below.');
    } else {
      setFile({ name: f.name, rows, headerRow: found.headerRow });
      setColumns(found.columns);
    }
    const header = found.columns ? found.headerRow : 0;
    const dateCol = found.columns?.date ?? 0;
    const detected = detectDateFormat(rows.slice(header + 1).map((r) => r[dateCol] ?? ''));
    setDateFormat(detected.format);
    setAmbiguous(detected.ambiguous);
    // A single column of only positive numbers is usually a hand-kept list of spending.
    const amounts = rows.slice(header + 1).map((r) => r[found.columns?.amount ?? 2] ?? '');
    setSign(found.columns?.amount !== undefined && !found.columns.direction && amounts.every((a) => !/^\s*[-(]|-\s*$|\bdr\b/i.test(a)) ? 'all-out' : 'negative-is-out');
    setChosen({});
  }

  const plan = useMemo(() => {
    if (!file || !columns || !account) return null;
    const lines = readRows(file.rows, file.headerRow, { columns, dateFormat, sign });
    return planImport(lines, { accountId: account.id, categories: spaceCategories, transactions: transactions.filter((t) => t.spaceId === activeSpaceId) });
  }, [file, columns, dateFormat, sign, account, spaceCategories, transactions, activeSpaceId]);

  const categoryFor = (l: PlannedLine) => (l.id in chosen ? chosen[l.id] || undefined : l.categoryId);

  function runImport() {
    if (!plan || !account || !activeSpaceId) return;
    setError(null);
    const lines = plan.ready.map((l) => {
      const categoryId = categoryFor(l);
      return { ...l, categoryId, subcategoryId: categoryId === l.categoryId ? l.subcategoryId : undefined };
    });
    const result = store.importTransactions(activeSpaceId, account.id, lines);
    if (!result.ok) return setError(result.error);
    setDone({ added: result.added, skipped: result.skipped, account: account.name });
    toast(`${result.added} ${result.added === 1 ? 'transaction' : 'transactions'} imported`);
    track('import:done');
    setFile(null);
  }

  if (!space) return null;
  const headers = file ? (file.rows[file.headerRow] ?? []).map((h, i) => h || `Column ${i + 1}`) : [];
  const split = columns?.debit !== undefined;
  const currency = space.currency;

  return (
    <div>
      <BackLink to="/more">More</BackLink>
      <PageHeader title="Import from a file" subtitle={`Add transactions to ${space.name} from a bank or wallet statement, or a spreadsheet saved as CSV.`} />
      <div className="grid max-w-4xl gap-4">
        {done && (
          <Card className="border-positive/30 bg-positive-soft/40">
            <p role="status" className="font-bold text-ink">
              {done.added} {done.added === 1 ? 'transaction was' : 'transactions were'} added to {done.account}.{done.skipped ? ` ${done.skipped} were already there.` : ''}
            </p>
            <Link to="/transactions" className="mt-2 inline-block text-sm font-bold text-accent hover:text-accent-strong">
              See them in Transactions
            </Link>
          </Card>
        )}

        <Card>
          <CardHeader title="1. Choose the file" subtitle="Most banks and wallets can export a statement as CSV. In Excel or Google Sheets, use Save as or Download as CSV." />
          <label
            htmlFor={fileId}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-card border-2 border-dashed border-line px-4 py-8 text-center hover:border-accent/60 hover:bg-canvas focus-within:border-accent"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void load(e.dataTransfer.files[0]);
            }}
          >
            <FileUp aria-hidden className="size-6 text-ink-3" />
            <span className="font-bold text-ink">{file ? file.name : 'Choose a CSV file, or drop it here'}</span>
            <span className="text-sm text-ink-3">Nothing is added until you check it and press Import.</span>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {fileError && (
            <p role="alert" className="mt-3 text-sm font-semibold text-negative">
              {fileError}
            </p>
          )}
        </Card>

        {file && columns && (
          <Card>
            <CardHeader title="2. Check how it reads the file" subtitle="Finken guessed these from the file. Change anything that is wrong; the preview updates." />
            {spaceAccounts.length === 0 ? (
              <p className="text-sm text-negative">Add an account to this Space first.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Add to account">
                  {(id) => (
                    <Select id={id} value={account?.id} onChange={(e) => setAccountId(e.target.value)}>
                      {spaceAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="Dates are written"
                  hint={ambiguous ? 'Every date in this file could be read either way, so day first was chosen. Check a date in the preview.' : undefined}
                >
                  {(id) => (
                    <Select id={id} value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
                      {DATE_FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <ColumnSelect label="Date column" value={columns.date} headers={headers} onChange={(i) => setColumns({ ...columns, date: i ?? 0 })} />
                <ColumnSelect
                  label="Description column"
                  value={columns.description < 0 ? undefined : columns.description}
                  headers={headers}
                  optional
                  onChange={(i) => setColumns({ ...columns, description: i ?? -1 })}
                />
                <Field label="Amounts are in">
                  {(id) => (
                    <Select
                      id={id}
                      value={split ? 'split' : 'one'}
                      onChange={(e) =>
                        setColumns(
                          e.target.value === 'split'
                            ? { date: columns.date, description: columns.description, debit: columns.amount ?? 0, credit: columns.amount ?? 0 }
                            : { date: columns.date, description: columns.description, amount: columns.debit ?? 0 },
                        )
                      }
                    >
                      <option value="one">One column</option>
                      <option value="split">Separate money out and money in columns</option>
                    </Select>
                  )}
                </Field>
                {split ? (
                  <>
                    <ColumnSelect label="Money out column" value={columns.debit} headers={headers} onChange={(i) => setColumns({ ...columns, debit: i ?? 0 })} />
                    <ColumnSelect label="Money in column" value={columns.credit} headers={headers} onChange={(i) => setColumns({ ...columns, credit: i ?? 0 })} />
                  </>
                ) : (
                  <>
                    <ColumnSelect label="Amount column" value={columns.amount} headers={headers} onChange={(i) => setColumns({ ...columns, amount: i ?? 0 })} />
                    {columns.direction === undefined && (
                      <Field label="The amounts mean">
                        {(id) => (
                          <Select id={id} value={sign} onChange={(e) => setSign(e.target.value as AmountSign)}>
                            {SIGNS.map((s) => (
                              <option key={s.value} value={s.value}>
                                {s.label}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    )}
                  </>
                )}
              </div>
            )}
          </Card>
        )}

        {plan && account && (
          <Card>
            <CardHeader
              title="3. Check and import"
              subtitle={`${plan.ready.length} to add: ${formatMoney(plan.moneyOut, currency)} out and ${formatMoney(plan.moneyIn, currency)} in.${plan.duplicates ? ` ${plan.duplicates} already in ${account.name}, so left out.` : ''}${plan.problems ? ` ${plan.problems} cannot be read.` : ''}`}
            />
            {plan.lines.length > MAX_IMPORT_ROWS && (
              <p role="alert" className="mb-3 text-sm font-semibold text-negative">
                This file has more than {MAX_IMPORT_ROWS.toLocaleString('en')} lines. Split it and import each part.
              </p>
            )}
            <div className="-mx-5 overflow-x-auto sm:-mx-6">
              <table className="w-full min-w-[640px] text-sm">
                <caption className="sr-only">Lines in {file?.name}</caption>
                <thead>
                  <tr className="border-b border-line text-left text-[13px] text-ink-3">
                    <th scope="col" className="px-5 py-2 font-semibold sm:px-6">
                      Line
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      Date
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      Description
                    </th>
                    <th scope="col" className="py-2 text-right font-semibold">
                      Amount
                    </th>
                    <th scope="col" className="px-5 py-2 font-semibold sm:px-6">
                      Category or status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {plan.lines.slice(0, PREVIEW).map((l) => (
                    <tr key={l.line} className={cn(l.duplicate && 'text-ink-3')}>
                      <td className="px-5 py-2 text-ink-3 sm:px-6">{l.line}</td>
                      <td className="whitespace-nowrap py-2 pr-3">{l.date ? `${formatDay(l.date)} ${l.date.slice(0, 4)}` : ''}</td>
                      <td className="max-w-[260px] truncate py-2 pr-3">{l.description}</td>
                      <td className={cn('money whitespace-nowrap py-2 pr-3 text-right font-semibold', l.type === 'income' && !l.duplicate && 'text-positive')}>
                        {l.amount ? `${l.type === 'expense' ? '−' : '+'}${formatMoney(l.amount, currency)}` : ''}
                      </td>
                      <td className="px-5 py-2 sm:px-6">
                        {l.problem ? (
                          <span className="inline-flex items-center gap-1.5 text-negative">
                            <CircleAlert aria-hidden className="size-3.5" />
                            {l.problem}
                          </span>
                        ) : l.duplicate ? (
                          <Badge>Already in {account.name}</Badge>
                        ) : (
                          <select
                            aria-label={`Category for line ${l.line}`}
                            className="h-9 max-w-[200px] rounded-control border border-line bg-surface px-2 text-sm text-ink"
                            value={categoryFor(l) ?? ''}
                            onChange={(e) => setChosen({ ...chosen, [l.id]: e.target.value })}
                          >
                            <option value="">No category</option>
                            {spaceCategories
                              .filter((c) => c.kind === l.type)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.lines.length > PREVIEW && (
              <p className="mt-3 text-[13px] text-ink-3">
                Showing the first {PREVIEW} of {plan.lines.length} lines. All of them are imported.
              </p>
            )}
            {error && (
              <p role="alert" className="mt-4 rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button variant="primary" size="lg" disabled={plan.ready.length === 0 || plan.lines.length > MAX_IMPORT_ROWS} onClick={runImport}>
                {plan.ready.length ? `Import ${plan.ready.length} ${plan.ready.length === 1 ? 'transaction' : 'transactions'}` : 'Nothing new to import'}
              </Button>
              <p className="text-[13px] text-ink-3">All are added together, or none if any breaks a rule. Importing the same file again adds nothing.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
