import { describe, expect, it } from 'vitest';
import { isUsageEvent, screenEvent, screenName, USAGE_EVENTS } from './usage';

describe('usage events', () => {
  it('names screens without the ids in their address', () => {
    expect(screenName('/')).toBe('home');
    expect(screenName('/transactions/')).toBe('transactions');
    expect(screenName('/money/people/7f3a-anything')).toBe('person');
    expect(screenName('/money/people/7f3a/extra')).toBe('other');
    expect(screenEvent('/more/import')).toBe('screen:import');
    expect(screenEvent('/nowhere')).toBeNull();
  });

  it('accepts only names from the fixed list', () => {
    expect(isUsageEvent('screen:home')).toBe(true);
    expect(isUsageEvent('add:expense')).toBe(true);
    expect(isUsageEvent('screen:other')).toBe(false);
    expect(isUsageEvent('add:expense:1250')).toBe(false);
    expect(isUsageEvent('search:Ali')).toBe(false);
  });

  it('only has names the database allows, none longer than 40 characters', () => {
    for (const name of USAGE_EVENTS) expect(name).toMatch(/^[a-z]+:[a-z-]{1,30}$/);
  });
});
