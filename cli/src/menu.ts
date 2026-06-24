import { intro, outro, select, text, isCancel } from '@clack/prompts';
import { color } from './ui';
import { push } from './commands/push';
import { ls } from './commands/ls';
import { pulls } from './commands/pulls';
import { rm } from './commands/rm';
import { link } from './commands/link';
import { doctor } from './commands/doctor';

// Bare `conduit` invocation: a small looping menu. Direct subcommands are the
// path for scripting; this is the friendly one.
export async function menu(): Promise<void> {
  intro(color.bold(color.cyan('CONDUIT')));
  for (;;) {
    const action = await select({
      message: 'What do you want to do?',
      options: [
        { value: 'push', label: 'Push a file', hint: 'upload + mint a link' },
        { value: 'ls', label: 'List files' },
        { value: 'pulls', label: 'Recent pulls' },
        { value: 'link', label: 'Mint a link for a file' },
        { value: 'rm', label: 'Delete a file' },
        { value: 'doctor', label: 'Doctor' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (isCancel(action) || action === 'quit') {
      outro('Bye.');
      return;
    }
    try {
      if (action === 'push') {
        const f = await text({ message: 'File path' });
        if (isCancel(f)) continue;
        await push(f, { expires: '24h', max: '1', grace: '0', copy: true });
      } else if (action === 'ls') {
        await ls({});
      } else if (action === 'pulls') {
        await pulls({ limit: '25' });
      } else if (action === 'link') {
        const f = await text({ message: 'File id or name' });
        if (isCancel(f)) continue;
        await link(f, { expires: '24h', max: '1', grace: '0', copy: true });
      } else if (action === 'rm') {
        const f = await text({ message: 'File id or name' });
        if (isCancel(f)) continue;
        await rm(f, {});
      } else if (action === 'doctor') {
        await doctor();
      }
    } catch (e) {
      console.error(color.red((e as Error).message));
    }
    console.log();
  }
}
