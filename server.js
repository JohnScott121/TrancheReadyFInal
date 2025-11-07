// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'fs';
import { parse as csvParse } from 'csv-parse/sync';

import { cfg } from './lib/config.js';
import { normalizeClients, normalizeTransactions } from './lib/csv-normalize.js';
import { scoreAll } from './lib/rules.js';
import { buildCases } from './lib/cases.js';
import { buildManifest } from './lib/manifest.js';
import { zipNamedBuffers } from './lib/zip.js';
import { verifyStore, newToken } from './lib/verify-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --------- middleware (order matters) ---------
app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],          // all JS loaded from /public
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  }
}));

// ✅ Serve static BEFORE routes
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// CORS: allow same-origin, don’t be fragile about APP_ORIGIN while you iterate
app.use(cors({
  origin: (_origin, cb) => cb(null, true),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));

const baseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const heavyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });
app.use(baseLimiter);

// in-memory uploads only
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 }});

// --------- health ---------
app.get('/healthz', (_req, res) => res.send('ok'));

// --------- templates ---------
app.get('/api/templates', (req, res) => {
  const name = String(req.query.name || '').toLowerCase();
  const file = name === 'transactions' ? 'Transactions.template.csv' : 'Clients.template.csv';
  const full = path.join(__dirname, 'public', 'templates', file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Template not found' });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  fs.createReadStream(full).pipe(res);
});

// --------- validate ---------
app.post('/api/validate', heavyLimiter, upload.fields([{ name: 'clients', maxCount: 1 }, { name: 'transactions', maxCount: 1 }]), (req, res) => {
  try {
    const clientsFile = req.files?.clients?.[0];
    const txFile = req.files?.transactions?.[0];
    if (!clientsFile || !txFile) return res.status(400).json({ ok:false, error: 'Both files required: clients, transactions' });

    const clientsCsv = csvParse(clientsFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });
    const txCsv = csvParse(txFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });

    const { clients, clientHeaderMap } = normalizeClients(clientsCsv);
    const { txs, txHeaderMap, rejects, lookback } = normalizeTransactions(txCsv);

    res.json({ ok: true, counts: { clients: clients.length, txs: txs.length, rejects: rejects.length }, clientHeaderMap, txHeaderMap, rejects, lookback });
  } catch {
    res.status(500).json({ ok:false, error: 'Validation failed' });
  }
});

// --------- upload → evidence pack ---------
app.post('/upload', heavyLimiter, upload.fields([{ name: 'clients', maxCount: 1 }, { name: 'transactions', maxCount: 1 }]), async (req, res) => {
  try {
    const clientsFile = req.files?.clients?.[0];
    const txFile = req.files?.transactions?.[0];
    if (!clientsFile || !txFile) return res.status(400).json({ error: 'Both Clients.csv and Transactions.csv are required.' });

    const clientsCsv = csvParse(clientsFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });
    const txCsv = csvParse(txFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });

    const { clients, clientHeaderMap } = normalizeClients(clientsCsv);
    const { txs, txHeaderMap, rejects, lookback } = normalizeTransactions(txCsv);

    const { scores, rulesMeta } = await scoreAll(clients, txs, lookback);
    const cases = buildCases(txs, lookback);

    const files = {
      'clients.json': Buffer.from(JSON.stringify(clients, null, 2)),
      'transactions.json': Buffer.from(JSON.stringify(txs, null, 2)),
      'cases.json': Buffer.from(JSON.stringify(cases, null, 2)),
      'program.html': Buffer.from(renderProgramHTML(rulesMeta, clientHeaderMap, txHeaderMap, rejects))
    };

    const manifest = buildManifest(files, rulesMeta);
    const zipBuffer = await zipNamedBuffers({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)) });

    const token = newToken();
    verifyStore.put(token, zipBuffer, manifest, parseInt(process.env.VERIFY_TTL_MIN || '60', 10));

    res.json({
      ok: true,
      risk: scores,
      verify_url: new URL('/verify/' + token, cfg.APP_ORIGIN || 'http://localhost:10000').toString(),
      download_url: new URL('/download/' + token, cfg.APP_ORIGIN || 'http://localhost:10000').toString()
    });
  } catch {
    res.status(500).json({ error: 'Processing failed.' });
  }
});

function renderProgramHTML(rulesMeta, clientHeaderMap, txHeaderMap, rejects){
  return [
    '<!doctype html><meta charset="utf-8"><title>TrancheReady Evidence</title>',
    '<style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.55;padding:24px;color:#0D1321} code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;background:#F7F9FD;border:1px solid #E6EAF2;border-radius:8px;padding:10px;display:block;overflow:auto}</style>',
    '<h1>TrancheReady Evidence</h1>',
    `<p>Generated: ${new Date().toISOString()}</p>`,
    '<h2>Ruleset</h2>',
    `<pre>${escapeHtml(JSON.stringify(rulesMeta, null, 2))}</pre>`,
    '<h2>Header Mapping</h2>',
    `<pre>${escapeHtml(JSON.stringify({ clients: clientHeaderMap, transactions: txHeaderMap }, null, 2))}</pre>`,
    '<h2>Row Rejects</h2>',
    `<pre>${escapeHtml(JSON.stringify(rejects, null, 2))}</pre>`
  ].join('');
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// --------- verify & download ---------
app.get('/verify/:token', (req, res) => {
  const entry = verifyStore.get(req.params.token);
  if (!entry) return res.status(404).send('Link expired or not found.');
  res.render('verify', { manifest: entry.manifest, publicKey: process.env.SIGN_PUBLIC_KEY || '' });
});
app.get('/download/:token', (req, res) => {
  const entry = verifyStore.get(req.params.token);
  if (!entry) return res.status(404).send('Link expired or not found.');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="trancheready-evidence.zip"');
  res.send(entry.zipBuffer);
});

// --------- app UI ---------
app.get('/', (_req, res) => res.render('app'));

// 404
app.use((_req, res) => res.status(404).send('Not Found'));

const PORT = parseInt(process.env.PORT || '10000', 10);
app.listen(PORT, () => console.log('listening on', PORT));
