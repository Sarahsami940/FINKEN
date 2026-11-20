/**
 * Demo data. Generated relative to today so dashboards always have a
 * meaningful current month, and seeded with a fixed PRNG so the same day
 * always produces the same records. Nothing here is a hardcoded total —
 * every figure in the UI is calculated from these transactions.
 */
import { addDays, addMonths, monthRange, parseISODate, today, toISODate } from './dates';
import { defaultCategories } from './defaults';
import type {
  Account,
  Budget,
  Category,
  Goal,
  GoalEntry,
  ID,
  ISODate,
  Obligation,
  ObligationKind,
  Person,
  Recurring,
  Space,
  SpaceType,
  Transaction,
  TransactionType,
} from './types';
import { type MoneyCollection, recordToMinor } from './units';

export interface SeedData {
  spaces: Space[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  recurring: Recurring[];
  people: Person[];
  obligations: Obligation[];
  budgets: Budget[];
  goals: Goal[];
  goalEntries: GoalEntry[];
  /** Demo Space id for each Space type. */
  spaceIdByType: Partial<Record<SpaceType, ID>>;
}

const MONTHS_OF_HISTORY = 6;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  transactions: Transaction[] = [];
  people: Person[] = [];
  obligations: Obligation[] = [];
  private n = 0;
  constructor(
    private spaceId: ID,
    private currency: string,
    private now: ISODate,
    readonly rand: () => number,
  ) {}

  /** Random integer in [min, max], rounded to `step`. */
  amount(min: number, max: number, step = 50) {
    return Math.round((min + this.rand() * (max - min)) / step) * step;
  }

