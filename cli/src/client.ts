import { loadConfig } from './config';
import { ConduitClient, ApiError, type FileRow } from './api';
import { die } from './ui';
import { EXIT } from './util';

// Build a client from config, or exit with a helpful message.
export function getClient(): ConduitClient {
  try {
    return new ConduitClient(loadConfig());
  } catch (e) {
    const err = e as ApiError;
    die(err.message, EXIT.AUTH);
  }
}

// Resolve a file by exact id, exact name, or unambiguous id prefix.
export async function resolveFile(client: ConduitClient, ref: string): Promise<FileRow> {
  let files: FileRow[];
  try {
    files = await client.listFiles();
  } catch (e) {
    const err = e as ApiError;
    die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
  }

  const byId = files.find((f) => f.id === ref);
  if (byId) return byId;

  const byName = files.filter((f) => f.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) die(`multiple files named "${ref}" — use the file id (\`conduit ls\`)`, EXIT.USAGE);

  const byPrefix = files.filter((f) => f.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) die(`ambiguous id prefix "${ref}"`, EXIT.USAGE);

  die(`no file matching "${ref}" (see \`conduit ls\`)`, EXIT.USAGE);
}
