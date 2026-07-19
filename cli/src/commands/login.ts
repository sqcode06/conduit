import { intro, outro, text, password, isCancel, cancel, spinner } from '@clack/prompts';
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig, configPath, type Config } from '../config';
import { ConduitClient, ApiError, normalizeEndpoint } from '../api';
import { color, ok, die } from '../ui';
import { EXIT } from '../util';

export interface LoginFlags {
  endpoint?: string;
  clientId?: string;
  clientSecretStdin?: boolean;
}

export function loginEndpointPrompt(current: Config) {
  return {
    message: 'Your self-hosted CONDUIT endpoint',
    placeholder: 'https://conduit.example.com',
    initialValue: current.endpoint ?? '',
    validate: (value: string | undefined) => {
      try {
        normalizeEndpoint(value ?? '');
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    },
  };
}

export async function login(flags: LoginFlags): Promise<void> {
  const current = loadConfig();
  let endpoint = flags.endpoint;
  let clientId = flags.clientId;
  let clientSecret: string | undefined;

  if (!endpoint || !clientId || !flags.clientSecretStdin) {
    intro(color.cyan('conduit login'));

    if (!endpoint) {
      const v = await text(loginEndpointPrompt(current));
      if (isCancel(v)) return cancelled();
      endpoint = v;
    }
  }

  try {
    endpoint = normalizeEndpoint(endpoint ?? '');
  } catch (error) {
    die((error as Error).message, EXIT.USAGE);
  }

  if (flags.clientSecretStdin) {
    clientSecret = readFileSync(0, 'utf8').trimEnd();
  }

  if (!clientId || !clientSecret) {
    if (!clientId) {
      const v = await text({
        message: 'Access Client ID',
        placeholder: 'xxxx…access',
        initialValue: current.accessClientId ?? '',
      });
      if (isCancel(v)) return cancelled();
      clientId = v;
    }
    if (!clientSecret) {
      const v = await password({ message: 'Access Client Secret (input hidden)' });
      if (isCancel(v)) return cancelled();
      clientSecret = v;
    }
  }

  const cfg: Config = {
    endpoint,
    accessClientId: clientId || undefined,
    accessClientSecret: clientSecret || undefined,
  };

  const s = spinner();
  s.start('Verifying…');
  try {
    const who = await new ConduitClient(cfg).whoami();
    s.stop(`Authenticated as ${color.cyan(who.identity)}`);
  } catch (e) {
    s.stop('Verification failed');
    const err = e as ApiError;
    die(err.message, err.auth ? EXIT.AUTH : EXIT.RUNTIME);
  }

  saveConfig(cfg);
  ok(`Saved to ${color.dim(configPath)}`);
  outro('Ready — try `conduit push <file>`.');
}

function cancelled(): void {
  cancel('Cancelled.');
  process.exit(EXIT.OK);
}