  pick<T>(items: T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  add(
    type: TransactionType,
    date: ISODate,
    amount: number,
    description: string,
    account: string,
    category?: string,
    sub?: string,
    toAccount?: string,
    links: Partial<Pick<Transaction, 'personId' | 'obligationId' | 'refundOfId'>> = {},
  ): ID | undefined {
    if (date > this.now) return undefined; // never seed the future
    const id = `${this.spaceId}:t${this.n++}`;
    const stamp = `${date}T09:00:00.000Z`;
    this.transactions.push({
      id,
      spaceId: this.spaceId,
      type,
      amount,
      currency: this.currency,
      categoryId: category ? `${this.spaceId}:${category}` : undefined,
      subcategoryId: category && sub ? `${this.spaceId}:${category}:${sub}` : undefined,
      date,
      description,
      accountId: `${this.spaceId}:${account}`,
      toAccountId: toAccount ? `${this.spaceId}:${toAccount}` : undefined,
      ...links,
      createdAt: stamp,
      updatedAt: stamp,
      status: 'confirmed',
    });
    return id;
  }

  person(key: string, name: string, notes?: string, role?: Person['role']): ID {
    const id = `${this.spaceId}:p-${key}`;
    this.people.push({ id, spaceId: this.spaceId, name, notes, role, createdAt: `${this.now}T08:00:00.000Z` });
    return id;
  }

  /** Money owed. Settlements and loan hand-overs are added separately with `add`. */
  owe(
    key: string,
    kind: ObligationKind,
    personId: ID,
    title: string,
    amount: number,
    date: ISODate,
    extra: Partial<Pick<Obligation, 'dueDate' | 'sourceTransactionId' | 'notes' | 'interestRate' | 'instalmentAmount' | 'instalmentFrequency'>> = {},
  ): ID {
    const id = `${this.spaceId}:o-${key}`;
    const stamp = `${date}T09:00:00.000Z`;
    this.obligations.push({
      id,
      spaceId: this.spaceId,
      kind,
      personId,
      title,
      amount,
      currency: this.currency,
      date,
      ...extra,
      status: 'open',
      createdAt: stamp,
      updatedAt: stamp,
    });
    return id;
  }
}

/** Date in the month `offset` months before now, clamped to the month's length. */
function dayIn(now: ISODate, offset: number, day: number): ISODate {
  const range = monthRange(now, -offset);
  const last = parseISODate(range.to).getDate();
  const d = parseISODate(range.from);
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

/** `count` distinct days of the month, spread out. */
function spreadDays(rand: () => number, count: number): number[] {
  const days = new Set<number>();
  while (days.size < count) days.add(1 + Math.floor(rand() * 28));
  return [...days].sort((a, b) => a - b);
}

/** First occurrence of `day` of the month strictly after `now`. */
function nextDay(now: ISODate, day: number): ISODate {
  const thisMonth = dayIn(now, 0, day);
  return thisMonth > now ? thisMonth : addMonths(thisMonth, 1);
}

const planStamp = (now: ISODate) => `${addMonths(now, -MONTHS_OF_HISTORY)}T08:00:00.000Z`;

function budget(spaceId: ID, now: ISODate, key: string, name: string, amount: number, category?: string, sub?: string): Budget {
  return {
    id: `${spaceId}:b-${key}`,
    spaceId,
    name,
    amount,
    categoryId: category ? `${spaceId}:${category}` : undefined,
    subcategoryId: category && sub ? `${spaceId}:${category}:${sub}` : undefined,
    frequency: 'monthly',
    startDate: monthRange(now, -(MONTHS_OF_HISTORY - 1)).from,
    createdAt: planStamp(now),
  };
}

/** A goal with one contribution in each of the last `months` months, plus an optional starting amount. */
function goal(
  spaceId: ID,
  now: ISODate,
  key: string,
  name: string,
  icon: string,
  target: number,
  description: string,
  plan: { start?: number; monthly: number; months: number; targetInMonths?: number },
): { goal: Goal; entries: GoalEntry[] } {
  const id = `${spaceId}:g-${key}`;
  const entries: GoalEntry[] = [];
  const add = (amount: number, date: ISODate, note?: string) => {
    if (date > now) return;
    entries.push({ id: `${id}:e${entries.length}`, spaceId, goalId: id, amount, date, note, createdAt: `${date}T09:00:00.000Z` });
  };
  if (plan.start) add(plan.start, dayIn(now, plan.months, 1), 'Already saved');
  for (let m = plan.months - 1; m >= 0; m--) add(plan.monthly, dayIn(now, m, 2));
  return {
    goal: {
      id,
      spaceId,
      name,
      icon,
      targetAmount: target,
      targetDate: plan.targetInMonths ? addMonths(now, plan.targetInMonths) : undefined,
      description,
      createdAt: planStamp(now),
    },
    entries,
  };
}

function seedPersonal(spaceId: ID, now: ISODate) {
  const b = new Builder(spaceId, 'PKR', now, mulberry32(11));
  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    const d = (day: number) => dayIn(now, m, day);
    // Dining runs a little hotter in the current month, which gives the
    // "Finken noticed" card a real movement to report.
    const diningBoost = m === 0 ? 1.35 : 1;

    b.add('income', d(1), 185000, 'Monthly salary', 'bank', 'salary');
    if (b.rand() > 0.45) b.add('income', d(b.amount(12, 24, 1)), b.amount(18000, 42000, 500), 'Design project payment', 'bank', 'freelance');
    b.add('transfer', d(2), 20000, 'ATM withdrawal', 'bank', undefined, undefined, 'cash');
    b.add('transfer', d(4), 6000, 'Wallet top-up', 'bank', undefined, undefined, 'wallet');

    b.add('expense', d(3), 45000, 'House rent', 'bank', 'housing', 'rent');
    b.add('expense', d(5), 1500, 'Mobile package', 'wallet', 'bills', 'mobile');
    b.add('expense', d(8), 4500, 'Internet bill', 'bank', 'bills', 'internet');
    b.add('expense', d(10), b.amount(9500, 16500, 100), 'Electricity bill', 'bank', 'bills', 'electricity');
    b.add('expense', d(15), 1100, 'Streaming subscription', 'bank', 'entertainment');

    for (const day of spreadDays(b.rand, 4)) {
      b.add('expense', d(day), b.amount(3800, 7200), b.pick(['Weekly groceries', 'Imtiaz groceries', 'Fruit and vegetables', 'Metro groceries']), 'bank', 'food', 'groceries');
    }
    for (const day of spreadDays(b.rand, 5)) {
      b.add(
        'expense',
        d(day),
        Math.round((b.amount(900, 3200) * diningBoost) / 50) * 50,
        b.pick(['Family dinner', 'Lunch with colleagues', 'Chai and snacks', 'BBQ night', 'Cafe']),
        'cash',
        'food',
        'dining-out',
      );
    }
    for (const day of spreadDays(b.rand, 2)) {
      b.add('expense', d(day), b.amount(700, 1900), b.pick(['Foodpanda order', 'Pizza delivery']), 'wallet', 'food', 'delivery');
    }
    for (const day of spreadDays(b.rand, 4)) {
      b.add('expense', d(day), b.amount(2800, 4600, 100), 'Fuel', 'bank', 'transport', 'fuel');
    }
    for (const day of spreadDays(b.rand, 3)) {
      b.add('expense', d(day), b.amount(350, 900), b.pick(['Careem ride', 'inDrive ride', 'Rickshaw']), 'cash', 'transport', 'ride-hailing');
    }
    for (const day of spreadDays(b.rand, 2)) {
      b.add('expense', d(day), b.amount(2500, 9500, 100), b.pick(['Daraz order', 'Clothes', 'Home accessories', 'Shoes']), 'bank', 'shopping');
    }
    if (b.rand() > 0.4) b.add('expense', d(b.amount(6, 26, 1)), b.amount(1500, 5200, 100), b.pick(['Pharmacy', 'Doctor visit', 'Lab tests']), 'cash', 'health');
    if (b.rand() > 0.5) b.add('expense', d(b.amount(14, 27, 1)), b.amount(1200, 3800, 100), b.pick(['Cinema', 'Weekend outing']), 'cash', 'entertainment');
    if (m % 3 === 1) b.add('expense', d(18), 12500, 'Online course', 'bank', 'education');
  }

  // A cash gift paid into the bank: a deposit, which is a movement and not income.
  b.add('transfer', dayIn(now, 2, 20), 15000, 'Cash deposit', 'cash', undefined, undefined, 'bank');

  // A purchase that was partly returned. The refund lowers Shopping; it is not income.
  const jacket = b.add('expense', dayIn(now, 1, 9), 14500, 'Winter jacket and shoes', 'bank', 'shopping');
  if (jacket) b.add('refund', dayIn(now, 1, 16), 5500, 'Shoes returned', 'bank', 'shopping', undefined, undefined, { refundOfId: jacket });

  // A shared cost: the full price is one expense, and a friend's share comes back against it.
  const sana = b.person('sana', 'Sana Malik', 'Friend');
  const tickets = b.add('expense', dayIn(now, 1, 21), 24000, 'Concert tickets for two', 'bank', 'entertainment');
  if (tickets) {
    const share = b.owe('tickets', 'receivable', sana, "Sana's share of concert tickets", 12000, dayIn(now, 1, 21), { sourceTransactionId: tickets });
    b.add('refund', dayIn(now, 0, 2), 6000, 'Sana paid back part of the tickets', 'wallet', 'entertainment', undefined, undefined, {
      personId: sana,
      obligationId: share,
      refundOfId: tickets,
    });
  }

  // Money lent to a friend, partly repaid. None of it is spending or income.
  const ahmed = b.person('ahmed', 'Ahmed Raza', 'Friend');
  const lent = b.owe('ahmed', 'lent', ahmed, 'Loan to Ahmed', 25000, dayIn(now, 3, 14), { dueDate: addMonths(dayIn(now, 0, 25), 1) });
  b.add('principal_out', dayIn(now, 3, 14), 25000, 'Loan to Ahmed', 'bank', undefined, undefined, undefined, { personId: ahmed, obligationId: lent });
  b.add('principal_in', dayIn(now, 1, 12), 10000, 'Ahmed repaid part', 'bank', undefined, undefined, undefined, { personId: ahmed, obligationId: lent });

  // Money borrowed from family and paid back in instalments.
  const bilal = b.person('bilal', 'Bilal Khan', 'Brother');
  const borrowed = b.owe('bilal', 'borrowed', bilal, 'Borrowed from Bilal for the laptop', 60000, dayIn(now, 4, 6), { instalmentAmount: 15000, instalmentFrequency: 'monthly' });
  b.add('principal_in', dayIn(now, 4, 6), 60000, 'Borrowed from Bilal', 'bank', undefined, undefined, undefined, { personId: bilal, obligationId: borrowed });
  for (const m of [3, 2, 1]) {
    b.add('principal_out', dayIn(now, m, 7), 15000, 'Repayment to Bilal', 'bank', undefined, undefined, undefined, { personId: bilal, obligationId: borrowed });
  }

  const accounts: Account[] = [
    { id: `${spaceId}:cash`, spaceId, name: 'Cash', kind: 'cash', openingBalance: 8000 },
    { id: `${spaceId}:bank`, spaceId, name: 'Bank Account', kind: 'bank', openingBalance: 215000 },
    { id: `${spaceId}:wallet`, spaceId, name: 'Mobile Wallet', kind: 'wallet', openingBalance: 3500 },
  ];
  const r = (key: string, name: string, amount: number, day: number, category: string, account: string, type: 'expense' | 'income' = 'expense'): Recurring => ({
    id: `${spaceId}:r-${key}`,
    spaceId,
    name,
    amount,
    type,
    categoryId: `${spaceId}:${category}`,
    accountId: `${spaceId}:${account}`,
    frequency: 'monthly',
    startDate: dayIn(now, MONTHS_OF_HISTORY - 1, day),
    nextDueDate: nextDay(now, day),
    reminderDays: 3,
    status: 'active',
  });
  const recurring = [
    r('salary', 'Salary', 185000, 1, 'salary', 'bank', 'income'),
    r('rent', 'House rent', 45000, 3, 'housing', 'bank'),
    r('mobile', 'Mobile package', 1500, 5, 'bills', 'wallet'),
    r('internet', 'Internet bill', 4500, 8, 'bills', 'bank'),
    r('electricity', 'Electricity bill', 13000, 10, 'bills', 'bank'),
    r('streaming', 'Streaming subscription', 1100, 15, 'entertainment', 'bank'),
  ];
  const budgets = [
    budget(spaceId, now, 'food', 'Food', 38000, 'food'),
    budget(spaceId, now, 'dining', 'Dining out', 9000, 'food', 'dining-out'),
    budget(spaceId, now, 'transport', 'Transport', 20000, 'transport'),
    budget(spaceId, now, 'shopping', 'Shopping', 18000, 'shopping'),
    budget(spaceId, now, 'all', 'All spending', 150000),
  ];
  const goals = [
    goal(spaceId, now, 'emergency', 'Emergency Fund', 'heart-pulse', 500000, 'Six months of living costs.', { start: 120000, monthly: 15000, months: 5 }),
    goal(spaceId, now, 'laptop', 'New Laptop', 'laptop', 280000, 'For freelance design work.', { monthly: 25000, months: 4, targetInMonths: 5 }),
  ];
  // A withdrawal, to show that money can come back out of a goal.
  const emergency = goals[0];
  const dip = dayIn(now, 2, 19);
  if (dip <= now)
    emergency.entries.push({ id: `${emergency.goal.id}:w0`, spaceId, goalId: emergency.goal.id, amount: -20000, date: dip, note: 'Car repair', createdAt: `${dip}T09:00:00.000Z` });
  return {
    accounts,
    transactions: b.transactions,
    recurring,
    people: b.people,
    obligations: b.obligations,
    budgets,
    goals: goals.map((g) => g.goal),
    goalEntries: goals.flatMap((g) => g.entries),
  };
}

function seedBusiness(spaceId: ID, now: ISODate) {
  const b = new Builder(spaceId, 'PKR', now, mulberry32(29));
  // Customers and suppliers. Some sales and purchases are recorded against them.
  const alnoor = b.person('alnoor', 'Al-Noor Traders', 'Wholesale customer', 'customer');
  const city = b.person('city-school', 'City School', 'Corporate customer', 'customer');
  const zubair = b.person('zubair', 'Zubair Fabrics', 'Fabric on 30-day credit', 'supplier');
  const packaging = b.person('packaging', 'Packaging Hub', 'Boxes and wrapping', 'supplier');
  const lender = b.person('habib', 'Habib Leasing', 'Printing press finance', 'lender');
  const SALE_FROM: Record<string, ID> = { 'Wholesale order': alnoor, 'Corporate order': city };
  const BOUGHT_FROM: Record<string, ID> = { 'Fabric supplier': zubair, 'Packaging material': packaging };
  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    const d = (day: number) => dayIn(now, m, day);
    for (const day of spreadDays(b.rand, 7)) {
      const amount = b.amount(65000, 210000, 1000);
      const what = b.pick(['Wholesale order', 'Retail sales', 'Online store payout', 'Corporate order']);
      b.add('income', d(day), amount, what, 'bank', 'sales', undefined, undefined, SALE_FROM[what] ? { personId: SALE_FROM[what] } : {});
    }
    for (const day of spreadDays(b.rand, 2)) {
      b.add('income', d(day), b.amount(30000, 90000, 1000), b.pick(['Custom printing job', 'Design services']), 'bank', 'services');
    }
    b.add('transfer', d(2), 50000, 'Petty cash top-up', 'bank', undefined, undefined, 'cash');
    b.add('expense', d(1), 85000, 'Shop rent', 'bank', 'rent');
    b.add('expense', d(12), b.amount(18000, 27000, 500), 'Electricity and gas', 'bank', 'utilities');
    b.add('expense', d(28), 310000, 'Staff salaries', 'bank', 'payroll');
    for (const day of spreadDays(b.rand, 3)) {
      const amount = b.amount(45000, 120000, 1000);
      const what = b.pick(['Fabric supplier', 'Packaging material', 'Raw material purchase']);
      b.add('expense', d(day), amount, what, 'bank', 'supplies', undefined, undefined, BOUGHT_FROM[what] ? { personId: BOUGHT_FROM[what] } : {});
    }
    for (const day of spreadDays(b.rand, 2)) {
      b.add('expense', d(day), b.amount(15000, 42000, 500), b.pick(['Facebook ads', 'Instagram campaign', 'Printed flyers']), 'bank', 'marketing');
    }
    for (const day of spreadDays(b.rand, 4)) {
      b.add('expense', d(day), b.amount(4500, 14000, 100), b.pick(['Courier charges', 'Delivery van fuel', 'Cargo booking']), 'cash', 'logistics');
    }
    b.add('expense', d(b.amount(5, 25, 1)), b.amount(3000, 9000, 100), b.pick(['Stationery', 'Printer ink', 'Office tea and water']), 'cash', 'office');
    if (m % 2 === 0) b.add('expense', d(20), 25000, 'Accountant fee', 'bank', 'professional');
  }
  // Petty cash that built up is paid back into the bank.
  b.add('transfer', dayIn(now, 1, 26), 40000, 'Cash sales deposited', 'cash', undefined, undefined, 'bank');

