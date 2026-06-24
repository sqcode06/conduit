import qrcode from 'qrcode-terminal';
import { loadState } from '../config';
import { color, die } from '../ui';
import { EXIT } from '../util';

export function qr(url: string | undefined): void {
  const target = url ?? loadState().lastLink;
  if (!target) {
    die('no URL given and no last-minted link found — pass a URL or run `conduit push` first', EXIT.USAGE);
  }
  console.log();
  console.log(`  ${color.cyan(target)}`);
  console.log();
  qrcode.generate(target, { small: true });
}
