import { confirm, isCancel, cancel } from '@clack/prompts';
import { getClient, resolveFile } from '../client';
import { color, ok, die } from '../ui';
import { EXIT } from '../util';
import { ApiError } from '../api';

export interface RmFlags {
  yes?: boolean;
  json?: boolean;
}

export async function rm(ref: string, flags: RmFlags): Promise<void> {
  const client = getClient();
  const file = await resolveFile(client, ref, { allowIdPrefix: false });

  if (!flags.yes) {
    const sure = await confirm({
      message: `Delete ${color.cyan(file.name)} and revoke its ${file.link_count} link(s)?`,
    });
    if (isCancel(sure) || !sure) {
      cancel('Cancelled.');
      process.exit(EXIT.OK);
    }
  }

  try {
    await client.deleteFile(file.id);
  } catch (e) {
    const err = e as ApiError;
    die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
  }
  if (flags.json) {
    console.log(JSON.stringify({ deleted: file }, null, 2));
  } else {
    ok(`Deleted ${color.cyan(file.name)} and revoked its links.`);
  }
}
