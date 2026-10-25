import { expect, it } from 'vitest';
import { canReserveBudget } from './budget-verification.ts';

it.each([
  { spent: 20, next: 30, limit: 100, allowed: true },
  { spent: 20, next: 80, limit: 100, allowed: true },
  { spent: 20, next: 81, limit: 100, allowed: false },
])('予算判定の境界: $spent + $next / $limit', ({ spent, next, limit, allowed }) => {
  expect(canReserveBudget(spent, next, limit)).toBe(allowed);
});
