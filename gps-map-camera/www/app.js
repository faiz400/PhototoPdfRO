/* GPS Map Camera - standalone Android app.
 * Captures a photo (camera or gallery), stamps it with a timestamp,
 * coordinates, reverse-geocoded address, and a small map thumbnail, then
 * downscales to ~8MP and re-compresses before saving/sharing.
 */
const APP_VERSION = '1.0.0';

window.addEventListener('error', (e) => {
  alert('Unexpected error: ' + (e.error && e.error.message ? e.error.message : e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  alert('Unexpected error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

const { Filesystem, Camera, Share, Geolocation } = Capacitor.Plugins;
// See mobile/www/app.js in the audit project for why these are hardcoded
// rather than imported - they're TS enums from the npm packages, not
// native plugins, so they don't exist on Capacitor.Plugins at runtime.
const Directory = { Data: 'DATA' };
const CameraResultType = { Uri: 'uri' };
const CameraSource = { Camera: 'CAMERA', Photos: 'PHOTOS' };

// 8MP at a typical 4:3 sensor ratio. Passed to the native camera/gallery
// resize option (see onCapture) so Android downscales before the photo
// even reaches the webview - same reasoning as the audit app's photo
// pipeline: native Bitmap resize is much faster than decoding a full
// 12-108MP original in a JS canvas.
const TARGET_MP = 8_000_000;
const TARGET_W = 3264;
const TARGET_H = 2448; // 3264*2448 ≈ 7.99MP
const JPEG_QUALITY_START = 0.85;
const JPEG_QUALITY_FLOOR = 0.55;
const TARGET_MAX_BYTES = 2 * 1024 * 1024; // try to land under ~2MB

let lastPosition = null;
let watchId = null;

document.getElementById('versionTag').textContent = `v${APP_VERSION}`;

function setLocStatus(text, ok) {
  const el = document.getElementById('locStatus');
  el.textContent = text;
  el.className = ok === true ? 'ok' : ok === false ? 'bad' : '';
}

async function startLocationWatch() {
  try {
    await Geolocation.requestPermissions();
    setLocStatus('locating…');
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 15000 }, (pos, err) => {
      if (err || !pos) {
        setLocStatus('unavailable', false);
        return;
      }
      lastPosition = pos;
      setLocStatus(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`, true);
    });
  } catch (e) {
    setLocStatus('permission denied', false);
  }
}

// --- Reverse geocoding + static map tile (both via free, no-key OSM services) ---

async function reverseGeocode(lat, lon) {
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.display_name || null;
  } catch (e) {
    return null; // no internet right now - the stamp falls back to coordinates only
  }
}

async function fetchStaticMapImage(lat, lon, widthPx, heightPx) {
  try {
    const url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=15&size=${widthPx}x${heightPx}&maptype=mapnik&markers=${lat},${lon},red-pushpin`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await createImageBitmap(blob);
  } catch (e) {
    return null; // best-effort - the stamp just omits the map tile if this fails
  }
}

// --- Capture ---

document.getElementById('captureBtn').addEventListener('click', () => runCapture('camera'));
document.getElementById('pickBtn').addEventListener('click', () => runCapture('gallery'));

async function runCapture(mode) {
  const overlay = document.getElementById('busyOverlay');
  const label = document.getElementById('busyLabel');
  overlay.classList.add('active');
  label.textContent = 'Opening camera…';

  let webPath;
  try {
    if (mode === 'camera') {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        quality: 92,
        width: TARGET_W,
        height: TARGET_H,
      });
      webPath = photo.webPath;
    } else {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Photos,
        quality: 92,
        width: TARGET_W,
        height: TARGET_H,
      });
      webPath = photo.webPath;
    }
  } catch (e) {
    overlay.classList.remove('active');
    return; // user cancelled - not an error
  }

  try {
    label.textContent = 'Getting location…';
    const position = lastPosition || (await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 }).catch(() => null));
    const lat = position ? position.coords.latitude : null;
    const lon = position ? position.coords.longitude : null;

    label.textContent = 'Looking up address…';
    const address = lat != null ? await reverseGeocode(lat, lon) : null;

    label.textContent = 'Fetching map…';
    const mapBitmap = lat != null ? await fetchStaticMapImage(lat, lon, 240, 240) : null;

    label.textContent = 'Stamping photo…';
    const { blob, width, height } = await stampPhoto(webPath, { lat, lon, address, mapBitmap, timestamp: new Date() });

    label.textContent = 'Saving…';
    const filename = `GPSCam-${Date.now()}.jpg`;
    const base64 = await blobToBase64(blob);
    const writeResult = await Filesystem.writeFile({
      path: filename,
      directory: Directory.Data,
      data: base64,
      recursive: true,
    });

    addToGallery({ filename, uri: writeResult.uri, blob, width, height, lat, lon, address });
  } catch (e) {
    alert('Could not process that photo: ' + e.message);
  } finally {
    overlay.classList.remove('active');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- Stamping: draw the photo + a bottom watermark bar (map + text), then
// re-encode, stepping the JPEG quality down if the result is still large. ---

async function stampPhoto(webPath, { lat, lon, address, mapBitmap, timestamp }) {
  const resp = await fetch(webPath);
  const srcBlob = await resp.blob();
  const bitmap = await createImageBitmap(srcBlob, { imageOrientation: 'from-image' });

  try {
    // Native capture already targeted ~8MP via width/height above; this
    // is just a safety net in case a gallery pick comes in larger.
    const scale = Math.min(1, Math.sqrt(TARGET_MP / (bitmap.width * bitmap.height)));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);

    drawStampBar(ctx, w, h, { lat, lon, address, mapBitmap, timestamp });

    let quality = JPEG_QUALITY_START;
    let blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    while (blob.size > TARGET_MAX_BYTES && quality > JPEG_QUALITY_FLOOR) {
      quality -= 0.1;
      blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    }
    return { blob, width: w, height: h };
  } finally {
    bitmap.close();
  }
}

function drawStampBar(ctx, w, h, { lat, lon, address, mapBitmap, timestamp }) {
  const barHeight = Math.round(h * 0.16);
  const barY = h - barHeight;
  const pad = Math.round(barHeight * 0.12);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, barY, w, barHeight);

  let textX = pad;
  const mapSize = barHeight - pad * 2;
  if (mapBitmap) {
    ctx.drawImage(mapBitmap, pad, barY + pad, mapSize, mapSize);
    textX = pad * 2 + mapSize;
  }

  const lines = [];
  lines.push(timestamp.toLocaleString());
  if (lat != null) {
    lines.push(`Lat ${lat.toFixed(6)}, Long ${lon.toFixed(6)}`);
  } else {
    lines.push('Location unavailable');
  }
  if (address) lines.push(address);

  const fontSize = Math.max(12, Math.round(barHeight * 0.2));
  ctx.fillStyle = '#fff';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  const maxTextWidth = w - textX - pad;
  let y = barY + pad;
  for (const line of lines) {
    const wrapped = wrapText(ctx, line, maxTextWidth);
    for (const wline of wrapped) {
      if (y + fontSize > barY + barHeight - 2) break;
      ctx.fillText(wline, textX, y);
      y += fontSize * 1.15;
    }
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2); // keep the stamp bar compact
}

// --- In-session gallery (memory only - each photo is already saved to
// disk individually as soon as it's stamped, this is just the on-screen list) ---

function addToGallery({ filename, uri, blob, lat, lon, address }) {
  const gallery = document.getElementById('gallery');
  const url = URL.createObjectURL(blob);
  const div = document.createElement('div');
  div.className = 'shot';
  const sizeKb = Math.round(blob.size / 1024);
  div.innerHTML = `
    <img src="${url}" />
    <div class="meta">${escapeHtml(address || (lat != null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : 'No location'))} &middot; ${sizeKb} KB</div>
    <div class="actions">
      <button data-action="share">Share</button>
    </div>
  `;
  div.querySelector('[data-action="share"]').addEventListener('click', async () => {
    try {
      await Share.share({ title: filename, url: uri });
    } catch (e) { /* user cancelled share sheet */ }
  });
  gallery.prepend(div);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

startLocationWatch();