  // Customers who have not paid in full. Income is counted only when money arrives.
  const invoice = b.owe('alnoor', 'receivable', alnoor, 'Wholesale order, invoice 1042', 180000, dayIn(now, 1, 18), { dueDate: addDays(now, 6) });
  b.add('income', dayIn(now, 0, 3), 100000, 'Al-Noor Traders, part payment', 'bank', 'sales', undefined, undefined, { personId: alnoor, obligationId: invoice });
  b.owe('city-school', 'receivable', city, 'Printed prospectus, invoice 1037', 65000, dayIn(now, 2, 11), { dueDate: addDays(now, -9) });

  // A supplier bill paid in parts. The cost is counted as each payment is made.
  const bill = b.owe('zubair', 'payable', zubair, 'Fabric delivery on credit', 120000, dayIn(now, 1, 22), { dueDate: addDays(now, 12) });
  b.add('expense', dayIn(now, 0, 4), 50000, 'Zubair Fabrics, part payment', 'bank', 'supplies', undefined, undefined, { personId: zubair, obligationId: bill });

  // An equipment loan: the money received is not income, and repayments are not costs.
  const loan = b.owe('printer-loan', 'borrowed', lender, 'Loan for the new printing press', 600000, dayIn(now, 5, 10), {
    instalmentAmount: 50000,
    instalmentFrequency: 'monthly',
    interestRate: 14,
  });
  b.add('principal_in', dayIn(now, 5, 10), 600000, 'Equipment loan received', 'bank', undefined, undefined, undefined, { personId: lender, obligationId: loan });
  for (let m = 4; m >= 0; m--) {
    b.add('principal_out', dayIn(now, m, 10), 50000, 'Equipment loan instalment', 'bank', undefined, undefined, undefined, { personId: lender, obligationId: loan });
  }

