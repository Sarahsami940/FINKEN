/**
 * Icon registry. Records store an icon *key*; this maps keys to components
 * so stored data never depends on the icon library.
 */

import type { AccountKind } from '@finken/domain/types';
import {
  Baby,
  Banknote,
  Book,
  Briefcase,
  Building,
  Car,
  Circle,
  Clapperboard,
  Coffee,
  Coins,
  Dumbbell,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  Landmark,
  Laptop,
  type LucideIcon,
  Megaphone,
  Package,
  PawPrint,
  Plane,
  Printer,
  Receipt,
  RotateCcw,
  Scale,
  Settings,
  Shirt,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Truck,
  Users,
  Utensils,
  Wallet,
  Wrench,
  Zap,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  utensils: Utensils,
  car: Car,
  zap: Zap,
  home: House,
  'shopping-bag': ShoppingBag,
  'heart-pulse': HeartPulse,
  'graduation-cap': GraduationCap,
  clapperboard: Clapperboard,
  users: Users,
  plane: Plane,
  circle: Circle,
  briefcase: Briefcase,
  laptop: Laptop,
  'rotate-ccw': RotateCcw,
  coins: Coins,
  'hand-coins': HandCoins,
  building: Building,
  megaphone: Megaphone,
  truck: Truck,
  printer: Printer,
  package: Package,
  settings: Settings,
  scale: Scale,
  receipt: Receipt,
  gift: Gift,
  coffee: Coffee,
  shirt: Shirt,
  'paw-print': PawPrint,
  baby: Baby,
  dumbbell: Dumbbell,
  book: Book,
  wrench: Wrench,
  smartphone: Smartphone,
  sparkles: Sparkles,
};

/** Icons a user can pick for a category. */
export const CATEGORY_ICON_KEYS = Object.keys(ICONS);

export function iconFor(key: string): LucideIcon {
  return ICONS[key] ?? Circle;
}

/** Icons a user can pick for a Space. */
export const SPACE_ICON_KEYS = ['home', 'briefcase', 'users', 'car', 'building', 'shopping-bag', 'plane', 'laptop'];

const ACCOUNT_ICONS: Record<AccountKind, LucideIcon> = {
  cash: Banknote,
  bank: Landmark,
  wallet: Smartphone,
  other: Wallet,
};

export function accountIcon(kind: AccountKind): LucideIcon {
  return ACCOUNT_ICONS[kind];
}
