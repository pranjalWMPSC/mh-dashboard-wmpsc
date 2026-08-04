require('dotenv').config();

const express = require('express');
const session = require('express-session');
// connect-mongo's CJS/ESM interop varies by version — some resolve to the
// class directly, others wrap it under `.default`. Handle both.
const connectMongo = require('connect-mongo');
const MongoStore = connectMongo.default || connectMongo;
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');
const ExcelJS = require('exceljs');
const { MongoClient } = require('mongodb');

const REQUIRED_ENV = ['MONGO_URI', 'DB_NAME', 'COLLECTION_NAME', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  // Throwing (rather than process.exit) so this surfaces clearly in both
  // `node server.js` locally AND in Vercel's serverless function logs.
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. ` +
    'Copy .env.example to .env locally, or set these in your Vercel project settings.'
  );
}

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

// The exact fields the dashboard/table/exports are allowed to show.
// This is the ONLY place field names are mapped, so it's easy to adjust
// if a client's Mongo documents use slightly different field names.
const FIELD_MAP = {
  aadhar: 'aadhar',
  name: 'name',
  mobile: 'mobile',
  jobRole: 'jobRole',
  trainingPartner: 'trainingPartner',
  district: 'centerName', // falls back to '' if not present on the document
  taluka: 'taluka',
  gramPanchayat: 'gramPanchayat',
};
const COLUMN_ORDER = ['aadhar', 'name', 'mobile', 'jobRole', 'trainingPartner', 'district', 'taluka', 'gramPanchayat'];
const COLUMN_LABELS = {
  aadhar: 'Aadhar',
  name: 'Name',
  mobile: 'Mobile',
  jobRole: 'Job Role',
  trainingPartner: 'Training Partner',
  district: 'District',
  taluka: 'Taluka',
  gramPanchayat: 'Gram Panchayat',
};

const projection = COLUMN_ORDER.reduce((acc, key) => {
  acc[FIELD_MAP[key]] = 1;
  return acc;
}, { _id: 0, submittedAt: 1 });

function shapeDoc(doc) {
  const out = {};
  for (const key of COLUMN_ORDER) {
    out[key] = doc[FIELD_MAP[key]] ?? '';
  }
  return out;
}

// ---- Timezone-safe "today" boundaries (no extra date library needed) ----
function getTodayRangeUTC(timeZone) {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(now).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMinutes = Math.round((asIfUTC - now.getTime()) / 60000); // timezone minus UTC
  const localMidnightAsIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const startUTC = new Date(localMidnightAsIfUTC - offsetMinutes * 60000);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { start: startUTC, end: endUTC };
}

// ---- App setup ----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json());
// Serves public/index.html etc. for local dev (`npm start` -> localhost:3000).
// On Vercel this middleware is simply never reached for those paths — Vercel
// serves anything in public/** directly via its CDN before requests hit this
// function at all, so nothing needs to change here for deployment.
app.use(express.static(path.join(__dirname, 'public')));

// ---- Same-origin enforcement ----
// Blocks any request that didn't originate from this app's own pages —
// direct API calls via curl/Postman/another website get rejected, even if
// someone somehow obtained a valid session cookie. Modern browsers attach
// Sec-Fetch-Site automatically and reliably on every request; that's the
// primary signal. Origin/Referer are checked as a fallback for the rare
// client that doesn't send Sec-Fetch-Site.
function sameOriginOnly(req, res, next) {
  const secFetchSite = req.get('sec-fetch-site');
  if (secFetchSite) {
    // 'same-origin': fetch from our own page. 'none': user directly typed/
    // bookmarked/clicked into a URL (e.g. the "Today (Excel)" download
    // link acts like this in some browsers). Both are legitimate.
    if (secFetchSite === 'same-origin' || secFetchSite === 'none') return next();
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }

  const hostMatches = (headerValue) => {
    try { return new URL(headerValue).host === req.get('host'); } catch { return false; }
  };
  const origin = req.get('origin');
  const referer = req.get('referer');
  if (origin) return hostMatches(origin) ? next() : res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  if (referer) return hostMatches(referer) ? next() : res.status(403).json({ error: 'Cross-origin requests are not allowed' });

  // No same-origin signal at all (e.g. a bare curl request) — reject.
  return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
}
app.use(sameOriginOnly);

app.use(session({
  name: 'wmpsc.sid',
  secret: process.env.SESSION_SECRET,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    dbName: process.env.DB_NAME,
    collectionName: 'sessions',
    ttl: 8 * 60 * 60, // seconds
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // Vercel sets NODE_ENV=production automatically
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// ---- Mongo connection ----
// Cached across invocations: on Vercel, warm serverless instances reuse this
// module's memory, so we connect once and reuse the same client rather than
// reconnecting on every request (works the same way for local `npm start`).
let clientPromise = null;
function getCollection() {
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGO_URI);
    clientPromise = client.connect().then(() => {
      console.log(`Connected to MongoDB: ${process.env.DB_NAME}.${process.env.COLLECTION_NAME}`);
      return client;
    });
  }
  return clientPromise.then((client) => client.db(process.env.DB_NAME).collection(process.env.COLLECTION_NAME));
}

// Makes req.collection available to every route below without each one
// needing to know about connection caching.
app.use(async (req, res, next) => {
  try {
    req.collection = await getCollection();
    next();
  } catch (err) { next(err); }
});

// ---- Auth routes ----
app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const validUser = username === process.env.ADMIN_USERNAME;
  const validPass = validUser && (await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH));

  if (!validUser || !validPass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.loggedIn = true;
  req.session.username = username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- Data routes ----
app.get('/api/today', requireLogin, async (req, res, next) => {
  try {
    const { start, end } = getTodayRangeUTC(TIMEZONE);
    const docs = await req.collection
      .find({ submittedAt: { $gte: start, $lt: end } }, { projection })
      .sort({ submittedAt: -1 })
      .toArray();
    // Dedupe by Aadhar (keep the most recent of the day per candidate) so
    // the on-page table/pagination never shows the same person twice.
    const seen = new Set();
    const deduped = [];
    for (const d of docs) {
      const key = d[FIELD_MAP.aadhar];
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(d);
      }
    }
    res.json(deduped.map(shapeDoc));
  } catch (err) { next(err); }
});

const statsProjection = {
  _id: 0,
  [FIELD_MAP.aadhar]: 1,
  [FIELD_MAP.trainingPartner]: 1,
  [FIELD_MAP.jobRole]: 1,
  submittedAt: 1,
};

app.get('/api/stats', requireLogin, async (req, res, next) => {
  try {
    const { start, end } = getTodayRangeUTC(TIMEZONE);

    // Computed in application code rather than a Mongo aggregation pipeline
    // — see the comment on /download/all for why (Atlas Free/Shared tiers
    // don't support allowDiskUse, so large in-database group/sort ops can
    // hit a hard memory wall regardless of that option).
    const docs = await req.collection.find({}, { projection: statsProjection }).toArray();

    const totalUniqueSet = new Set();
    const todayUniqueSet = new Set();
    const partnerMap = new Map(); // partner -> Set(aadhar)
    const jobRoleMap = new Map(); // jobRole -> Set(aadhar)
    let todayRows = 0;

    for (const d of docs) {
      const aadhar = d[FIELD_MAP.aadhar];
      const partner = d[FIELD_MAP.trainingPartner] || 'Unknown';
      const jobRole = d[FIELD_MAP.jobRole] || 'Unknown';
      const isToday = d.submittedAt && new Date(d.submittedAt) >= start && new Date(d.submittedAt) < end;

      totalUniqueSet.add(aadhar);
      if (isToday) {
        todayUniqueSet.add(aadhar);
        todayRows += 1;
      }

      if (!partnerMap.has(partner)) partnerMap.set(partner, new Set());
      partnerMap.get(partner).add(aadhar);

      if (!jobRoleMap.has(jobRole)) jobRoleMap.set(jobRole, new Set());
      jobRoleMap.get(jobRole).add(aadhar);
    }

    const toSortedCounts = (map) =>
      [...map.entries()]
        .map(([label, set]) => ({ label, count: set.size }))
        .sort((a, b) => b.count - a.count);

    res.json({
      totalUniqueCandidates: totalUniqueSet.size,
      todayUniqueCandidates: todayUniqueSet.size,
      totalRows: docs.length,
      todayRows,
      byTrainingPartner: toSortedCounts(partnerMap),
      byJobRole: toSortedCounts(jobRoleMap),
    });
  } catch (err) { next(err); }
});

// ---- Excel export ----
async function buildWorkbook(docs, sheetTitle) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetTitle);
  sheet.columns = COLUMN_ORDER.map((key) => ({ header: COLUMN_LABELS[key], key, width: key === 'name' ? 24 : 18 }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  docs.forEach((d) => sheet.addRow(shapeDoc(d)));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMN_ORDER.length } };
  return workbook;
}

app.get('/download/today', requireLogin, async (req, res, next) => {
  try {
    const { start, end } = getTodayRangeUTC(TIMEZONE);
    const docs = await req.collection.find({ submittedAt: { $gte: start, $lt: end } }, { projection }).toArray();
    const workbook = await buildWorkbook(docs, "Today's Candidates");
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="candidates-today-${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

app.get('/download/all', requireLogin, async (req, res, next) => {
  try {
    // Dedupe by Aadhar, keeping each candidate's most recent submission.
    // Done in application code (not a Mongo $sort+$group aggregation)
    // because MongoDB Atlas's Free/Shared tiers (M0/M2/M5) don't support
    // allowDiskUse, so a large in-database sort/group can hit Atlas's
    // hard memory limit regardless of that option.
    const docs = await req.collection.find({}, { projection }).toArray();
    docs.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const seen = new Set();
    const deduped = [];
    for (const d of docs) {
      const key = d[FIELD_MAP.aadhar];
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(d);
      }
    }
    const workbook = await buildWorkbook(deduped, 'All Candidates (Unique Aadhar)');
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="candidates-all-${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// Vercel imports this file and calls the exported app directly as a
// serverless function — it does NOT run app.listen(). Locally, running
// `node server.js` / `npm start` still starts a normal server on PORT.
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
}