  const accounts: Account[] = [
    { id: `${spaceId}:bank`, spaceId, name: 'Business Account', kind: 'bank', openingBalance: 540000 },
    { id: `${spaceId}:cash`, spaceId, name: 'Petty Cash', kind: 'cash', openingBalance: 20000 },
  ];
  const r = (key: string, name: string, amount: number, day: number, category: string): Recurring => ({
    id: `${spaceId}:r-${key}`,
    spaceId,
    name,
    amount,
    type: 'expense',
    categoryId: `${spaceId}:${category}`,
    accountId: `${spaceId}:bank`,
    frequency: 'monthly',
    startDate: dayIn(now, MONTHS_OF_HISTORY - 1, day),
    nextDueDate: nextDay(now, day),
    reminderDays: 3,
    status: 'active',
  });
  const recurring = [
    r('rent', 'Shop rent', 85000, 1, 'rent'),
    r('utilities', 'Electricity and gas', 22000, 12, 'utilities'),
    r('payroll', 'Staff salaries', 310000, 28, 'payroll'),
    // Paying this off is a loan repayment, so confirming it is never booked as a cost.
    { ...r('loan', 'Equipment loan instalment', 50000, 10, 'operations'), categoryId: undefined, obligationId: loan },
  ];
  const budgets = [
    budget(spaceId, now, 'marketing', 'Marketing', 60000, 'marketing'),
    budget(spaceId, now, 'supplies', 'Supplies', 280000, 'supplies'),
    budget(spaceId, now, 'logistics', 'Logistics', 45000, 'logistics'),
  ];
  const reserve = goal(spaceId, now, 'reserve', 'Tax and cash reserve', 'scale', 600000, 'Set aside for tax and slow months.', { start: 150000, monthly: 40000, months: 5 });
  return {
    accounts,
    transactions: b.transactions,
    recurring,
    people: b.people,
    obligations: b.obligations,
    budgets,
    goals: [reserve.goal],
    goalEntries: reserve.entries,
  };
}

