// Renders the app icon (public/icons/icon.svg) into the PNG sizes phones and
// browsers ask for. Run after changing the icon: node apps/web/scripts/icons.mjs
// Uses Playwright from tests/browser with the installed Edge (FINKEN_BROWSER=chrome for Chrome).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const svg = await readFile(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ channel: process.env.FINKEN_BROWSER ?? 'msedge' });
const page = await browser.newPage();
// Maskable icons are cropped to a circle by some phones: keep the mark inside the middle 80%.
const sizes = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
];
for (const [name, size, maskable] of sizes) {
  await page.setViewportSize({ width: size, height: size });
  const inner = maskable
    ? svg
        .replace('rx="112"', 'rx="0"')
        .replace('<text', '<g transform="translate(51 51) scale(0.8)"><text')
        .replace('</svg>', '</g></svg>')
        .replace(/(<circle[^>]*\/>)\n<\/g><\/svg>/, '$1</g></svg>')
    : svg;
  await page.setContent(
    `<html><body style="margin:0;background:${maskable ? '#17191e' : 'transparent'}"><div style="width:${size}px;height:${size}px">${inner.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: join(dir, name), omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote ${name}`);
}
await browser.close();
