import { getClient } from '../client';
import { table, dim, die } from '../ui';
import { EXIT, formatSize, formatRelTime } from '../util';
import { ApiError, type FileRow } from '../api';

export async function ls(flags: { json?: boolean }): Promise<void> {
  const client = getClient();

  let files: FileRow[];
  try {
    files = await client.listFiles();
  } catch (e) {
    const err = e as ApiError;
    die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
  }

  if (flags.json) {
    console.log(JSON.stringify(files, null, 2));
    return;
  }
  if (!files.length) {
    dim('No files yet — upload one with `conduit push <file>`.');
    return;
  }
  const rows = files.map((f) => [
    f.name,
    formatSize(f.size),
    formatRelTime(f.created_at),
    String(f.link_count),
  ]);
  console.log(table(['NAME', 'SIZE', 'AGE', 'LINKS'], rows));
}
