# RO Audit Photo App

A small Node/Express app for collecting photo evidence during a retail
outlet (RO) electrical/safety audit, walking through a fixed 34-item
checklist, and producing a single compressed PDF report at the end.

Live repo: https://github.com/faiz400/PhototoPdfRO

## What it does

1. **Start** ([public/index.html](public/index.html)) — enter RO name, RO
   code, auditor name, and audit date. Creates a session.
2. **Audit** ([public/audit.html](public/audit.html)) — for each of the 34
   checklist items, either upload one or more photos or mark it N/A. Photos
   can be taken with the camera or picked from the gallery (no
   `capture="environment"` lock-in). Uploads show a live progress bar.
3. **Submit** — generates a PDF report (cover page + one section per
   answered question, skipped/N/A items are omitted entirely) and offers it
   for download as `AuditPhotos-<RO Name>-<Audit Date>.pdf`. A progress
   overlay shows "processing photo N of M" while it generates.

## Single-session queue

Photo processing (HEIC decode + resize + re-encode via `sharp`) is memory
heavy. To avoid multiple simultaneous uploads exhausting RAM on a small
free-tier host and crash-restarting the server (which would wipe every
in-progress session, since storage is local disk — see below), **only one
session may be active at a time**:

- The start page shows who's currently active and who's queued, live.
- A new session either becomes active immediately or is placed in a FIFO
  queue and shown a waiting page with its position.
- The waiting page polls and auto-redirects to the audit page once
  promoted.
- The active/audit page sends a heartbeat every 30s. If a session goes
  quiet for 2 minutes (closed tab, dead connection), its slot is reclaimed
  and handed to the next person in queue.
- State is in-memory only (see [server.js](server.js), search for
  `pruneAndPromote`) — it resets on every server restart, same as the
  session data itself.

## Architecture

```
public/
  index.html    start page: RO details form + live queue status
  waiting.html  queue position page, auto-redirects when promoted
  audit.html    per-question photo upload / skip / delete + submit
data/
  questions.json   the 34 checklist items (num, title, guideline)
  sessions/*.json   one file per session: answers, RO details, etc.
uploads/<sessionId>/q<N>/   original uploaded photos, per question
pdfs/<sessionId>.pdf        generated report, served on download
server.js       all routes + PDF generation, single file
render.yaml     Render Blueprint (free web service)
```

There's no database — sessions, uploads, and generated PDFs all live on
local disk under `data/`, `uploads/`, and `pdfs/`. `data/questions.json`
is the only file you'd typically edit by hand (to change the checklist).

### PDF generation notes

- Photos are downsampled to ~200 DPI for their actual print size (never
  upscaled) and re-encoded as JPEG quality 82 via `sharp`, which is what
  keeps the report small without visibly degrading quality — phone photos
  are usually far higher resolution than a printed page needs.
- HEIC photos (default format for iPhone gallery photos) are converted to
  JPEG first via `heic-convert`, since `sharp`'s bundled `libvips` doesn't
  decode HEIC (licensing).
- Header/footer text on every page is drawn with the page margins
  temporarily zeroed — drawing near the page edges with the normal margins
  in place makes `pdfkit` think the content overflowed and silently
  insert an extra blank page. See the comment above that loop in
  `generatePdf` if you touch it.

## Running locally

```bash
npm install
npm start
# http://localhost:3000
```

Requires Node 18+ (developed against Node 24, see `render.yaml`).

## Deployment

Configured for [Render](https://render.com)'s free tier via
[render.yaml](render.yaml) (Blueprint). Push to `main` on the connected
GitHub repo and Render redeploys automatically.

**Known tradeoff:** Render's free tier uses ephemeral disk. Any data in
`uploads/`, `pdfs/`, and `data/sessions/` is wiped on every redeploy, and
likely on every spin-down (free services sleep after ~15 min idle and
restart fresh). Fine for finishing one audit in a single sitting and
downloading the PDF before closing the tab; not fine for audits paused
and resumed later, or for keeping historical PDFs around. If that becomes
a problem, the fix is swapping local `fs` calls for an object store (e.g.
Cloudflare R2's free tier).

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/version` | App version (shown on start page) |
| GET | `/api/questions` | The 34 checklist items |
| GET | `/api/queue` | Public queue status: who's active, who's waiting |
| POST | `/api/session` | Create a session; returns `active` or `queued` + position |
| GET | `/api/session/:id` | Session details (RO info + current answers) |
| GET | `/api/session/:id/turn` | This session's queue status |
| POST | `/api/session/:id/heartbeat` | Keep-alive ping; also returns turn status |
| POST | `/api/session/:id/upload/:qnum` | Upload photos for a question (multipart, field `photos`) — requires active turn |
| DELETE | `/api/session/:id/photo/:qnum/:filename` | Remove one uploaded photo — requires active turn |
| POST | `/api/session/:id/skip/:qnum` | Mark/unmark a question N/A — requires active turn |
| GET | `/api/session/:id/pdf-progress` | Photos processed / total, while generating |
| POST | `/api/session/:id/submit` | Generate the PDF, release the active slot — requires active turn |
| GET | `/api/session/:id/download` | Download the generated PDF with a friendly filename |

Routes marked "requires active turn" return `423 Locked` with the
session's current turn status if called while not the active session.

## Editing the checklist

Edit [data/questions.json](data/questions.json) — each entry is
`{ "num": <int>, "title": <string>, "guideline": <string|null> }`. The
`num` is used as the key for session answers and as the upload route
param, so keep it stable once an audit has started (don't renumber while
sessions are in flight).
