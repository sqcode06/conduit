import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { EXIT } from '../src/util';

const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));

vi.mock('../src/client', () => ({
  getClient: () => ({ upload: uploadMock }),
}));

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start() {}, message() {}, stop() {} }),
}));

vi.mock('../src/ui', () => ({
  color: { cyan: (value: string) => value, dim: (value: string) => value },
  ok() {},
  die(message: string, code = 1): never {
    throw Object.assign(new Error(message), { exitCode: code });
  },
}));

import { push, uploadErrorExit } from '../src/commands/push';

describe('uploadErrorExit', () => {
  it('keeps network failures distinct from usage errors', () => {
    expect(uploadErrorExit(new ApiError('cannot reach endpoint', 0))).toBe(EXIT.RUNTIME);
  });

  it('classifies authentication and capacity failures', () => {
    expect(uploadErrorExit(new ApiError('unauthorized', 401, true))).toBe(EXIT.AUTH);
    expect(uploadErrorExit(new ApiError('over limit', 0, false, true))).toBe(EXIT.USAGE);
  });

  it('treats invalid local file inputs as usage errors', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(uploadErrorExit(missing)).toBe(EXIT.USAGE);
    expect(uploadErrorExit(new Error('disk I/O failed'))).toBe(EXIT.RUNTIME);
  });
});

describe('push', () => {
  it('preserves a useful message when upload rejects with a non-Error value', async () => {
    uploadMock.mockRejectedValueOnce('backend rejected the upload');

    await expect(
      push('payload.bin', { expires: '1h', max: '1', grace: '0' }),
    ).rejects.toMatchObject({
      message: 'backend rejected the upload',
      exitCode: EXIT.RUNTIME,
    });
  });
});
