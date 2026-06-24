import pc from 'picocolors';

export const color = pc;

export const glyph = {
  ok: pc.green('✓'),
  warn: pc.yellow('▲'),
  err: pc.red('✗'),
  dot: pc.cyan('●'),
  arrow: pc.dim('→'),
};

export function ok(msg: string): void {
  console.log(`${glyph.ok} ${msg}`);
}
export function warn(msg: string): void {
  console.log(`${glyph.warn} ${pc.yellow(msg)}`);
}
export function info(msg: string): void {
  console.log(`${glyph.arrow} ${msg}`);
}
export function dim(msg: string): void {
  console.log(pc.dim(msg));
}

// Print an error and exit with the given code.
export function die(msg: string, code = 1): never {
  console.error(`${glyph.err} ${pc.red(msg)}`);
  process.exit(code);
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string): number => s.replace(ANSI, '').length;
const padVisible = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - visibleLen(s)));

// Minimal aligned table. Measures width by visible length so colored cells stay aligned.
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ''))),
  );
  const renderRow = (cells: string[]) =>
    cells.map((cell, i) => padVisible(cell ?? '', widths[i])).join('   ');
  const head = pc.dim(renderRow(headers));
  if (!rows.length) return head;
  return `${head}\n${rows.map(renderRow).join('\n')}`;
}
