import { afterEach, describe, expect, it } from 'vitest';
import { addDays, addMonths, currentTimeZone, DEFAULT_TIME_ZONE, deviceTimeZone, diffDays, isValidTimeZone, setTimeZone, today, todayIn, zonedParts } from './dates';

afterEach(() => setTimeZone(null));

describe('time zones', () => {
  it("works out today in the user's zone, not the clock's", () => {
    // 19 Nov 2026, 19:30 UTC: already the 20th in Karachi (UTC+5), still the 19th in New York.
    const at = new Date('2026-11-19T19:30:00Z');
    expect(todayIn('Asia/Karachi', at)).toBe('2026-11-20');
    expect(todayIn('UTC', at)).toBe('2026-11-19');
    expect(todayIn('America/New_York', at)).toBe('2026-11-19');
    expect(todayIn('Pacific/Kiritimati', at)).toBe('2026-11-20');
    expect(zonedParts('Asia/Karachi', at).hour).toBe(0);
  });

  it('handles the minutes either side of midnight and daylight saving changes', () => {
    expect(todayIn('Asia/Karachi', new Date('2026-11-19T18:59:59Z'))).toBe('2026-11-19');
    expect(todayIn('Asia/Karachi', new Date('2026-11-19T19:00:00Z'))).toBe('2026-11-20');
    // New York moves its clocks forward on 8 March 2026.
    expect(todayIn('America/New_York', new Date('2026-03-08T04:59:00Z'))).toBe('2026-03-07');
    expect(todayIn('America/New_York', new Date('2026-03-08T05:00:00Z'))).toBe('2026-03-08');
  });

  it('uses the zone it is given, and ignores one that does not exist', () => {
    setTimeZone('Pacific/Kiritimati');
    expect(currentTimeZone()).toBe('Pacific/Kiritimati');
    expect(today()).toBe(todayIn('Pacific/Kiritimati'));
    setTimeZone('Mars/Olympus');
    expect(currentTimeZone()).toBe(deviceTimeZone());
    expect([isValidTimeZone('Asia/Karachi'), isValidTimeZone('Nowhere/Else'), isValidTimeZone(DEFAULT_TIME_ZONE)]).toEqual([true, false, true]);
  });

  it('counts calendar days the same across daylight saving changes', () => {
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2);
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(diffDays('2026-10-31', '2026-11-02')).toBe(2);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});
