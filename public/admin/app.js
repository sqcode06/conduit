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
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
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
    const { files } = await api("/files");
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
  } catch (e) {
    toast(`Delete failed — ${e.message}`, "err");
  }
}

// ---- upload (drag-drop + picker) ----------------------------------------------
const MAX_BYTES = 100 * 1024 * 1024; // CF Free/Pro request-body cap; single PUT slice.

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
  if (file.size > MAX_BYTES) {
    toast(`${file.name} is ${fmtSize(file.size)} — over the ${fmtSize(MAX_BYTES)} slice limit`, "err");
    return;
  }
  const bar = $("#upload-bar"), wrap = $("#upload-progress");
  wrap.hidden = false; bar.style.width = "0%";
  bar.textContent = `Distilling ${file.name}…`;
  try {
    // XHR for upload progress; fetch lacks an upload-progress event.
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", ORIGIN + API + "/files");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      // Worker reads the intended filename from this header (body is the raw blob).
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`HTTP ${xhr.status}`)));
      xhr.onerror = () => reject(new Error("network"));
      xhr.send(file);
    });
    toast(`Uploaded ${file.name}`);
    loadFiles();
  } catch (e) {
    toast(`Upload failed — ${e.message}`, "err");
  } finally {
    wrap.hidden = true;
  }
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
  $("#mint-again").addEventListener("click", () => mintFile && openMint(mintFile));
  // Close modal on backdrop click.
  $("#mint").addEventListener("click", e => { if (e.target === $("#mint")) closeMint(); });
  loadFiles();
  startPulls();
});
