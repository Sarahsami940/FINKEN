/**
 * Category colours. One muted family so charts stay calm; `fg` is used for
 * icons and chart marks, `bg` for the soft tile behind an icon.
 */
export const PALETTE: Record<string, { fg: string; bg: string }> = {
  cobalt: { fg: '#3B4FD9', bg: '#E9ECFC' },
  teal: { fg: '#16808A', bg: '#E0F1F2' },
  amber: { fg: '#B7791F', bg: '#F8EEDB' },
  rose: { fg: '#C2476B', bg: '#FAE6EC' },
  violet: { fg: '#7C55C7', bg: '#EFE8FA' },
  green: { fg: '#2E8B57', bg: '#E2F2E8' },
  orange: { fg: '#CC6A2C', bg: '#FBEADD' },
  sky: { fg: '#2F7FC1', bg: '#E2EFF9' },
  olive: { fg: '#7A8A2E', bg: '#EFF2DC' },
  slate: { fg: '#5B6472', bg: '#ECEEF1' },
};

export const PALETTE_KEYS = Object.keys(PALETTE);

export function colorOf(key: string) {
  return PALETTE[key] ?? PALETTE.slate;
}
