import type { BudgetAlert } from '@finken/domain/planning';

/** How each budget alert looks, shared by Budgets, Home and Today. */
export const ALERT_STYLE: Record<BudgetAlert, { label: string; tone: 'negative' | 'warning' | 'positive'; bar: string }> = {
  exceeded: { label: 'Over budget', tone: 'negative', bar: 'var(--color-negative)' },
  likely: { label: 'Likely to go over', tone: 'warning', bar: 'var(--color-warning)' },
  approaching: { label: 'Close to the limit', tone: 'warning', bar: 'var(--color-warning)' },
  below: { label: 'Under pace', tone: 'positive', bar: 'var(--color-positive)' },
};
