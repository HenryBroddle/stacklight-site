// Trace-photo upload (DECISIONS D5): the browser redraws the picture through a canvas first, which applies the
// EXIF orientation, drops every metadata block (EXIF, GPS, camera serials) and caps the long side at 4096 px; the
// clean pixels go to POST /api/assets (edit token; jpeg/png/webp ≤ 15 MB) as a raw image body.

const MAX_SIDE = 4096;
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPT = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Decode a File/Blob with EXIF orientation applied. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));

/**
 * Re-encode an image file: orientation applied, metadata stripped, long side ≤ 4096 px.
 * @param {File|Blob} file
 * @returns {Promise<{ blob: Blob, type: string, width: number, height: number, name: string }>}
 */
export async function prepareImage(file, { maxSide = MAX_SIDE } = {}) {
  if (!file || !(file instanceof Blob)) throw new Error('No file');
  if (file.type && !file.type.startsWith('image/')) throw new Error('That file is not a picture');
  let bmp;
  try {
    bmp = await decode(file);
  } catch {
    throw new Error('This browser cannot read that picture (HEIC photos: export as JPEG first)');
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error('The picture is empty');
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const png = file.type === 'image/png';
  if (!png) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); } // JPEG has no alpha
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  let type = png ? 'image/png' : 'image/jpeg';
  let blob = await toBlob(canvas, type, 0.88);
  if (!blob || blob.size > MAX_BYTES) {
    if (png) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    type = 'image/jpeg';
    blob = await toBlob(canvas, type, 0.82);
  }
  if (!blob) throw new Error('The picture could not be converted');
  if (blob.size > MAX_BYTES) throw new Error('The picture is too large even after shrinking (max 15 MB)');
  const base = String(file.name || 'trace-photo').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trace-photo';
  return { blob, type, width: w, height: h, name: base };
}

/**
 * Upload a prepared image to POST /api/assets?name=… (raw body). On 401 asks for the token once and retries.
 * @param {object} api  public/js/api.js module
 * @param {{ blob: Blob, type: string, name: string }} prepared
 * @param {{ requestToken: (reason: string) => Promise<string|null>, localEdit?: boolean }} o  localEdit: no token needed
 *   up front (the HUD computer itself, D9 amendment); a 401 still asks for it
 * @returns {Promise<{ src: string, url: string, width: number, height: number, bytes: number, existed: boolean }>}
 */
export async function uploadImage(api, prepared, { requestToken, localEdit = false }) {
  if (!ACCEPT.has(prepared.type)) throw new Error('Only JPEG, PNG and WebP pictures can be uploaded');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = api.getEditToken();
    if (!token && !(localEdit && attempt === 0)) {
      const t = await requestToken('Uploading a photo needs the edit token.');
      if (!t) throw Object.assign(new Error('Upload cancelled'), { cancelled: true });
    }
    const headers = { 'Content-Type': prepared.type, Accept: 'application/json' };
    const tk = api.getEditToken();
    if (tk) headers.Authorization = `Bearer ${tk}`;
    let res;
    try {
      res = await fetch(`/api/assets?name=${encodeURIComponent(prepared.name)}`, { method: 'POST', headers, body: prepared.blob, cache: 'no-store', credentials: 'same-origin' });
    } catch {
      throw new Error('Network error while uploading the photo');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 && attempt === 0) {
      const t = await requestToken('The edit token was not accepted. Paste it again to upload the photo.');
      if (!t) throw Object.assign(new Error('Upload cancelled'), { cancelled: true });
      continue;
    }
    if (!res.ok) throw new Error(data?.message || `Upload failed (${res.status})`);
    if (!data || typeof data.src !== 'string') throw new Error('Unexpected answer from the server');
    return data;
  }
  throw new Error('Upload failed');
}

/**
 * Initial placement for a new photo: as wide as the drawing (keeping its aspect ratio), centred on it.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function initialPlacement(doc, width, height) {
  const W = Number.isFinite(doc.width) ? doc.width : 80;
  const H = Number.isFinite(doc.height) ? doc.height : 60;
  const aspect = width > 0 && height > 0 ? width / height : 4 / 3;
  let w = W * 1.05, h = w / aspect;
  if (h > H * 1.05 * 1.6) { h = H * 1.05; w = h * aspect; }
  const r = (v) => Math.round(v * 100) / 100;
  return { x: r(W / 2 - w / 2), y: r(H / 2 - h / 2), width: r(w), height: r(h) };
}
