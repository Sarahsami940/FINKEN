import {
  CalendarClock,
  ChartNoAxesColumn,
  Ellipsis,
  HandCoins,
  Handshake,
  House,
  Landmark,
  Layers,
  List,
  type LucideIcon,
  PiggyBank,
  Repeat,
  Search,
  Settings,
  Tags,
  Target,
  Users,
  Wallet,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/transactions', label: 'Transactions', icon: List },
  { to: '/money', label: 'Money', icon: Wallet },
  { to: '/insights', label: 'Insights', icon: ChartNoAxesColumn },
  { to: '/more', label: 'More', icon: Ellipsis },
];

export interface MoneySection extends NavItem {
  key: string;
  summary: string;
}

export const MONEY_SECTIONS: MoneySection[] = [
  { key: 'upcoming', to: '/money/upcoming', label: 'Upcoming', icon: CalendarClock, summary: 'Bills and expected money on the way.' },
  { key: 'budgets', to: '/money/budgets', label: 'Budgets', icon: PiggyBank, summary: 'Set limits and watch your spending pace.' },
  { key: 'goals', to: '/money/goals', label: 'Goals', icon: Target, summary: 'Save towards the things that matter.' },
  { key: 'recurring', to: '/money/recurring', label: 'Recurring', icon: Repeat, summary: 'Regular bills, subscriptions and income.' },
  { key: 'people', to: '/money/people', label: 'People', icon: Users, summary: 'Who owes you, and who you owe.' },
  { key: 'loans', to: '/money/loans', label: 'Loans', icon: HandCoins, summary: 'Money borrowed and lent, with repayments.' },
  { key: 'receivables', to: '/money/receivables', label: 'To receive', icon: Handshake, summary: 'Money other people owe you.' },
  { key: 'payables', to: '/money/payables', label: 'To pay', icon: Landmark, summary: 'Money you still need to pay.' },
];

export const MORE_SECTIONS: (NavItem & { summary: string })[] = [
  { to: '/search', label: 'Search your money', icon: Search, summary: 'Ask in your own words: what you spent, who owes you, what is due.' },
  { to: '/more/spaces', label: 'Spaces', icon: Layers, summary: 'Keep personal, family and business money apart.' },
  { to: '/more/categories', label: 'Categories', icon: Tags, summary: 'How your income and spending are grouped.' },
  { to: '/more/settings', label: 'Settings and profile', icon: Settings, summary: 'Your name, demo data and storage.' },
];
