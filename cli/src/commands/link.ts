import { getClient, resolveFile } from '../client';
import { presentLink } from '../link-output';
import { die } from '../ui';
import { EXIT, parseDuration } from '../util';
import { ApiError, type MintResult } from '../api';

export interface LinkFlags {
  expires: string;
  max: string;
  grace: string;
  json?: boolean;
  copy?: boolean;
  qr?: boolean;
}

export async function link(fileRef: string, flags: LinkFlags): Promise<void> {
  const client = getClient();

  let expiresInSeconds: number | null;
  try {
    expiresInSeconds = parseDuration(flags.expires);
  } catch (e) {
    die((e as Error).message, EXIT.USAGE);
  }
  const maxDownloads = Math.max(1, parseInt(flags.max, 10) || 1);
  const graceSeconds = Math.max(0, parseInt(flags.grace, 10) || 0);

  const file = await resolveFile(client, fileRef);

  let minted: MintResult;
  try {
    minted = await client.mintLink(file.id, { maxDownloads, graceSeconds, expiresInSeconds });
  } catch (e) {
    die((e as ApiError).message, EXIT.RUNTIME);
  }

  if (flags.json) {
    console.log(JSON.stringify({ file, link: minted }, null, 2));
    return;
  }
  await presentLink(minted, { copy: flags.copy !== false, qr: !!flags.qr });
}
