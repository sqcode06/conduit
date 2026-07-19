// CONDUIT admin — dependency-free control surface.
// Talks to the Worker admin API under /admin/api. Cloudflare Access gates every
// /admin/* route, so no auth UI lives here; a 401/403 means the session lapsed.
"use strict";

const ORIGIN = location.origin;
const API = "/admin/api";        // Worker API base (run_worker_first)
const LINK_BASE = `${ORIGIN}/d/`; // public capability links

// ---- tiny DOM + fetch helpers -------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k));
  return n;
};

async function api(path, opts = {}) {
  const res = await fetch(ORIGIN + API + path, { credentials: "include", ...opts });
  if (res.status === 401 || res.status === 403) {
    // Access session expired — bounce through the Access login flow.
    location.reload();
    throw new Error("auth");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ---- formatting ---------------------------------------------------------------
const KB = 1024;
function fmtSize(bytes) {
  if (bytes == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= KB && i < u.length - 1) { n /= KB; i++; }
  return `${n < 10 && i > 0 ? Number(n.toFixed(1)) : Math.round(n)} ${u[i]}`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtClient(ip, country) {
  const cc = country && country !== "XX" ? country : "??";
  return `${cc} · ${ip || "unknown"}`;
}

// ---- toast --------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast toast--${kind} toast--show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

// ---- file list ----------------------------------------------------------------
async function loadFiles() {
  const tbody = $("#files-body");
  try {
    const files = await listAllFiles();
    tbody.replaceChildren();
    if (!files.length) {
      tbody.append(el("tr", {}, el("td", { className: "empty", colSpan: 5 },
        "No files yet. Drop one above to begin.")));
      return;
    }
    for (const f of files) tbody.append(fileRow(f));
  } catch (e) {
    tbody.replaceChildren(el("tr", {}, el("td", { className: "empty", colSpan: 5 },
      `Could not load files — ${e.message}`)));
  }
}

async function listAllFiles() {
  const pageLimit = 1000;
  const files = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (cursor) query.set("cursor", cursor);
    const page = await api(`/files?${query}`);
    if (!page || !Array.isArray(page.files) || page.files.length > pageLimit) {
      throw new Error("invalid files response");
    }
    files.push(...page.files);
    if (page.next_cursor === null) return files;
    if (page.next_cursor === undefined) {
      if (page.files.length === pageLimit) throw new Error("invalid file pagination");
      return files;
    }
    if (typeof page.next_cursor !== "string" || !page.next_cursor || seenCursors.has(page.next_cursor)) {
      throw new Error("invalid file pagination");
    }
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  } while (cursor);
  return files;
}

function fileRow(f) {
  const mint = el("button", { className: "btn btn--ghost", onclick: () => openMint(f) }, "Mint link");
  const del = el("button", {
    className: "btn btn--danger-ghost",
    title: "Delete file and revoke all its links",
    onclick: () => deleteFile(f),
  }, "Delete");
  return el("tr", { "data-id": f.id },
    el("td", { className: "cell-name" },
      el("span", { className: "fname", title: f.name }, f.name)),
    el("td", { className: "mono dim" }, fmtSize(f.size)),
    el("td", { className: "mono dim" }, fmtTime(f.created_at)),
    el("td", { className: "mono dim num" }, String(f.link_count ?? 0)),
    el("td", { className: "cell-actions" }, mint, del),
  );
}

async function deleteFile(f) {
  if (!confirm(`Delete “${f.name}” and revoke its links? This cannot be undone.`)) return;
  try {
    await api(`/files/${f.id}`, { method: "DELETE" });
    toast(`Deleted ${f.name}`);
    loadFiles();
    loadUsage();
  } catch (e) {
    toast(`Delete failed — ${e.message}`, "err");
  }
}

// ---- storage usage ------------------------------------------------------------
// Limits come from the server (/usage); the bar + dropzone text reflect them.
let limits = { file_limit: 1024 ** 3, total_limit: 10 * 1024 ** 3, part_size: 50 * 1024 * 1024, used_bytes: 0 };

async function loadUsage() {
  try {
    limits = await api("/usage");
  } catch { return; }
  const pct = limits.total_limit ? Math.min(100, Math.round((limits.used_bytes / limits.total_limit) * 100)) : 0;
  $("#usage-text").textContent = `${fmtSize(limits.used_bytes)} / ${fmtSize(limits.total_limit)}`;
  const fill = $("#usage-fill");
  fill.style.width = `${pct}%`;
  fill.dataset.level = pct >= 95 ? "full" : pct >= 80 ? "warn" : "ok";
  $("#drop-sub").innerHTML = `click or drop &middot; single file up to ${fmtSize(limits.file_limit)}`;
}

// ---- upload (drag-drop + picker) ----------------------------------------------
// Small files go single-PUT; large files go through R2 multipart (the only way
// past the ~100 MB Worker request-body limit).
function wireUpload() {
  const zone = $("#drop"), input = $("#file-input");
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { if (input.files[0]) upload(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drop--hot"); }));
  ["dragleave", "drop"].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drop--hot"); }));
  zone.addEventListener("drop", e => { if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
}

async function upload(file) {
  if (file.size > limits.file_limit) {
    toast(`${file.name} is ${fmtSize(file.size)} — over the ${fmtSize(limits.file_limit)} per-file limit`, "err");
    return;
  }
  if (limits.used_bytes + file.size > limits.total_limit) {
    toast(`Not enough storage — only ${fmtSize(Math.max(0, limits.total_limit - limits.used_bytes))} free`, "err");
    return;
  }
  const bar = $("#upload-bar"), wrap = $("#upload-progress");
  wrap.hidden = false; bar.style.width = "0%";
  bar.textContent = `Uploading ${file.name}…`;
  try {
    if (file.size <= limits.part_size) await uploadSingle(file, bar);
    else await uploadMultipart(file, bar);
    toast(`Uploaded ${file.name}`);
    loadFiles();
    loadUsage();
  } catch (e) {
    toast(`Upload failed — ${e.message}`, "err");
  } finally {
    wrap.hidden = true;
  }
}

// One request (XHR so we get an upload-progress event for the bar).
function uploadSingle(file, bar) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ORIGIN + API + "/files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(httpError(xhr)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}

// Chunked R2 multipart upload: init -> upload each slice -> complete (abort on error).
async function uploadMultipart(file, bar) {
  const init = await api("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content_type: file.type || "application/octet-stream", size: file.size }),
  });
  const parts = [];
  let done = 0;
  try {
    let part = 1;
    for (let off = 0; off < file.size; off += init.part_size) {
      const end = Math.min(off + init.part_size, file.size);
      const base = done;
      const url = `${ORIGIN}${API}/uploads/parts?key=${encodeURIComponent(init.key)}` +
        `&upload_id=${encodeURIComponent(init.upload_id)}&part=${part}`;
      parts.push(await putPart(url, file.slice(off, end), loaded => {
        bar.style.width = `${Math.round(((base + loaded) / file.size) * 100)}%`;
      }));
      done = end;
      part++;
    }
    await api("/uploads/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: init.file_id, key: init.key, upload_id: init.upload_id,
        filename: file.name, content_type: file.type || "application/octet-stream", parts,
      }),
    });
  } catch (e) {
    api("/uploads/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: init.key, upload_id: init.upload_id }),
    }).catch(() => {});
    throw e;
  }
}

function putPart(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(JSON.parse(xhr.responseText))
      : reject(httpError(xhr)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(blob);
  });
}