function seedFamily(spaceId: ID, now: ISODate) {
  const b = new Builder(spaceId, 'PKR', now, mulberry32(47));
  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    const d = (day: number) => dayIn(now, m, day);
    b.add('income', d(2), 95000, 'Household contribution', 'bank', 'contributions');
    b.add('transfer', d(3), 36000, 'Cash for the house', 'bank', undefined, undefined, 'cash');
    b.add('expense', d(5), 32000, 'School fees', 'bank', 'education', 'school-fees');
    b.add('expense', d(6), 18000, 'Household help', 'cash', 'housing', 'household-help');
    b.add('expense', d(9), b.amount(6000, 11000, 100), 'Gas and water bills', 'bank', 'bills', 'gas');
    b.add('expense', d(7), 6500, 'School van', 'cash', 'transport', 'school-van');
    for (const day of spreadDays(b.rand, 4)) {
      b.add('expense', d(day), b.amount(4200, 8500), b.pick(['Monthly ration', 'Vegetables and meat', 'Bakery and dairy']), 'bank', 'food', 'groceries');
    }
    if (b.rand() > 0.35)
      b.add('expense', d(b.amount(10, 26, 1)), b.amount(2000, 6500, 100), b.pick(['Family outing', 'Birthday gift', 'Park and ice cream']), 'cash', 'entertainment');
    if (b.rand() > 0.5) b.add('expense', d(b.amount(8, 24, 1)), b.amount(1800, 7500, 100), b.pick(["Children's clinic", 'Medicines']), 'cash', 'health');
  }
  const accounts: Account[] = [
    { id: `${spaceId}:bank`, spaceId, name: 'Joint Account', kind: 'bank', openingBalance: 60000 },
    { id: `${spaceId}:cash`, spaceId, name: 'Household Cash', kind: 'cash', openingBalance: 10000 },
  ];
  const recurring: Recurring[] = [
    {
      id: `${spaceId}:r-fees`,
      spaceId,
      name: 'School fees',
      amount: 32000,
      type: 'expense',
      categoryId: `${spaceId}:education`,
      accountId: `${spaceId}:bank`,
      frequency: 'monthly',
      startDate: dayIn(now, MONTHS_OF_HISTORY - 1, 5),
      nextDueDate: nextDay(now, 5),
      reminderDays: 3,
      status: 'active',
    },
    {
      id: `${spaceId}:r-help`,
      spaceId,
      name: 'Household help',
      amount: 18000,
      type: 'expense',
      categoryId: `${spaceId}:housing`,
      accountId: `${spaceId}:cash`,
      frequency: 'monthly',
      startDate: dayIn(now, MONTHS_OF_HISTORY - 1, 6),
      nextDueDate: nextDay(now, 6),
      reminderDays: 1,
      status: 'active',
    },
  ];
  const budgets = [budget(spaceId, now, 'food', 'Food', 30000, 'food'), budget(spaceId, now, 'outings', 'Outings', 6000, 'entertainment')];
  const vacation = goal(spaceId, now, 'vacation', 'Family Vacation', 'plane', 350000, 'Northern areas next summer.', { monthly: 20000, months: 5, targetInMonths: 8 });
  return {
    accounts,
    transactions: b.transactions,
    recurring,
    people: b.people,
    obligations: b.obligations,
    budgets,
    goals: [vacation.goal],
    goalEntries: vacation.entries,
  };
}

