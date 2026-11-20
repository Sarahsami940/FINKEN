import { describe, expect, it } from 'vitest';
import { floorToMajor, formatMoney, isMinorAmount, moneyToInput, parseMoney, toMajor, toMinor } from './format';
import { splitEqually } from './money';
import { recordToMinor } from './units';

describe('money in paisa', () => {
  it('reads typed amounts exactly, with no floating-point error', () => {
    expect(parseMoney('1250')).toBe(125000);
    expect(parseMoney('1,250.5')).toBe(125050);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('19.99')).toBe(1999);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('-300')).toBe(-30000);
    for (const bad of ['', '.', 'abc', '1.234', '12a', '--1']) expect(parseMoney(bad), bad).toBeNaN();
  });

  it('converts rupees to paisa to the nearest paisa', () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor(2.5 * 1000)).toBe(250000);
    expect(toMajor(125050)).toBe(1250.5);
  });

  it('adds up exactly where rupee decimals drift', () => {
    const rupees = Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b, 0);
    expect(rupees).not.toBe(1);
    const paisa = Array.from({ length: 10 }, () => parseMoney('0.10')).reduce((a, b) => a + b, 0);
    expect(paisa).toBe(100);
  });

  it('accepts only whole paisa as a stored amount', () => {
    expect([isMinorAmount(100), isMinorAmount(0), isMinorAmount(-5)]).toEqual([true, true, true]);
    expect([isMinorAmount(1.5), isMinorAmount(Number.NaN), isMinorAmount(Number.POSITIVE_INFINITY), isMinorAmount('100')]).toEqual([false, false, false, false]);
  });

  it('shows paisa only when there are some, and estimates to the rupee', () => {
    expect(formatMoney(125000)).toBe('Rs. 1,250');
    expect(formatMoney(125050)).toBe('Rs. 1,250.50');
    expect(formatMoney(-5)).toBe('−Rs. 0.05');
    expect(formatMoney(125050, 'PKR', { signed: true })).toBe('+Rs. 1,250.50');
    expect(formatMoney(123333.33)).toBe('Rs. 1,233');
    expect(formatMoney(0.4)).toBe('Rs. 0');
    expect(formatMoney(250000000, 'PKR', { compact: true })).toBe('Rs. 2.5M');
    expect(formatMoney(4800000, 'USD', { compact: true })).toBe('$48K');
  });

  it('puts amounts back into edit fields as rupees', () => {
    expect([moneyToInput(125000), moneyToInput(125050), moneyToInput(5), moneyToInput(-30000)]).toEqual(['1250', '1250.50', '0.05', '-300']);
    for (const text of ['1250', '1250.50', '0.05', '-300']) expect(moneyToInput(parseMoney(text))).toBe(text);
  });

  it('rounds "about X a day" figures down to a whole rupee', () => {
    expect(floorToMajor(123456)).toBe(123400);
    expect(floorToMajor(99)).toBe(0);
  });

  it('splits into shares that add up to the paisa', () => {
    expect(splitEqually(100000, 3)).toEqual([33334, 33333, 33333]);
    expect(splitEqually(100000, 3, 100)).toEqual([33400, 33300, 33300]);
    expect(splitEqually(100001, 7).reduce((a, b) => a + b, 0)).toBe(100001);
  });

  it('converts records saved in rupees, touching only money fields', () => {
    expect(recordToMinor('transactions', { id: 't', amount: 1250.5, date: '2026-01-01' })).toEqual({ id: 't', amount: 125050, date: '2026-01-01' });
    expect(recordToMinor('obligations', { id: 'o', amount: 60000, instalmentAmount: 15000, interestRate: 12 })).toEqual({
      id: 'o',
      amount: 6000000,
      instalmentAmount: 1500000,
      interestRate: 12,
    });
    expect(recordToMinor('obligations', { id: 'o', amount: 1 })).not.toHaveProperty('instalmentAmount');
    expect(recordToMinor('accounts', { id: 'a', openingBalance: -250 })).toMatchObject({ openingBalance: -25000 });
  });
});
