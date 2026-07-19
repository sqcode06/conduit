import { Command } from 'commander';
import { login } from './commands/login';
import { doctor } from './commands/doctor';
import { push } from './commands/push';
import { ls } from './commands/ls';
import { link } from './commands/link';
import { pulls } from './commands/pulls';
import { rm } from './commands/rm';
import { qr } from './commands/qr';
import { menu } from './menu';
import { VERSION } from './version';

const program = new Command();

program
  .name('conduit')
  .description('Send single-use file links from your terminal.')
  .version(VERSION, '-v, --version');

program
  .command('login')
  .description('configure the endpoint and Access service token')
  .option('--endpoint <url>', 'CONDUIT endpoint URL')
  .option('--client-id <id>', 'Access service token Client ID')
  .option('--client-secret-stdin', 'read the Access Client Secret from standard input')
  .action((opts) =>
    login({
      endpoint: opts.endpoint,
      clientId: opts.clientId,
      clientSecretStdin: opts.clientSecretStdin,
    }),
  );

program
  .command('doctor')
  .description('check configuration, connectivity, and auth')
  .action(doctor);

program
  .command('push')
  .argument('<file>', 'path to the file to upload')
  .description('upload a file and mint a single-use link')
  .option('-e, --expires <dur>', 'link TTL, e.g. 24h, 7d, none', '24h')
  .option('-m, --max <n>', 'max downloads', '1')
  .option('-g, --grace <sec>', 'resume grace window in seconds', '0')
  .option('--qr', 'also render a QR code of the link')
  .option('--no-copy', 'do not copy the link to the clipboard')
  .option('--no-link', 'upload only; do not mint a link')
  .option('--json', 'output JSON')
  .action((file, opts) => push(file, opts));

program
  .command('ls')
  .description('list uploaded files')
  .option('--json', 'output JSON')
  .action((opts) => ls(opts));

program
  .command('link')
  .argument('<file>', 'file id or name')
  .description('mint a link for an existing file')
  .option('-e, --expires <dur>', 'link TTL, e.g. 24h, 7d, none', '24h')
  .option('-m, --max <n>', 'max downloads', '1')
  .option('-g, --grace <sec>', 'resume grace window in seconds', '0')
  .option('--qr', 'also render a QR code of the link')
  .option('--no-copy', 'do not copy the link to the clipboard')
  .option('--json', 'output JSON')
  .action((file, opts) => link(file, opts));

program
  .command('pulls')
  .description('show recent downloads')
  .option('-n, --limit <n>', 'number of entries', '25')
  .option('-w, --watch', 'live-refresh every 5s')
  .option('--json', 'output JSON')
  .action((opts) => pulls(opts));

program
  .command('rm')
  .argument('<file>', 'file id or name')
  .description('delete a file and revoke its links')
  .option('-y, --yes', 'skip confirmation')
  .option('--json', 'output JSON')
  .action((file, opts) => rm(file, opts));

program
  .command('qr')
  .argument('[url]', 'URL to encode (defaults to the last minted link)')
  .description('render a QR code for a URL or the last minted link')
  .action((url) => qr(url));

// Bare invocation -> interactive menu.
program.action(() => menu());

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
