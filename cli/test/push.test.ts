import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { uploadErrorExit } from '../src/commands/push';
import { EXIT } from '../src/util';

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
