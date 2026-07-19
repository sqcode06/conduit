import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { normalizeTeamOrigin, requireAccess } from '../src/lib/access';
import type { AppEnv } from '../src/types';

// Unit-test the Access guard in isolation by injecting env via app.request(). These
// exercise the deny-by-default paths that never reach jose (no network needed).
function app() {
  const a = new Hono<AppEnv>();
  a.use('*', requireAccess());
  a.get('/x', (c) => c.text(c.get('adminEmail')));
  return a;
}

const cfg = { ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud' };

describe('normalizeTeamOrigin', () => {
  it('accepts a team slug or canonical HTTPS Access origin', () => {
    expect(normalizeTeamOrigin('team-name')).toBe('https://team-name.cloudflareaccess.com');
    expect(normalizeTeamOrigin('https://team-name.cloudflareaccess.com/')).toBe(
      'https://team-name.cloudflareaccess.com',
    );
  });

  it.each([
    'http://team.cloudflareaccess.com',
    'https://team.cloudflareaccess.com.evil.test',
    'https://team.cloudflareaccess.com:444',
    'https://team.cloudflareaccess.com/path',
    'https://user@team.cloudflareaccess.com',
    'team.cloudflareaccess.com',
  ])('rejects a non-canonical Access origin: %s', (value) => {
    expect(normalizeTeamOrigin(value)).toBeNull();
  });
});

describe('requireAccess (deny-by-default)', () => {
  it('authorizes via the dev bypass in non-production', async () => {
    const res = await app().request('/x', undefined, {
      ...cfg,
      ENVIRONMENT: 'development',
      DEV_ADMIN_BYPASS: 'true',
      DEV_ADMIN_EMAIL: 'dev@local',
    } as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('dev@local');
  });

  it('ignores the dev bypass in production (structurally dead)', async () => {
    const res = await app().request('/x', undefined, {
      ...cfg,
      ENVIRONMENT: 'production',
      DEV_ADMIN_BYPASS: 'true',
      DEV_ADMIN_EMAIL: 'dev@local',
    } as never);
    expect(res.status).toBe(403);
  });

  it('fails closed when Access is unconfigured', async () => {
    const res = await app().request('/x', undefined, {
      ENVIRONMENT: 'production',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
    } as never);
    expect(res.status).toBe(403);
  });

  it('denies a missing Access JWT', async () => {
    const res = await app().request('/x', undefined, { ...cfg, ENVIRONMENT: 'production' } as never);
    expect(res.status).toBe(403);
  });

  it('denies a malformed Access JWT', async () => {
    const res = await app().request(
      '/x',
      { headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' } },
      { ...cfg, ENVIRONMENT: 'production' } as never,
    );
    expect(res.status).toBe(403);
  });
});
