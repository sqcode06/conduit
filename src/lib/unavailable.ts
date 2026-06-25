// Neutral "link unavailable" page. Byte-identical for every denial reason
// (not found / expired / spent / revoked) so it can never be used to probe which
// tokens once existed. Served as HTTP 200 — never 403/404 — with no-store + noindex.
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Link unavailable</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; }
  body {
    background:
      radial-gradient(900px 420px at 78% -10%, rgba(33,230,193,.06), transparent 60%),
      #0a0d10;
    color:#e8edf2;
    font:15px/1.6 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display:grid; place-items:center; min-height:100%;
  }
  .card {
    max-width:420px; margin:24px; padding:34px 30px; text-align:center;
    background:#0f1419; border:1px solid #1e2730; border-radius:12px;
  }
  .glyph { font:700 26px/1 ui-monospace,"JetBrains Mono",Menlo,monospace; color:#21e6c1; letter-spacing:.22em; }
  h1 { font-size:18px; margin:18px 0 8px; font-weight:600; }
  p { color:#8a99a8; font-size:13.5px; margin:0; }
</style>
</head>
<body>
  <div class="card">
    <div class="glyph" aria-hidden="true">&#8631;</div>
    <h1>This link is no longer available</h1>
    <p>It may have already been used, expired, or never existed. If you still need the file, ask the sender for a fresh link.</p>
  </div>
</body>
</html>`;

export function unavailableResponse(): Response {
  return new Response(HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
