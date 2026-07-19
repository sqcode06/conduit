import { describe, expect, it } from 'vitest';
import { clientSecretFromStdin, loginEndpointPrompt } from '../src/commands/login';

describe('login endpoint prompt', () => {
  it('requires an explicit self-hosted endpoint for a clean configuration', () => {
    const prompt = loginEndpointPrompt({});

    expect(prompt.message).toContain('self-hosted');
    expect(prompt.placeholder).toBe('https://conduit.example.com');
    expect(prompt.initialValue).toBe('');
    expect(prompt.validate('https://conduit.example.com')).toBeUndefined();
    expect(prompt.validate('http://conduit.example.com')).toContain('must use HTTPS');
  });

  it('prefills only an endpoint the user already configured', () => {
    const prompt = loginEndpointPrompt({ endpoint: 'https://files.example.net' });

    expect(prompt.initialValue).toBe('https://files.example.net');
  });
});

describe('client secret from stdin', () => {
  it('accepts a non-empty secret and removes its trailing newline', () => {
    expect(clientSecretFromStdin('secret-value\n')).toBe('secret-value');
  });

  it.each(['', '\n', '   \r\n'])('rejects empty input without falling back to a prompt', (input) => {
    expect(() => clientSecretFromStdin(input)).toThrow(
      'Access Client Secret from standard input must not be empty',
    );
  });
});
