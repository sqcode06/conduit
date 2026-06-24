// Sanitizers for client-supplied upload metadata. Both defend the download response
// headers (Content-Disposition / Content-Type) against control-char / CR-LF injection
// and cap length. The R2 object key is always a server-generated UUID, so a filename
// can never influence the storage path.

export function sanitizeFilename(raw: string | undefined): string {
  if (!raw) return 'file';
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars (blocks header injection)
    .replace(/[\\/]/g, '_') // path separators
    .replace(/^\.+/, '') // leading dots
    .trim();
  return name.slice(0, 255) || 'file';
}

export function sanitizeContentType(raw: string | undefined): string {
  if (!raw) return 'application/octet-stream';
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255);
  return cleaned || 'application/octet-stream';
}
