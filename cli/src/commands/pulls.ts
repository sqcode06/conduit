import { getClient } from '../client';
import { color, table, dim, die } from '../ui';
import { EXIT, formatRelTime } from '../util';
import { ApiError, type DownloadRow } from '../api';

const STATUS_COLOR: Record<string, (s: string) => string> = {
  ok: color.green,
  spent: color.dim,
  expired: color.dim,
  denied: color.red,
};

export interface PullsFlags {
  limit: string;
  watch?: boolean;
  json?: boolean;
}

export async function pulls(flags: PullsFlags): Promise<void> {
  const client = getClient();
  const limit = Math.max(1, Math.min(200, parseInt(flags.limit, 10) || 25));

  const render = async (clear: boolean): Promise<void> => {
    let rows: DownloadRow[];
    try {
      rows = await client.listDownloads(limit);
    } catch (e) {
      const err = e as ApiError;
      die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
    }
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (clear) process.stdout.write('\x1b[2J\x1b[H');
    if (!rows.length) {
      dim('No pulls yet.');
      return;
    }
    const tableRows = rows.map((d) => {
      const paint = STATUS_COLOR[d.status] ?? ((s: string) => s);
      return [
        `${paint('●')} ${d.status}`,
        d.file_name ?? '—',
        `${d.country ?? '??'} · ${d.ip ?? 'unknown'}`,
        formatRelTime(d.created_at),
      ];
    });
    console.log(table(['STATUS', 'FILE', 'CLIENT', 'WHEN'], tableRows));
  };

  if (flags.watch && !flags.json) {
    for (;;) {
      await render(true);
      console.log(color.dim('\nwatching — Ctrl-C to stop'));
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    await render(false);
  }
}
