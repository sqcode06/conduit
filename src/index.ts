import { Hono } from 'hono';
import type { AppEnv } from './types';
import { download } from './routes/download';
import { admin } from './routes/admin';

const app = new Hono<AppEnv>();

// Public, token-gated download (no Access).
app.route('/', download); // GET|HEAD /d/:token

// Admin API (Cloudflare Access at the edge + in-Worker jose verification).
app.route('/admin/api', admin);

// The Worker is only invoked for /d/* and /admin/api/* (run_worker_first). Anything
// else that reaches it falls back to the static asset server.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
