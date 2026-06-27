const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

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

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

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
  res.json({ sessionId: id });
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

app.post('/api/session/:id/upload/:qnum', upload.array('photos', 200), (req, res) => {
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

app.delete('/api/session/:id/photo/:qnum/:filename', (req, res) => {
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

app.post('/api/session/:id/skip/:qnum', (req, res) => {
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

app.post('/api/session/:id/submit', async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    const pdfFilename = `${session.id}.pdf`;
    const pdfPath = path.join(PDFS_DIR, pdfFilename);
    await generatePdf(session, pdfPath);
    session.submitted = true;
    session.pdfFilename = pdfFilename;
    saveSession(session);
    res.json({ ok: true, pdfUrl: `/pdfs/${pdfFilename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF', detail: String(err) });
  }
});

app.use('/pdfs', express.static(PDFS_DIR));

// Pages render at this DPI; photos are downsampled to match so the PDF
// never carries more pixels than will ever be visible on the printed page.
const TARGET_DPI = 200;

async function preparePhotoForPdf(photoPath, maxWidth, maxHeight) {
  const maxPxWidth = Math.round((maxWidth / 72) * TARGET_DPI);
  const maxPxHeight = Math.round((maxHeight / 72) * TARGET_DPI);
  const buffer = await sharp(photoPath)
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
      doc.text(`Generated: ${new Date().toLocaleString()}`);

      for (const q of QUESTIONS) {
        const entry = session.answers[q.num] || { skipped: false, photos: [] };
        doc.addPage();
        doc.fontSize(14).text(`${q.num}. ${q.title}`, { underline: true });
        doc.moveDown(0.5);

        if (entry.skipped || entry.photos.length === 0) {
          doc.fontSize(11).fillColor('#888').text('N/A - No photo provided', { italics: true });
          doc.fillColor('#000');
          continue;
        }

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
        }
      }

    const headerText = `RO Code: ${session.roCode || '-'}   |   RO Name: ${session.roName || '-'}   |   Audit Date: ${session.auditDate || '-'}`;
    const range = doc.bufferedPageRange();
    for (let pageIdx = range.start; pageIdx < range.start + range.count; pageIdx++) {
      doc.switchToPage(pageIdx);
      const pageNum = pageIdx - range.start + 1;
      const totalPages = range.count;

      doc.fontSize(7).fillColor('#888')
        .text(headerText, doc.page.margins.left, 15, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center',
        });

      doc.fontSize(7).fillColor('#888')
        .text(`Page ${pageNum} of ${totalPages}`, doc.page.margins.left, doc.page.height - 20, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center',
        });
      doc.fillColor('#000');
    }

      doc.end();
    })().catch(reject);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RO Audit Photo App listening on http://localhost:${PORT}`);
});
