import { describe, it, expect } from 'vitest';
import { parseDuration, formatSize, formatUntil, formatRelTime } from '../src/util';

describe('parseDuration', () => {
  it('parses units into seconds', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('24h')).toBe(86400);
    expect(parseDuration('7d')).toBe(604800);
    expect(parseDuration('100')).toBe(100); // bare number = seconds
  });

  it('treats none/never/0 as no expiry', () => {
    expect(parseDuration('none')).toBeNull();
    expect(parseDuration('never')).toBeNull();
    expect(parseDuration('0')).toBeNull();
  });

  it('throws on garbage', () => {
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('5y')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });
});

describe('formatSize', () => {
  it('formats up the scale', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1048576)).toBe('1 MB');
  });

  it('handles null/undefined', () => {
    expect(formatSize(null)).toBe('—');
    expect(formatSize(undefined)).toBe('—');
  });
});

describe('formatUntil', () => {
  it('describes future expiry, no-expiry, and past', () => {
    const inDay = new Date(Date.now() + 86_400_000).toISOString();
    expect(formatUntil(inDay)).toMatch(/^in \d+[mhd]$/);
    expect(formatUntil(null)).toBe('no expiry');
    expect(formatUntil(new Date(Date.now() - 1000).toISOString())).toBe('expired');
  });
});

describe('formatRelTime', () => {
  it('describes past times', () => {
    expect(formatRelTime(new Date().toISOString())).toBe('just now');
    expect(formatRelTime(null)).toBe('—');
  });
});
