import { basename } from 'node:path';
import { spinner } from '@clack/prompts';
import { getClient } from '../client';
import { presentLink } from '../link-output';
import { color, ok, die } from '../ui';
import { EXIT, parseDuration, formatSize } from '../util';
import { ApiError, type UploadedFile, type MintResult } from '../api';

export interface PushFlags {
  expires: string;
  max: string;
  grace: string;
  json?: boolean;
  link?: boolean; // --no-link => false
  copy?: boolean; // --no-copy => false
  qr?: boolean;
}

const FILE_INPUT_ERROR_CODES = new Set(['EACCES', 'EISDIR', 'ENOENT', 'EPERM']);

export function uploadErrorExit(error: unknown): number {
  if (error instanceof ApiError) {
    if (error.auth) return EXIT.AUTH;
    return error.usage ? EXIT.USAGE : EXIT.RUNTIME;
  }
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return code && FILE_INPUT_ERROR_CODES.has(code) ? EXIT.USAGE : EXIT.RUNTIME;
}

export async function push(file: string, flags: PushFlags): Promise<void> {
  const client = getClient();

  let expiresInSeconds: number | null;
  try {
    expiresInSeconds = parseDuration(flags.expires);
  } catch (e) {
    die((e as Error).message, EXIT.USAGE);
  }
  const maxDownloads = Math.max(1, parseInt(flags.max, 10) || 1);
  const graceSeconds = Math.max(0, parseInt(flags.grace, 10) || 0);

  const s = flags.json ? null : spinner();
  s?.start(`Uploading ${basename(file)}…`);

  let uploaded: UploadedFile;
  try {
    uploaded = await client.upload(file, (done, total) => {
      s?.message(`Uploading ${basename(file)}… ${Math.round((done / total) * 100)}%`);
    });
  } catch (e) {
    s?.stop('Upload failed');
    const err = e as Error;
    die(err.message, uploadErrorExit(e));
  }

  if (flags.link === false) {
    s?.stop(`Uploaded ${color.cyan(uploaded.name)} (${formatSize(uploaded.size)})`);
    if (flags.json) {
      console.log(JSON.stringify({ file: uploaded }, null, 2));
      return;
    }
    ok(`No link minted (--no-link). Mint later with \`conduit link ${uploaded.id}\`.`);
    return;
  }

  s?.message('Minting link…');
  let minted: MintResult;
  try {
    minted = await client.mintLink(uploaded.id, { maxDownloads, graceSeconds, expiresInSeconds });
  } catch (e) {
    s?.stop('Mint failed');
    const err = e as ApiError;
    die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
  }
  s?.stop(`${color.cyan(uploaded.name)} (${formatSize(uploaded.size)}) ${color.dim('→')} link ready`);

  if (flags.json) {
    console.log(JSON.stringify({ file: uploaded, link: minted }, null, 2));
    return;
  }
  await presentLink(minted, { copy: flags.copy !== false, qr: !!flags.qr });
}
