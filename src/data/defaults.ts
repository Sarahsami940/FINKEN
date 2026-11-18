/** Default categories and accounts given to every new Space. */
import type { Account, Category, CategoryKind, ID, SpaceType } from '../domain/types';

type CategorySeed = [key: string, name: string, kind: CategoryKind, icon: string, color: string, subs?: string[]];

const PERSONAL: CategorySeed[] = [
  ['food', 'Food', 'expense', 'utensils', 'orange', ['Groceries', 'Dining Out', 'Delivery', 'Snacks']],
  ['transport', 'Transport', 'expense', 'car', 'cobalt', ['Fuel', 'Ride-hailing', 'Public Transport', 'Maintenance']],
  ['bills', 'Bills', 'expense', 'zap', 'amber', ['Electricity', 'Internet', 'Mobile', 'Water']],
  ['housing', 'Housing', 'expense', 'home', 'teal', ['Rent', 'Repairs']],
  ['shopping', 'Shopping', 'expense', 'shopping-bag', 'rose'],
  ['health', 'Health', 'expense', 'heart-pulse', 'green'],
  ['education', 'Education', 'expense', 'graduation-cap', 'violet'],
  ['entertainment', 'Entertainment', 'expense', 'clapperboard', 'sky'],
  ['family', 'Family', 'expense', 'users', 'olive'],
  ['travel', 'Travel', 'expense', 'plane', 'teal'],
  ['other', 'Other', 'expense', 'circle', 'slate'],
  ['salary', 'Salary', 'income', 'briefcase', 'green'],
  ['freelance', 'Freelance', 'income', 'laptop', 'teal'],
  ['refunds', 'Refunds', 'income', 'rotate-ccw', 'sky'],
  ['other-income', 'Other income', 'income', 'coins', 'slate'],
];

const FAMILY: CategorySeed[] = [
  ['food', 'Food', 'expense', 'utensils', 'orange', ['Groceries', 'Dining Out', 'Delivery', 'Snacks']],
  ['bills', 'Bills', 'expense', 'zap', 'amber', ['Electricity', 'Gas', 'Internet', 'Water']],
  ['housing', 'Housing', 'expense', 'home', 'teal', ['Rent', 'Repairs', 'Household Help']],
  ['education', 'Education', 'expense', 'graduation-cap', 'violet', ['School Fees', 'Books', 'Tuition']],
  ['health', 'Health', 'expense', 'heart-pulse', 'green'],
  ['transport', 'Transport', 'expense', 'car', 'cobalt', ['Fuel', 'School Van', 'Maintenance']],
  ['shopping', 'Shopping', 'expense', 'shopping-bag', 'rose'],
  ['entertainment', 'Outings', 'expense', 'clapperboard', 'sky'],
  ['other', 'Other', 'expense', 'circle', 'slate'],
  ['contributions', 'Contributions', 'income', 'hand-coins', 'green'],
  ['other-income', 'Other income', 'income', 'coins', 'slate'],
];

const BUSINESS: CategorySeed[] = [
  ['payroll', 'Payroll', 'expense', 'users', 'cobalt'],
  ['rent', 'Rent', 'expense', 'building', 'teal'],
  ['utilities', 'Utilities', 'expense', 'zap', 'amber'],
  ['marketing', 'Marketing', 'expense', 'megaphone', 'rose'],
  ['logistics', 'Logistics', 'expense', 'truck', 'orange'],
  ['office', 'Office', 'expense', 'printer', 'sky'],
  ['supplies', 'Supplies', 'expense', 'package', 'olive'],
  ['travel', 'Travel', 'expense', 'plane', 'violet'],
  ['operations', 'Operations', 'expense', 'settings', 'slate'],
  ['professional', 'Professional Services', 'expense', 'scale', 'green'],
  ['other', 'Other', 'expense', 'circle', 'slate'],
  ['sales', 'Sales', 'income', 'receipt', 'green'],
  ['services', 'Services', 'income', 'briefcase', 'teal'],
  ['other-income', 'Other income', 'income', 'coins', 'slate'],
];

const BY_TYPE: Record<SpaceType, CategorySeed[]> = {
  personal: PERSONAL,
  family: FAMILY,
  business: BUSINESS,
  other: PERSONAL,
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Category IDs are `${spaceId}:${key}`, so every Space owns its own copies. */
/** Business categories that start as cost of goods sold; the user can change any of them. */
const DIRECT_COSTS = new Set(['supplies']);

export function defaultCategories(spaceId: ID, type: SpaceType): Category[] {
  return BY_TYPE[type].map(([key, name, kind, icon, color, subs = []]) => ({
    id: `${spaceId}:${key}`,
    spaceId,
    name,
    kind,
    icon,
    color,
    subcategories: subs.map((sub) => ({ id: `${spaceId}:${key}:${slug(sub)}`, name: sub })),
    ...(type === 'business' && kind === 'expense' ? { costType: DIRECT_COSTS.has(key) ? ('direct' as const) : ('operating' as const) } : {}),
  }));
}

export function defaultAccounts(spaceId: ID): Account[] {
  return [
    { id: `${spaceId}:cash`, spaceId, name: 'Cash', kind: 'cash', openingBalance: 0 },
    { id: `${spaceId}:bank`, spaceId, name: 'Bank Account', kind: 'bank', openingBalance: 0 },
  ];
}

export const SPACE_TYPE_META: Record<SpaceType, { label: string; icon: string; description: string }> = {
  personal: { label: 'Personal', icon: 'home', description: 'Your own income, spending and savings.' },
  family: { label: 'Family', icon: 'users', description: 'Shared household money.' },
  business: { label: 'Business', icon: 'briefcase', description: 'Income, costs and cash for your business.' },
  other: { label: 'Other', icon: 'circle', description: 'Anything you want to track separately.' },
};
