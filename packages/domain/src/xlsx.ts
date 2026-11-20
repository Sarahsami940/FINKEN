/**
 * Reports as Excel workbooks (.xlsx), with no library: an .xlsx file is a
 * zip of a few XML files. Amounts are real numbers in rupees with two
 * decimals, so they add up in Excel; text is stored as text, never as a
 * formula, so a description like "=SUM(…)" cannot run.
 */
import { toMajor } from './format';
import type { Cell, Report } from './reports';
import type { DateRange } from './types';

// ── A zip file, stored without compression ─────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip holding these files, uncompressed. Dates are fixed, so the same input gives the same bytes. */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true); // time
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, file.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── The workbook ───────────────────────────────────────────────────────────

/** Characters XML forbids: every control character except tab, line feed and carriage return. */
const allowedInXml = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
};

/** Text safe inside XML: escaped, and without the characters XML forbids. */
const xmlText = (text: string) => [...text].filter(allowedInXml).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const column = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : column(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** Styles: 0 plain, 1 bold, 2 amount, 3 bold amount, 4 date, 5 title. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="165" formatCode="d mmm yyyy"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Excel counts days from 30 December 1899. */
const excelDay = (iso: string) => Math.round((Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) - Date.UTC(1899, 11, 30)) / 86_400_000);

type XCell = { value: Cell; style: number; money?: boolean };

function cellXml(ref: string, c: XCell): string {
  if (c.value === '' || c.value === undefined || c.value === null) return '';
  if (typeof c.value === 'number') {
    const n = c.money ? toMajor(Math.round(c.value)) : c.value;
    return `<c r="${ref}" s="${c.style}"><v>${Number.isFinite(n) ? n : 0}</v></c>`;
  }
  if (ISO_DATE.test(c.value)) return `<c r="${ref}" s="4"><v>${excelDay(c.value)}</v></c>`;
  return `<c r="${ref}" s="${c.style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(c.value)}</t></is></c>`;
}

/** The report as one worksheet, laid out like the screen and the CSV: a heading, then each section. */
export function reportToXlsx(report: Report, meta: { space: string; range: DateRange; currency: string }): Uint8Array {
  const rows: XCell[][] = [
    [{ value: report.title, style: 5 }],
    [
      { value: 'Space', style: 1 },
      { value: meta.space, style: 0 },
    ],
    [
      { value: 'Period', style: 1 },
      { value: meta.range.from, style: 4 },
      { value: meta.range.to, style: 4 },
    ],
    [
      { value: 'Currency', style: 1 },
      { value: meta.currency, style: 0 },
    ],
    [{ value: report.description, style: 0 }],
  ];
  for (const section of report.sections) {
    rows.push(
      [],
      [{ value: section.title, style: 1 }],
      section.columns.map((c) => ({ value: c, style: 1 })),
    );
    const line = (cells: Cell[], bold: boolean) =>
      cells.map((value, i) => {
        const money = section.money.includes(i);
        return { value, money, style: money ? (bold ? 3 : 2) : bold ? 1 : 0 };
      });
    for (const r of section.rows) rows.push(line(r, false));
    if (section.total) rows.push(line(section.total, true));
  }
  const widest = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: widest }, (_, i) =>
    Math.min(60, Math.max(10, ...rows.slice(5).map((r) => (typeof r[i]?.value === 'string' ? (r[i].value as string).length + 2 : 14)))),
  );
  const sheetRows = rows.map((r, i) => `<row r="${i + 1}">${r.map((c, j) => cellXml(`${column(j)}${i + 1}`, c)).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  // Sheet names: at most 31 characters, none of : \ / ? * [ ]
  const sheetName = xmlText(report.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));
  const enc = new TextEncoder();
  const file = (name: string, text: string) => ({ name, data: enc.encode(text) });
  return zip([
    file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    file('xl/styles.xml', STYLES),
    file('xl/worksheets/sheet1.xml', sheet),
  ]);
}
