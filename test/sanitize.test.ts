import { describe, it, expect } from 'vitest';
import { sanitizeFilename, sanitizeContentType } from '../src/lib/sanitize';

describe('sanitizeFilename', () => {
  it('removes path separators (no traversal)', () => {
    const out = sanitizeFilename('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('strips control characters and CR/LF', () => {
    expect(sanitizeFilename('a\r\nb\t.txt')).toBe('ab.txt');
  });

  it('decodes percent-encoding and keeps unicode', () => {
    expect(sanitizeFilename(encodeURIComponent('résumé final.pdf'))).toBe('résumé final.pdf');
  });

  it('falls back to "file" when empty', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename(undefined)).toBe('file');
  });
});

describe('sanitizeContentType', () => {
  it('strips CR/LF so it cannot inject a header or throw on set', () => {
    const out = sanitizeContentType('text/html\r\nX-Injected: 1');
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('defaults when missing or empty', () => {
    expect(sanitizeContentType('')).toBe('application/octet-stream');
    expect(sanitizeContentType(undefined)).toBe('application/octet-stream');
  });
});
