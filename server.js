const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const PDFS_DIR = path.join(ROOT, 'pdfs');
const QUESTIONS_PATH = path.join(DATA_DIR, 'questions.json');

for (const dir of [SESSIONS_DIR, UPLOADS_DIR, PDFS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const QUESTIONS = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));
const { version: APP_VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// --- Single-slot session queue ---
// Photo uploads + sharp/HEIC decoding are memory-heavy. Running several
// sessions at once on a small free-tier dyno risks an OOM restart, which
// would wipe every in-progress session. So only one session may actively
// upload/edit at a time; everyone else waits in a FIFO queue.
const ACTIVE_TIMEOUT_MS = 2 * 60 * 1000; // no heartbeat for this long -> assume abandoned
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;

let active = null; // { id, roName, roCode, startedAt, lastHeartbeat }
const queue = []; // [{ id, roName, roCode, queuedAt, lastHeartbeat }]

function pruneAndPromote() {
  const now = Date.now();
  if (active && now - active.lastHeartbeat > ACTIVE_TIMEOUT_MS) {
    active = null;
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if (now - queue[i].lastHeartbeat > QUEUE_TIMEOUT_MS) queue.splice(i, 1);
  }
  if (!active && queue.length > 0) {
    const next = queue.shift();
    active = { ...next, startedAt: now, lastHeartbeat: now };
  }
}

function releaseActive(id) {
  if (active && active.id === id) {
    active = null;
    pruneAndPromote();
  }
}

function turnStatus(id) {
  pruneAndPromote();
  if (active && active.id === id) return { status: 'active' };
  const idx = queue.findIndex((q) => q.id === id);
  if (idx >= 0) return { status: 'queued', position: idx + 1 };
  return { status: 'unknown' };
}

function publicQueueState() {
  pruneAndPromote();
  return {
    active: active ? { auditor: active.auditor, roCode: active.roCode, startedAt: active.startedAt } : null,
    queue: queue.map((q, i) => ({ position: i + 1, auditor: q.auditor, roCode: q.roCode })),
  };
}

app.get('/api/queue', (req, res) => {
  res.json(publicQueueState());
});

app.get('/api/session/:id/turn', (req, res) => {
  res.json(turnStatus(req.params.id));
});

app.post('/api/session/:id/heartbeat', (req, res) => {
  pruneAndPromote();
  const now = Date.now();
  if (active && active.id === req.params.id) active.lastHeartbeat = now;
  const entry = queue.find((q) => q.id === req.params.id);
  if (entry) entry.lastHeartbeat = now;
  res.json(turnStatus(req.params.id));
});

// Gate that only lets the currently-active session through to
// state-mutating routes (upload/skip/delete/submit).
function requireActiveTurn(req, res, next) {
  pruneAndPromote();
  if (active && active.id === req.params.id) {
    active.lastHeartbeat = Date.now();
    return next();
  }
  res.status(423).json(turnStatus(req.params.id));
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveSession(session) {
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function newSessionAnswers() {
  const answers = {};
  for (const q of QUESTIONS) {
    answers[q.num] = { skipped: false, photos: [] };
  }
  return answers;
}

// --- Routes ---

app.get('/api/questions', (req, res) => {
  res.json(QUESTIONS);
});

app.post('/api/session', (req, res) => {
  const { roName = '', roCode = '', auditor = '', auditDate = '' } = req.body || {};
  const id = uuidv4();
  const session = {
    id,
    roName,
    roCode,
    auditor,
    auditDate,
    createdAt: new Date().toISOString(),
    answers: newSessionAnswers(),
    submitted: false,
  };
  fs.mkdirSync(path.join(UPLOADS_DIR, id), { recursive: true });
  saveSession(session);

  pruneAndPromote();
  const now = Date.now();
  if (!active) {
    active = { id, roName, roCode, auditor, startedAt: now, lastHeartbeat: now };
    res.json({ sessionId: id, status: 'active' });
  } else {
    queue.push({ id, roName, roCode, auditor, queuedAt: now, lastHeartbeat: now });
    res.json({ sessionId: id, status: 'queued', position: queue.length });
  }
});

app.get('/api/session/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.params.id, `q${req.params.qnum}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/session/:id/upload/:qnum', requireActiveTurn, upload.array('photos', 200), (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const qnum = req.params.qnum;
  if (!session.answers[qnum]) return res.status(400).json({ error: 'Invalid question number' });

  for (const file of req.files || []) {
    session.answers[qnum].photos.push(file.filename);
  }
  session.answers[qnum].skipped = false;
  saveSession(session);
  res.json({ photos: session.answers[qnum].photos });
});

app.delete('/api/session/:id/photo/:qnum/:filename', requireActiveTurn, (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { qnum, filename } = req.params;
  const entry = session.answers[qnum];
  if (!entry) return res.status(400).json({ error: 'Invalid question number' });
  entry.photos = entry.photos.filter((f) => f !== filename);
  const filePath = path.join(UPLOADS_DIR, session.id, `q${qnum}`, filename);
  fs.rm(filePath, { force: true }, () => {});
  saveSession(session);
  res.json({ ok: true });
});

app.post('/api/session/:id/skip/:qnum', requireActiveTurn, (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { qnum } = req.params;
  const entry = session.answers[qnum];
  if (!entry) return res.status(400).json({ error: 'Invalid question number' });
  entry.skipped = !!(req.body && req.body.skipped);
  saveSession(session);
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOADS_DIR));

function downloadFilename(session) {
  const safe = (s) => String(s || '-').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return `AuditPhotos-${safe(session.roName)}-${safe(session.auditDate)}.pdf`;
}

// Tracks in-progress PDF generation so the client can poll for a percentage.
const PDF_PROGRESS = new Map();

app.get('/api/session/:id/pdf-progress', (req, res) => {
  const progress = PDF_PROGRESS.get(req.params.id);
  if (!progress) return res.json({ processed: 0, total: 0 });
  res.json(progress);
});

app.post('/api/session/:id/submit', requireActiveTurn, async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    const pdfFilename = `${session.id}.pdf`;
    const pdfPath = path.join(PDFS_DIR, pdfFilename);
    await generatePdf(session, pdfPath);
    session.submitted = true;
    session.pdfFilename = pdfFilename;
    saveSession(session);
    res.json({ ok: true, pdfUrl: `/api/session/${session.id}/download` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF', detail: String(err) });
  } finally {
    PDF_PROGRESS.delete(session.id);
    releaseActive(session.id);
  }
});

app.get('/api/session/:id/download', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session || !session.pdfFilename) return res.status(404).json({ error: 'PDF not found' });
  const pdfPath = path.join(PDFS_DIR, session.pdfFilename);
  res.download(pdfPath, downloadFilename(session));
});

app.use('/pdfs', express.static(PDFS_DIR));

// Pages render at this DPI; photos are downsampled to match so the PDF
// never carries more pixels than will ever be visible on the printed page.
const TARGET_DPI = 200;

// iPhones save gallery photos as HEIC. sharp's bundled libvips doesn't
// decode HEIC (licensing), so convert those to JPEG first with a pure-JS
// decoder before handing the bytes to sharp.
function isHeic(buffer) {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12);
  return ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

async function preparePhotoForPdf(photoPath, maxWidth, maxHeight) {
  const maxPxWidth = Math.round((maxWidth / 72) * TARGET_DPI);
  const maxPxHeight = Math.round((maxHeight / 72) * TARGET_DPI);
  let input = fs.readFileSync(photoPath);
  if (isHeic(input)) {
    input = await heicConvert({ buffer: input, format: 'JPEG', quality: 0.95 });
  }
  const buffer = await sharp(input)
    .rotate() // apply EXIF orientation before stripping metadata
    .resize({
      width: maxPxWidth,
      height: maxPxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return buffer;
}

function generatePdf(session, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    (async () => {
      // Cover page
      doc.fontSize(20).text('RO Audit Photo Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Retail Outlet: ${session.roName || '-'}`);
      doc.text(`RO Code: ${session.roCode || '-'}`);
      doc.text(`Auditor: ${session.auditor || '-'}`);
      doc.text(`Audit Date: ${session.auditDate || '-'}`);

      const total = QUESTIONS.reduce((sum, q) => {
        const entry = session.answers[q.num];
        return sum + (entry && !entry.skipped ? entry.photos.length : 0);
      }, 0);
      let processed = 0;
      PDF_PROGRESS.set(session.id, { processed, total });

      for (const q of QUESTIONS) {
        const entry = session.answers[q.num] || { skipped: false, photos: [] };
        // Skip the section entirely when there's nothing to show -
        // no page, no title, no "N/A" placeholder.
        if (entry.skipped || entry.photos.length === 0) continue;

        doc.addPage();
        doc.fontSize(14).text(`${q.num}. ${q.title}`, { underline: true });
        doc.moveDown(0.5);

        const qDir = path.join(UPLOADS_DIR, session.id, `q${q.num}`);
        let i = 0;
        for (const photo of entry.photos) {
          i += 1;
          const photoPath = path.join(qDir, photo);
          if (!fs.existsSync(photoPath)) continue;

          if (i > 1) {
            doc.addPage();
            doc.fontSize(12).text(`${q.num}. ${q.title} (continued)`, { underline: true });
            doc.moveDown(0.5);
          }

          const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          const maxHeight = doc.page.height - doc.page.margins.bottom - doc.y - 30;
          try {
            const imgBuffer = await preparePhotoForPdf(photoPath, maxWidth, maxHeight);
            doc.image(imgBuffer, {
              fit: [maxWidth, maxHeight],
              align: 'center',
              valign: 'center',
            });
          } catch (e) {
            doc.fontSize(10).fillColor('red').text(`[Could not render image: ${photo}]`);
            doc.fillColor('#000');
          }
          doc.y = doc.page.height - doc.page.margins.bottom - 20;
          doc.fontSize(9).fillColor('#666').text(`${q.num} - Photo ${i} of ${entry.photos.length}`, { align: 'center' });
          doc.fillColor('#000');

          processed += 1;
          PDF_PROGRESS.set(session.id, { processed, total });
        }
      }

    const headerText = `RO Code: ${session.roCode || '-'}   |   RO Name: ${session.roName || '-'}   |   Audit Date: ${session.auditDate || '-'}`;
    const range = doc.bufferedPageRange();
    // Writing this close to the page edges falls outside the body margins,
    // which makes pdfkit think the content overflowed and silently insert
    // an extra page. Zero the margins for the duration of this loop only.
    const savedMargins = { ...doc.page.margins };
    for (let pageIdx = range.start; pageIdx < range.start + range.count; pageIdx++) {
      doc.switchToPage(pageIdx);
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
      const pageNum = pageIdx - range.start + 1;
      const totalPages = range.count;

      doc.fontSize(7).fillColor('#888')
        .text(headerText, savedMargins.left, 15, {
          width: doc.page.width - savedMargins.left - savedMargins.right,
          align: 'center',
          lineBreak: false,
        });

      doc.fontSize(7).fillColor('#888')
        .text(`Page ${pageNum} of ${totalPages}`, savedMargins.left, doc.page.height - 20, {
          width: doc.page.width - savedMargins.left - savedMargins.right,
          align: 'center',
          lineBreak: false,
        });
      doc.fillColor('#000');
      doc.page.margins = savedMargins;
    }

      doc.end();
    })().catch(reject);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RO Audit Photo App listening on http://localhost:${PORT}`);
});
