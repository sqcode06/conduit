import type { AppContext } from '../types';
import { nowSeconds } from './tokens';

export interface DownloadAudit {
  link_id: string | null;
  file_id: string | null;
  status: 'ok' | 'spent' | 'expired' | 'denied';
  denied_reason?: string | null;
  range_start?: number | null;
  range_end?: number | null;
  bytes_sent?: number | null;
}

// D1 rejects `undefined` bindings; coalesce everything to null.
function nn<T>(v: T | undefined | null): T | null {
  return v === undefined || v === null ? null : v;
}

function cfStr(cf: Record<string, unknown>, key: string): string | null {
  const v = cf[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Append-only audit of one pull attempt. Geo/device come from request.cf, the
// recipient IP from CF-Connecting-IP. Called via ctx.waitUntil so it never blocks
// the stream. The raw token is NEVER logged.
export async function recordDownload(c: AppContext, a: DownloadAudit): Promise<void> {
  const cf = (c.req.raw.cf ?? {}) as Record<string, unknown>;
  const asnRaw = cf.asn;
  const asn = typeof asnRaw === 'number' ? asnRaw : null;

  await c.env.DB.prepare(
    `INSERT INTO downloads (
       id, link_id, file_id, ts, status, denied_reason, ip, user_agent,
       country, city, region, region_code, postal_code, continent,
       latitude, longitude, timezone, asn, as_organization, colo,
       range_header, range_start, range_end, bytes_sent
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
  )
    .bind(
      crypto.randomUUID(),
      nn(a.link_id),
      nn(a.file_id),
      nowSeconds(),
      a.status,
      nn(a.denied_reason),
      nn(c.req.header('CF-Connecting-IP')),
      nn(c.req.header('User-Agent')),
      cfStr(cf, 'country'),
      cfStr(cf, 'city'),
      cfStr(cf, 'region'),
      cfStr(cf, 'regionCode'),
      cfStr(cf, 'postalCode'),
      cfStr(cf, 'continent'),
      cfStr(cf, 'latitude'),
      cfStr(cf, 'longitude'),
      cfStr(cf, 'timezone'),
      asn,
      cfStr(cf, 'asOrganization'),
      cfStr(cf, 'colo'),
      nn(c.req.header('Range')),
      nn(a.range_start),
      nn(a.range_end),
      nn(a.bytes_sent),
    )
    .run();
}
