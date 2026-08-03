# WMPSC Candidate Dashboard

A small, self-contained dashboard: login screen + today's/total candidate
data pulled from MongoDB + Excel download. Deliberately kept to **2 files
you'll ever touch** — `server.js` and `public/index.html` — plus a `.env`
you fill in once.

Why there's a tiny server at all: MongoDB retired its "Data API" (the thing
that used to let a browser talk to MongoDB directly) in September 2025.
There's now no safe way for plain browser JavaScript to reach MongoDB
without exposing your database password to anyone who views the page
source. `server.js` is ~15KB and only exists to hold that password
privately and hand your browser clean JSON/Excel — everything you *see* and
click is plain HTML/CSS/JS in `public/index.html`.

## 1. Install

You need [Node.js](https://nodejs.org) installed (v18+). Then:

```bash
cd wmpsc-dashboard
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `MONGO_URI` — your MongoDB connection string (Atlas or self-hosted).
- `DB_NAME` — the database name.
- `COLLECTION_NAME` — the collection holding candidate documents (the
  sample document you shared uses fields `aadhar`, `name`, `mobile`,
  `jobRole`, `trainingPartner`, `taluka`, `gramPanchayat`, `submittedAt`;
  `district` is optional — it'll just show blank if a document doesn't have
  it).
- `ADMIN_USERNAME` — whatever login username you want.
- `ADMIN_PASSWORD_HASH` — generate this, don't type a plain password into
  `.env`:
  ```bash
  node hash-password.js "YourStrongPassword"
  ```
  Paste the printed line into `.env`.
- `SESSION_SECRET` — any long random string:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `TIMEZONE` — defaults to `Asia/Kolkata`. This controls what counts as
  "today" (midnight-to-midnight in this timezone), independent of where the
  server itself is hosted.

## 3. Run

```bash
npm start
```

Open **http://localhost:3000** and log in.

## What it shows

- **Total Unique Candidates** — counts distinct Aadhar numbers across the
  whole collection (duplicates collapsed).
- **Today's Unique Candidates** — same, but only for today.
- **Training Partner-wise** and **Job Role-wise** breakdowns — unique
  candidates per partner/role.
- **Result-wise** (Pass/Fail) breakdown, if your documents have a `result`
  field.
- **Today's Submissions table** — Aadhar, Name, Mobile, Job Role, Training
  Partner, District, Taluka, Gram Panchayat.
- **Download → Today (Excel)** and **Download → All Data (Excel)** — same
  8 columns, straight from MongoDB, no manual copy-pasting.

## Security notes (already built in)

- Password is bcrypt-hashed, never stored in plain text.
- Session cookie is `httpOnly` (JavaScript can't read it, blocking XSS
  cookie theft).
- Login attempts are rate-limited (10 per 15 minutes) to blunt brute-force
  guessing.
- All data and download routes require a valid session — hitting them
  directly without logging in returns a 401.
- Set `NODE_ENV=production` once you deploy behind HTTPS, so cookies are
  marked `secure` too.

## Deploying somewhere real

Right now this is built to run on your own machine or a private server —
fine for testing and for a small internal tool. If you want to put it on
the internet for your team to use, the two things worth adding are HTTPS
(e.g. via a reverse proxy like Caddy or Nginx, or a host that provides it
automatically) and setting `NODE_ENV=production` in `.env`. Happy to help
with that step once you've confirmed the dashboard behaves the way you
want locally.