function httpError(xhr) {
  try { return new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`); }
  catch { return new Error(`HTTP ${xhr.status}`); }
}

// ---- mint-link modal ----------------------------------------------------------
let mintFile = null;
function openMint(f) {
  mintFile = f;
  $("#mint-fname").textContent = f.name;
  $("#mint-ttl").value = "24h";
  $("#mint-max").value = "1";
  $("#mint-grace").value = "0";
  $("#mint-result").hidden = true;
  $("#mint-form").hidden = false;
  $("#mint").showModal();
}
function closeMint() { $("#mint").close(); mintFile = null; }

const TTL_SECONDS = { "1h": 3600, "24h": 86400, "7d": 604800, never: null };

async function submitMint(e) {
  e.preventDefault();
  const ttlSel = $("#mint-ttl").value;
  const body = {
    max_downloads: Math.max(1, parseInt($("#mint-max").value, 10) || 1),
    grace_seconds: Math.max(0, parseInt($("#mint-grace").value, 10) || 0),
    expires_in_seconds: TTL_SECONDS[ttlSel], // null === never
  };
  const btn = $("#mint-submit");
  btn.disabled = true; btn.textContent = "Minting…";
  try {
    const link = await api(`/files/${mintFile.id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showMintResult(link);
    loadFiles(); // refresh link_count
  } catch (err) {
    toast(`Mint failed — ${err.message}`, "err");
  } finally {
    btn.disabled = false; btn.textContent = "Mint link";
  }
}

function showMintResult(link) {
  // API returns the raw token exactly once; assemble the full capability URL.
  const url = link.url || `${LINK_BASE}${link.token}`;
  $("#mint-url").value = url;
  const bits = [`max ${link.max_downloads}`];
  bits.push(link.expires_at ? `expires ${fmtTime(link.expires_at)}` : "no expiry");
  if (link.grace_seconds) bits.push(`${link.grace_seconds}s grace`);
  $("#mint-meta").textContent = bits.join(" · ");
  $("#mint-qr").hidden = true;
  $("#mint-form").hidden = true;
  $("#mint-result").hidden = false;
}

async function copyUrl() {
  const input = $("#mint-url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select(); document.execCommand("copy"); // fallback for non-secure contexts
  }
  const b = $("#mint-copy");
  b.textContent = "Copied"; b.classList.add("btn--ok");
  setTimeout(() => { b.textContent = "Copy"; b.classList.remove("btn--ok"); }, 1500);
}

// ---- QR for the minted link --------------------------------------------------
// Rendered client-side (qrcode.js) so the token never leaves the browser.
function renderQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const cell = Math.max(1, Math.floor(canvas.width / total));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const pad = Math.floor((canvas.width - cell * total) / 2) + quiet * cell;
  ctx.fillStyle = "#0a0d10";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
}

