/**
 * Phase 9: Business Mode reports. The monthly statement's parts agree with
 * each other and with the other reports, and the Excel file is a real,
 * safe workbook.
 */
import { describe, expect, it } from 'vitest';
import { businessRange, cashFlow, profitAndLoss } from './business';
import { monthRange } from './dates';
import { totalBalance } from './money';
import { buildReport, REPORTS, type Report } from './reports';
import { buildSeed } from './seed';
import { crc32, reportToXlsx, zip } from './xlsx';

const NOW = '2026-11-20';
const seed = buildSeed('u1', NOW);
const id = seed.spaceIdByType.business!;
const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === id);
const input = {
  accounts: own(seed.accounts),
  categories: own(seed.categories),
  transactions: own(seed.transactions),
  obligations: own(seed.obligations),
  people: own(seed.people),
};

/** Reads back an uncompressed zip, checking every file's CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const files = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    expect(crc32(data), name).toBe(crc);
    files.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  // The central directory and its end record follow.
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return files;
}

describe('the monthly statement', () => {
  const months = [monthRange(NOW), monthRange(NOW, -1), monthRange(NOW, -3)];

  it.each(months.map((m) => [m.from, m]))('for %s, every part agrees', (_from, range) => {
    const r = buildReport('statement', input, range, NOW);
    const [summary, accounts, lines] = r.sections;
    const line = (name: string) => summary.rows.find((row) => row[0] === name)![1] as number;
    const pnl = profitAndLoss(input.transactions, input.categories, range);
    const cash = cashFlow(
      input.accounts.filter((a) => !a.archived),
      input.transactions,
      input.obligations,
      range,
    );

    // Profit agrees with the profit and loss report.
    expect(line('Revenue')).toBe(pnl.revenue);
    expect(line('Revenue') + line('Expenses')).toBe(pnl.netProfit);
    expect(line('Net profit')).toBe(pnl.netProfit);
    // Cash: start + received − paid = end, and the end is what the accounts hold.
    expect(line('Cash at the start') + line('Money received') + line('Money paid')).toBe(line('Cash at the end'));
    expect(line('Cash at the end')).toBe(cash.closing);

    // Each account adds up on its own, and together they make the summary.
    for (const row of accounts.rows) {
      const [, start, inn, out, end] = row as number[];
      expect(start + inn - out).toBe(end);
    }
    const [, opening, , , closing] = accounts.total as number[];
    expect(opening).toBe(line('Cash at the start'));
    expect(closing).toBe(line('Cash at the end'));

    // The transactions move the accounts by exactly the difference.
    const [, , , , , moneyIn, moneyOut] = lines.total as number[];
    expect(moneyIn - moneyOut).toBe(closing - opening);
    // Every money cell is a whole number of paisa.
    for (const s of r.sections)
      for (const row of [...s.rows, ...(s.total ? [s.total] : [])]) for (const i of s.money) if (typeof row[i] === 'number') expect(Number.isSafeInteger(row[i])).toBe(true);
  });

  it('lists transactions in date order, with transfers between accounts as neither in nor out', () => {
    const range = businessRange('quarter', NOW);
    const lines = buildReport('statement', input, range, NOW).sections[2];
    const dates = lines.rows.map((r) => r[0] as string);
    expect([...dates].sort()).toEqual(dates);
    for (const row of lines.rows.filter((r) => r[2] === 'Transfer')) {
      if (String(row[4]).includes('another account')) continue;
      expect([row[5], row[6]]).toEqual(['', '']);
    }
  });

  it('cash at the end of today is the balance on the Home screen', () => {
    const range = monthRange(NOW);
    const r = buildReport('statement', input, range, NOW);
    const end = r.sections[0].rows.find((row) => row[0] === 'Cash at the end')![1];
    // Nothing is dated after today in the demo, so the month's end is today's balance.
    expect(end).toBe(
      totalBalance(
        input.accounts.filter((a) => !a.archived),
        input.transactions,
      ),
    );
  });
});

describe('Excel downloads', () => {
  const meta = { space: 'Shop & Co <Lahore>', range: { from: '2026-11-01', to: '2026-11-30' }, currency: 'PKR' };

  it('is a zip of the parts Excel needs, each one intact', () => {
    const files = unzip(reportToXlsx(buildReport('pnl', input, meta.range, NOW), meta));
    expect([...files.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Profit and loss"');
  });

  it('keeps amounts as numbers in rupees, dates as dates, and text as text that never runs', () => {
    const report: Report = {
      key: 'revenue',
      title: 'Test: a/b [c]',
      description: 'Has <tags> & "quotes"',
      sections: [{ title: 'S', columns: ['Name', 'When', 'Amount'], money: [2], rows: [['=HYPERLINK("http://evil")', '2026-11-05', 123450]], total: ['Total', '', -50] }],
    };
    const sheet = unzip(reportToXlsx(report, meta)).get('xl/worksheets/sheet1.xml')!;
    // Money: 123450 paisa is 1234.5 rupees, a number cell with the amount style.
    expect(sheet).toContain('<c r="C9" s="2"><v>1234.5</v></c>');
    expect(sheet).toContain('<c r="C10" s="3"><v>-0.5</v></c>');
    // 5 November 2026 as an Excel day number, in the date style.
    expect(sheet).toContain('<c r="B9" s="4"><v>46331</v></c>');
    // A formula-looking name is stored as plain text, escaped.
    expect(sheet).toContain('<c r="A9" s="0" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;)</t></is></c>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('Shop &amp; Co &lt;Lahore&gt;');
    // Sheet names cannot hold / [ ] and so on.
    const wb = unzip(reportToXlsx(report, meta)).get('xl/workbook.xml')!;
    expect(wb).toContain('<sheet name="Test  a b  c "');
  });

  it('writes every report, and the same report gives the same file', () => {
    for (const { key } of REPORTS) {
      const r = buildReport(key, input, businessRange('quarter', NOW), NOW);
      const a = reportToXlsx(r, meta);
      expect(unzip(a).size).toBe(6);
      expect(reportToXlsx(r, meta)).toEqual(a);
    }
  });

  it('computes CRC-32 like every zip tool', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(zip([]).length).toBe(22);
  });
});
