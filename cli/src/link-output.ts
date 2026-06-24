import clipboard from 'clipboardy';
import qrcode from 'qrcode-terminal';
import { color, glyph } from './ui';
import { setLastLink } from './config';
import { formatUntil } from './util';
import type { MintResult } from './api';

export interface PresentOptions {
  copy: boolean;
  qr: boolean;
}

// Print a freshly minted link, remember it, optionally copy + QR it.
export async function presentLink(link: MintResult, opts: PresentOptions): Promise<void> {
  setLastLink(link.url);

  const meta = [`max ${link.max_downloads}`, `expires ${formatUntil(link.expires_at)}`];
  if (link.grace_seconds) meta.push(`${link.grace_seconds}s grace`);

  console.log();
  console.log(`  ${color.bold(color.cyan(link.url))}`);
  console.log(`  ${color.dim(meta.join('  ·  '))}`);
  console.log();

  if (opts.copy) {
    try {
      await clipboard.write(link.url);
      console.log(`${glyph.ok} ${color.dim('copied to clipboard')}`);
    } catch {
      // No clipboard utility (e.g. headless box) — the link is printed above.
    }
  }

  if (opts.qr) {
    console.log();
    qrcode.generate(link.url, { small: true });
  }
}
