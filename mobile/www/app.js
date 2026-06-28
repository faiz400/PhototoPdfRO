/* RO Audit Photo App - standalone offline build.
 * Everything here runs entirely on-device: photo capture, storage, and PDF
 * generation. Nothing is sent over the network. The only "sharing" happens
 * at the very end, when the user explicitly shares/saves the finished PDF.
 */
const APP_VERSION = '1.2.0';

// Surface anything unexpected as a visible alert instead of a silent
// freeze - there's no remote debugger available in the field.
window.addEventListener('error', (e) => {
  alert('Unexpected error: ' + (e.error && e.error.message ? e.error.message : e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  alert('Unexpected error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

const { Filesystem, Camera, Share } = Capacitor.Plugins;

// Directory/Encoding/CameraResultType/CameraSource are TypeScript enums
// exported by the @capacitor/* npm packages, not native plugins - they
// don't exist on Capacitor.Plugins at runtime. Since this app has no
// bundler step, hardcode their actual string values directly instead of
// (incorrectly) destructuring them off Capacitor.Plugins.
const Directory = { Documents: 'DOCUMENTS', Data: 'DATA', Cache: 'CACHE', External: 'EXTERNAL' };
const Encoding = { UTF8: 'utf8' };
const CameraResultType = { Uri: 'uri', Base64: 'base64', DataUrl: 'dataUrl' };
const CameraSource = { Prompt: 'PROMPT', Camera: 'CAMERA', Photos: 'PHOTOS' };

const SESSION_DIR = 'audit_session';
const SESSION_FILE = `${SESSION_DIR}/session.json`;
const MAX_PHOTO_DIM = 1600; // px, longest side - mirrors the server's downsampling logic
const JPEG_QUALITY = 0.82;
const THUMB_DIM = 220; // px - just for the on-screen list, not the PDF
const THUMB_QUALITY = 0.6;

let questions = [];
let session = null;

// In-memory cache of thumbnail data URLs, keyed by "qnum/filename". With
// up to 150 photos in a session, re-reading + re-decoding every photo's
// FULL-resolution file from disk on every single tap (add/skip/delete) -
// which is what a naive full re-render does - is the actual source of
// slowness and memory pressure here, not the photo count itself. Thumbnails
// are tiny (a few KB) and safe to keep around for the whole session; full
// originals are only ever touched one at a time, during capture and
// during PDF generation.
const thumbCache = new Map();

document.getElementById('versionTag').textContent = `Offline build v${APP_VERSION}`;

// --- Persistence ---

async function readSession() {
  try {
    const res = await Filesystem.readFile({ path: SESSION_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    return JSON.parse(res.data);
  } catch (e) {
    return null;
  }
}

async function writeSession() {
  await Filesystem.writeFile({
    path: SESSION_FILE,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
    data: JSON.stringify(session),
  });
}

async function clearSession() {
  try {
    await Filesystem.rmdir({ path: SESSION_DIR, directory: Directory.Data, recursive: true });
  } catch (e) { /* nothing to clear */ }
}

function newAnswers() {
  const answers = {};
  for (const q of questions) answers[q.num] = { skipped: false, photos: [] };
  return answers;
}

// --- Photo capture + on-device compression ---

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function drawScaledJpeg(bitmap, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
}

// Camera.getPhoto/pickImages already downscale + recompress natively
// (Android Bitmap APIs, see the width/height/quality options passed in
// onCapture) before handing the file to the webview. A modern phone photo
// can be 12-108MP; without that, every capture meant decoding a huge
// bitmap in the WebView's JS/canvas heap (slow, and canvases have size
// limits some of those resolutions can actually exceed) just to immediately
// throw most of it away. Since native already delivered an image capped at
// MAX_PHOTO_DIM, the "full" output needs no further processing here - only
// the thumbnail still needs a (now cheap, since the source is already
// small) decode + downscale.
async function processPhotoFromWebPath(webPath) {
  const resp = await fetch(webPath);
  const blob = await resp.blob();
  const fullBase64 = await blobToBase64(blob);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const thumbBlob = await drawScaledJpeg(bitmap, THUMB_DIM, THUMB_QUALITY);
    const thumbBase64 = await blobToBase64(thumbBlob);
    return { fullBase64, thumbBase64 };
  } finally {
    bitmap.close();
  }
}

function thumbFilename(filename) {
  return `thumb_${filename}`;
}

async function savePhotoFile(qnum, fullBase64, thumbBase64) {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  await Promise.all([
    Filesystem.writeFile({
      path: `${SESSION_DIR}/q${qnum}/${filename}`,
      directory: Directory.Data,
      data: fullBase64,
      recursive: true,
    }),
    Filesystem.writeFile({
      path: `${SESSION_DIR}/q${qnum}/${thumbFilename(filename)}`,
      directory: Directory.Data,
      data: thumbBase64,
      recursive: true,
    }),
  ]);
  thumbCache.set(`${qnum}/${filename}`, `data:image/jpeg;base64,${thumbBase64}`);
  return filename;
}

async function readPhotoAsDataUrl(qnum, filename) {
  const res = await Filesystem.readFile({ path: `${SESSION_DIR}/q${qnum}/${filename}`, directory: Directory.Data });
  return `data:image/jpeg;base64,${res.data}`;
}

// Thumbnails are cached for the lifetime of the session - only ever hits
// disk once per photo (e.g. on resuming an in-progress audit).
async function readThumbDataUrl(qnum, filename) {
  const key = `${qnum}/${filename}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const dataUrl = await readPhotoAsDataUrl(qnum, thumbFilename(filename));
  thumbCache.set(key, dataUrl);
  return dataUrl;
}

async function deletePhotoFile(qnum, filename) {
  thumbCache.delete(`${qnum}/${filename}`);
  try {
    await Filesystem.deleteFile({ path: `${SESSION_DIR}/q${qnum}/${filename}`, directory: Directory.Data });
  } catch (e) { /* already gone */ }
  try {
    await Filesystem.deleteFile({ path: `${SESSION_DIR}/q${qnum}/${thumbFilename(filename)}`, directory: Directory.Data });
  } catch (e) { /* already gone */ }
}

// --- Screens ---

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

async function init() {
  const res = await fetch('questions.json');
  questions = await res.json();

  const existing = await readSession();
  if (existing && !existing.submitted) {
    document.getElementById('resumeBtn').style.display = 'block';
    document.getElementById('resumeBtn').addEventListener('click', () => {
      session = existing;
      enterAudit();
    });
  }
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const btn = document.getElementById('startBtn');
  try {
    btn.disabled = true;
    const roName = document.getElementById('roName').value.trim();
    const roCode = document.getElementById('roCode').value.trim();
    const auditor = document.getElementById('auditor').value.trim();
    const auditDate = document.getElementById('auditDate').value;

    await clearSession();
    session = {
      roName, roCode, auditor, auditDate,
      createdAt: new Date().toISOString(),
      answers: newAnswers(),
      submitted: false,
    };
    await writeSession();
    await enterAudit();
  } catch (e) {
    alert('Could not start audit: ' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
  }
});

async function enterAudit() {
  document.getElementById('roTitle').textContent = `RO: ${session.roName || '-'} (${session.roCode || '-'})`;
  document.getElementById('roSub').textContent = `Auditor: ${session.auditor || '-'} | Date: ${session.auditDate || '-'}`;
  showScreen('screenAudit');
  await render();
}

function buildCardShell(q, entry) {
  const card = document.createElement('div');
  card.className = 'question' + (entry.skipped ? ' skip-card' : '');
  card.id = `q-${q.num}`;
  card.innerHTML = `
    <h2>${q.num}. ${escapeHtml(q.title)}</h2>
    <div class="row">
      <button data-action="camera" data-q="${q.num}" style="width:auto;flex:1;margin:0;" ${entry.skipped ? 'disabled' : ''}>Take Photo</button>
      <button data-action="gallery" data-q="${q.num}" class="secondary" style="width:auto;flex:1;margin:0;" ${entry.skipped ? 'disabled' : ''}>Choose from Gallery</button>
    </div>
    <div class="row">
      <label><input type="checkbox" data-q="${q.num}" data-action="skip" ${entry.skipped ? 'checked' : ''}/> N/A</label>
    </div>
    <div class="status">${entry.photos.length} photo(s)</div>
    <div class="progress-wrap" style="display:none;">
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      <div class="progress-label"></div>
    </div>
    <div class="thumbs"></div>
  `;
  bindCardActions(card);
  return card;
}

function bindCardActions(card) {
  card.querySelectorAll('[data-action="camera"]').forEach((el) => el.addEventListener('click', () => onCapture(el, 'camera')));
  card.querySelectorAll('[data-action="gallery"]').forEach((el) => el.addEventListener('click', () => onCapture(el, 'gallery')));
  card.querySelectorAll('[data-action="skip"]').forEach((el) => el.addEventListener('change', onSkip));
  card.querySelectorAll('[data-action="delete"]').forEach((el) => el.addEventListener('click', onDelete));
}

// Fills in (or refreshes) just the thumbnail strip for one card, using the
// cache wherever possible. This is the only place that touches disk for
// display purposes, and only for photos not already cached.
async function fillThumbnails(qnum) {
  const card = document.getElementById(`q-${qnum}`);
  if (!card) return;
  const entry = session.answers[qnum] || { skipped: false, photos: [] };
  const thumbsEl = card.querySelector('.thumbs');
  thumbsEl.innerHTML = '';
  for (const filename of entry.photos) {
    const dataUrl = await readThumbDataUrl(qnum, filename);
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${dataUrl}" /><button data-action="delete" data-q="${qnum}" data-file="${filename}">x</button>`;
    thumbsEl.appendChild(div);
  }
  thumbsEl.querySelectorAll('[data-action="delete"]').forEach((el) => el.addEventListener('click', onDelete));
}

// Rebuilds just one question's card (used after upload/skip/delete) -
// cheap regardless of session size since it never touches other questions.
async function renderQuestionCard(qnum) {
  const q = questions.find((qq) => String(qq.num) === String(qnum));
  if (!q) return;
  const entry = session.answers[qnum] || { skipped: false, photos: [] };
  const oldCard = document.getElementById(`q-${qnum}`);
  const newCard = buildCardShell(q, entry);
  oldCard.replaceWith(newCard);
  await fillThumbnails(qnum);
}

// Full rebuild - only needed once, when entering or resuming an audit.
async function render() {
  const container = document.getElementById('questions');
  container.innerHTML = '';
  for (const q of questions) {
    const entry = session.answers[q.num] || { skipped: false, photos: [] };
    container.appendChild(buildCardShell(q, entry));
  }
  // Thumbnails load in the background per-card so the list appears
  // instantly even with many photos already on disk (e.g. resuming).
  for (const q of questions) {
    const entry = session.answers[q.num] || { skipped: false, photos: [] };
    if (entry.photos.length > 0) fillThumbnails(q.num);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function onCapture(btn, mode) {
  const qnum = btn.getAttribute('data-q');
  const card = document.getElementById(`q-${qnum}`);
  const wrap = card.querySelector('.progress-wrap');
  const fill = card.querySelector('.progress-bar-fill');
  const label = card.querySelector('.progress-label');

  // width/height ask the native Android layer to downscale (and quality
  // to recompress) before the image ever reaches the webview - much
  // faster than decoding a full-resolution phone photo in a JS canvas,
  // and the actual fix for "high resolution photos take forever."
  const NATIVE_QUALITY = Math.round(JPEG_QUALITY * 100);
  let webPaths = [];
  try {
    if (mode === 'camera') {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        quality: NATIVE_QUALITY,
        width: MAX_PHOTO_DIM,
        height: MAX_PHOTO_DIM,
      });
      webPaths = [photo.webPath];
    } else {
      const result = await Camera.pickImages({
        quality: NATIVE_QUALITY,
        limit: 0,
        width: MAX_PHOTO_DIM,
        height: MAX_PHOTO_DIM,
      });
      webPaths = (result.photos || []).map((p) => p.webPath);
    }
  } catch (e) {
    return; // user cancelled the picker - not an error
  }
  if (webPaths.length === 0) return;

  wrap.style.display = 'block';
  for (let i = 0; i < webPaths.length; i++) {
    const pct = Math.round(((i) / webPaths.length) * 100);
    fill.style.width = `${pct}%`;
    label.textContent = `Processing photo ${i + 1} of ${webPaths.length}…`;
    try {
      const { fullBase64, thumbBase64 } = await processPhotoFromWebPath(webPaths[i]);
      const filename = await savePhotoFile(qnum, fullBase64, thumbBase64);
      session.answers[qnum].photos.push(filename);
      session.answers[qnum].skipped = false;
    } catch (e) {
      alert('Could not process one of the photos: ' + e.message);
    }
    // yield every photo so the progress bar actually repaints and the
    // webview doesn't appear to hang during a big batch (up to ~150)
    await new Promise((r) => setTimeout(r, 0));
  }
  fill.style.width = '100%';
  await writeSession();
  await renderQuestionCard(qnum);
}

async function onSkip(e) {
  const qnum = e.target.getAttribute('data-q');
  session.answers[qnum].skipped = e.target.checked;
  await writeSession();
  await renderQuestionCard(qnum);
}

async function onDelete(e) {
  const qnum = e.target.getAttribute('data-q');
  const filename = e.target.getAttribute('data-file');
  await deletePhotoFile(qnum, filename);
  session.answers[qnum].photos = session.answers[qnum].photos.filter((f) => f !== filename);
  await writeSession();
  await renderQuestionCard(qnum);
}

// --- PDF generation (on-device, via pdf-lib) ---

function sanitizeForFilename(s) {
  return String(s || '-').trim().replace(/[\\/:*?"<>|]+/g, '-');
}

// String.fromCharCode(...bytes) blows the call stack for anything past
// ~60-100k bytes since spread passes every byte as its own function
// argument - a multi-photo PDF is comfortably bigger than that. Convert
// in fixed-size chunks instead.
function uint8ArrayToBase64(bytes) {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function generatePdfBytes(onProgress) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 40;

  const cover = doc.addPage([PAGE_W, PAGE_H]);
  cover.drawText('RO Audit Photo Report', { x: MARGIN, y: PAGE_H - 80, size: 20, font });
  const lines = [
    `Retail Outlet: ${session.roName || '-'}`,
    `RO Code: ${session.roCode || '-'}`,
    `Auditor: ${session.auditor || '-'}`,
    `Audit Date: ${session.auditDate || '-'}`,
  ];
  lines.forEach((line, i) => {
    cover.drawText(line, { x: MARGIN, y: PAGE_H - 120 - i * 18, size: 12, font });
  });

  const total = questions.reduce((sum, q) => {
    const entry = session.answers[q.num];
    return sum + (entry && !entry.skipped ? entry.photos.length : 0);
  }, 0);
  let processed = 0;

  for (const q of questions) {
    const entry = session.answers[q.num] || { skipped: false, photos: [] };
    if (entry.skipped || entry.photos.length === 0) continue;

    let i = 0;
    for (const filename of entry.photos) {
      i += 1;
      const page = doc.addPage([PAGE_W, PAGE_H]);
      const titleText = i === 1 ? `${q.num}. ${q.title}` : `${q.num}. ${q.title} (continued)`;
      page.drawText(titleText, { x: MARGIN, y: PAGE_H - MARGIN - 14, size: i === 1 ? 14 : 12, font });

      const imageAreaTop = PAGE_H - MARGIN - 40;
      const imageAreaBottom = MARGIN + 24;
      const maxImgWidth = PAGE_W - MARGIN * 2;
      const maxImgHeight = imageAreaTop - imageAreaBottom;

      try {
        const dataUrl = await readPhotoAsDataUrl(q.num, filename);
        const base64 = dataUrl.split(',')[1];
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const img = await doc.embedJpg(bytes);
        const scale = Math.min(maxImgWidth / img.width, maxImgHeight / img.height, 1);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const drawX = MARGIN + (maxImgWidth - drawW) / 2;
        const drawY = imageAreaBottom + (maxImgHeight - drawH) / 2;
        page.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
      } catch (e) {
        page.drawText(`[Could not render image: ${filename}]`, { x: MARGIN, y: imageAreaTop - 20, size: 10, font, color: rgb(0.8, 0.1, 0.1) });
      }

      page.drawText(`${q.num} - Photo ${i} of ${entry.photos.length}`, { x: MARGIN, y: MARGIN + 5, size: 9, font, color: rgb(0.4, 0.4, 0.4) });

      processed += 1;
      if (onProgress) onProgress(processed, total);
      // yield so the UI can repaint the progress bar between photos
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const headerText = `RO Code: ${session.roCode || '-'}   |   RO Name: ${session.roName || '-'}   |   Audit Date: ${session.auditDate || '-'}`;
  const pages = doc.getPages();
  pages.forEach((page, idx) => {
    page.drawText(headerText, { x: MARGIN, y: PAGE_H - 15, size: 7, font, color: rgb(0.53, 0.53, 0.53) });
    page.drawText(`Page ${idx + 1} of ${pages.length}`, { x: MARGIN, y: 12, size: 7, font, color: rgb(0.53, 0.53, 0.53) });
  });

  return doc.save();
}

document.getElementById('submitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitBtn');
  const overlay = document.getElementById('genOverlay');
  const fill = document.getElementById('genFill');
  const label = document.getElementById('genLabel');
  btn.disabled = true;
  fill.style.width = '0%';
  label.textContent = 'Generating PDF report… please don\'t close the app.';
  overlay.style.display = 'flex';

  try {
    const pdfBytes = await generatePdfBytes((processed, total) => {
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      label.textContent = `Processing photo ${processed} of ${total}… ${pct}%`;
    });

    const base64Pdf = uint8ArrayToBase64(pdfBytes);
    const filename = `AuditPhotos-${sanitizeForFilename(session.roName)}-${sanitizeForFilename(session.auditDate)}.pdf`;
    const writeResult = await Filesystem.writeFile({
      path: filename,
      directory: Directory.Documents,
      data: base64Pdf,
      recursive: true,
    });

    session.submitted = true;
    session.pdfPath = writeResult.uri;
    await writeSession();

    document.getElementById('questions').style.display = 'none';
    document.getElementById('auditFooter').style.display = 'none';
    const result = document.getElementById('result');
    result.style.display = 'block';
    result.innerHTML = `
      <p>Audit photo report generated and saved to your device's Documents folder as:</p>
      <p><strong>${escapeHtml(filename)}</strong></p>
      <button id="shareBtn">Share / Send PDF</button>
      <br/>
      <button id="newAuditBtn" class="secondary">Start a New Audit</button>
    `;
    document.getElementById('shareBtn').addEventListener('click', async () => {
      try {
        await Share.share({ title: filename, url: writeResult.uri });
      } catch (e) { /* user cancelled share sheet */ }
    });
    document.getElementById('newAuditBtn').addEventListener('click', async () => {
      await clearSession();
      window.location.reload();
    });
  } catch (e) {
    alert('Failed to generate PDF: ' + e.message);
    btn.disabled = false;
  } finally {
    overlay.style.display = 'none';
  }
});

init();