function toggleQr() {
  const box = $("#mint-qr");
  if (!box.hidden) { box.hidden = true; return; }
  const url = $("#mint-url").value;
  if (!url) return;
  try {
    renderQr($("#mint-qr-canvas"), url);
    box.hidden = false;
  } catch {
    toast("QR generation failed", "err");
  }
}

function downloadQr() {
  const a = el("a", { download: "conduit-qr.png", href: $("#mint-qr-canvas").toDataURL("image/png") });
  a.click();
}

async function copyQrImage() {
  // Feedback on the button itself — a toast would render behind the <dialog> top layer.
  const b = $("#qr-copy");
  try {
    const blob = await new Promise(r => $("#mint-qr-canvas").toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    b.textContent = "Copied"; b.classList.add("btn--ok");
  } catch {
    b.textContent = "Unsupported";
  }
  setTimeout(() => { b.textContent = "Copy image"; b.classList.remove("btn--ok"); }, 1500);
}

// ---- recent pulls (polling) ---------------------------------------------------
let pullTimer;
async function loadPulls() {
  const body = $("#pulls-body");
  try {
    const { downloads } = await api("/downloads?limit=25");
    body.replaceChildren();
    if (!downloads.length) {
      body.append(el("li", { className: "empty" }, "No pulls yet."));
      return;
    }
    for (const d of downloads) {
      body.append(el("li", { className: "pull" },
        el("span", { className: "pull-dot", "data-status": d.status || "ok" }),
        el("span", { className: "pull-file", title: d.file_name }, d.file_name || "—"),
        el("span", { className: "mono dim pull-who" }, fmtClient(d.ip, d.country)),
        el("span", { className: "mono dim pull-when" }, fmtTime(d.created_at)),
      ));
    }
  } catch {
    body.replaceChildren(el("li", { className: "empty" }, "Pulls unavailable."));
  }
}
function startPulls() {
  loadPulls();
  clearInterval(pullTimer);
  // Pause polling when the tab is hidden to spare the Worker.
  pullTimer = setInterval(() => { if (!document.hidden) loadPulls(); }, 10000);
}

// ---- boot ---------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  wireUpload();
  $("#mint-form").addEventListener("submit", submitMint);
  $("#mint-close").addEventListener("click", closeMint);
  $("#mint-copy").addEventListener("click", copyUrl);
  $("#mint-qr-btn").addEventListener("click", toggleQr);
  $("#qr-download").addEventListener("click", downloadQr);
  $("#qr-copy").addEventListener("click", copyQrImage);
  $("#mint-again").addEventListener("click", () => mintFile && openMint(mintFile));
  // Close modal on backdrop click.
  $("#mint").addEventListener("click", e => { if (e.target === $("#mint")) closeMint(); });
  loadFiles();
  loadUsage();
  startPulls();
});
