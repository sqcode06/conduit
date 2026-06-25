import { loadConfig, configPath } from '../config';
import { ConduitClient, ApiError } from '../api';
import { color, glyph } from '../ui';
import { EXIT, formatSize } from '../util';

export async function doctor(): Promise<void> {
  const cfg = loadConfig();
  let allOk = true;

  if (cfg.endpoint) {
    console.log(`${glyph.ok} endpoint   ${color.dim(cfg.endpoint)}`);
  } else {
    console.log(`${glyph.err} endpoint   ${color.dim(`not set — run \`conduit login\` (${configPath})`)}`);
    allOk = false;
  }

  const hasToken = !!(cfg.accessClientId && cfg.accessClientSecret);
  console.log(
    `${hasToken ? glyph.ok : glyph.warn} token      ${color.dim(
      hasToken ? 'Access service token set' : 'none — only ok for an unprotected / dev endpoint',
    )}`,
  );

  if (cfg.endpoint) {
    try {
      const client = new ConduitClient(cfg);
      const who = await client.whoami();
      console.log(`${glyph.ok} auth       ${color.dim(`authenticated as ${who.identity}`)}`);
      const u = await client.usage();
      const pct = u.total_limit ? Math.round((u.used_bytes / u.total_limit) * 100) : 0;
      console.log(
        `${glyph.ok} storage    ${color.dim(
          `${formatSize(u.used_bytes)} / ${formatSize(u.total_limit)} (${pct}%) · ${u.count} file(s)`,
        )}`,
      );
    } catch (e) {
      console.log(`${glyph.err} auth       ${color.dim((e as ApiError).message)}`);
      allOk = false;
    }
  }

  console.log();
  if (allOk) {
    console.log(`${glyph.ok} ${color.green('All systems go.')}`);
  } else {
    console.log(`${glyph.err} ${color.red('Some checks failed.')}`);
    process.exitCode = EXIT.AUTH;
  }
}