/**
 * Builds a set of demo Spaces owned by `ownerId`. Ids carry a random key so
 * a later demo set can never collide with one that was kept by an account.
 */
export function buildSeed(ownerId: ID, now: ISODate = today()): SeedData {
  const key = crypto.randomUUID().slice(0, 8);
  const ids = { personal: `sp-${key}-personal`, business: `sp-${key}-business`, family: `sp-${key}-family` };
  const createdAt = `${addMonths(now, -MONTHS_OF_HISTORY)}T08:00:00.000Z`;
  const space = (id: ID, name: string, type: Space['type'], icon: string, description: string): Space => ({
    id,
    ownerId,
    name,
    type,
    icon,
    description,
    currency: 'PKR',
    createdAt,
    status: 'active',
  });
  const spaces = [
    space(ids.personal, 'Personal', 'personal', 'home', 'My own income, spending and savings.'),
    space(ids.business, 'Business', 'business', 'briefcase', 'Karachi Print Studio — sales and running costs.'),
    space(ids.family, 'Family', 'family', 'users', 'Shared household expenses.'),
  ];
  const parts = [seedPersonal(ids.personal, now), seedBusiness(ids.business, now), seedFamily(ids.family, now)];
  // The demo is written in rupees for readability and stored in paisa, like everything else.
  const minor = <C extends MoneyCollection>(c: C, items: object[]) => items.map((item) => recordToMinor(c, item)) as never;
  return {
    spaces,
    accounts: minor(
      'accounts',
      parts.flatMap((p) => p.accounts),
    ),
    categories: spaces.flatMap((s) => defaultCategories(s.id, s.type)),
    transactions: minor(
      'transactions',
      parts.flatMap((p) => p.transactions),
    ),
    recurring: minor(
      'recurring',
      parts.flatMap((p) => p.recurring),
    ),
    people: parts.flatMap((p) => p.people),
    obligations: minor(
      'obligations',
      parts.flatMap((p) => p.obligations),
    ),
    budgets: minor(
      'budgets',
      parts.flatMap((p) => p.budgets),
    ),
    goals: minor(
      'goals',
      parts.flatMap((p) => p.goals),
    ),
    goalEntries: minor(
      'goalEntries',
      parts.flatMap((p) => p.goalEntries),
    ),
    spaceIdByType: ids,
  };
}
