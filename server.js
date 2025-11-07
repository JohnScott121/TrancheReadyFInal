import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
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

// ---------- Logger ----------
const logger = pino({ level: cfg.LOG_LEVEL });
const httpLogger = pinoHttp({
  logger,
  customLogLevel: (_req, res, err) =>
    err ? 'error' : res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' }
});

// ---------- App ----------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Middleware ----------
app.use(httpLogger);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin === cfg.APP_ORIGIN || (cfg.MARKETING_ORIGIN && origin === cfg.MARKETING_ORIGIN)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

const baseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const heavyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });
app.use(baseLimiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 }});

// ---------- Health & diagnostics ----------
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/status', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), origin: cfg.APP_ORIGIN, tokens: verifyStore.map?.size || 0 }));
app.get('/api/version', (_req, res) => res.json({ name: 'trancheready', version: '0.3.0', ruleset_id: 'dnfbp-2025.11' }));

// ---------- Templates ----------
app.get('/api/templates', (req, res) => {
  const name = (req.query.name || '').toString().toLowerCase();
  const file = name === 'transactions' ? 'Transactions.template.csv' : 'Clients.template.csv';
  const full = path.join(__dirname, 'public', 'templates', file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Template not found' });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  fs.createReadStream(full).pipe(res);
});

// ---------- Validate-only ----------
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
  } catch (err) {
    req.log?.error?.(err, 'validate_failed');
    res.status(500).json({ ok:false, error: 'Validation failed' });
  }
});

// ---------- Upload → Evidence (ZIP + verify) ----------
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

    // Evidence files
    const files = {
      'clients.json': Buffer.from(JSON.stringify(clients, null, 2)),
      'transactions.json': Buffer.from(JSON.stringify(txs, null, 2)),
      'cases.json': Buffer.from(JSON.stringify(cases, null, 2)),
      'program.html': Buffer.from(renderProgramHTML(rulesMeta, clientHeaderMap, txHeaderMap, rejects))
    };

    const manifest = buildManifest(files, rulesMeta);
    const zipBuffer = await zipNamedBuffers({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)) });

    const token = newToken();
    verifyStore.put(token, zipBuffer, manifest, cfg.VERIFY_TTL_MIN);

    res.json({
      ok: true,
      risk: scores,
      verify_url: new URL('/verify/' + token, cfg.APP_ORIGIN).toString(),
      download_url: new URL('/download/' + token, cfg.APP_ORIGIN).toString()
    });
  } catch (e) {
    req.log?.error?.(e, 'processing_failed');
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

// ---------- Verify & Download ----------
app.get('/verify/:token', (req, res) => {
  const entry = verifyStore.get(req.params.token);
  if (!entry) return res.status(404).send('Link expired or not found.');
  res.render('verify', { manifest: entry.manifest, publicKey: cfg.SIGN_PUBLIC_KEY });
});

app.get('/download/:token', (req, res) => {
  const entry = verifyStore.get(req.params.token);
  if (!entry) return res.status(404).send('Link expired or not found.');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="trancheready-evidence.zip"');
  res.send(entry.zipBuffer);
});

// ---------- UI ----------
app.get('/', (_req, res) => res.render('app'));

// 404 + errors
app.use((_req, res) => res.status(404).send('Not Found'));
app.use((err, _req, res, _next) => { logger.error({ err }, 'unhandled_error'); res.status(500).json({ error: 'Internal error' }); });

// ---------- Start ----------
const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'listening'));
function shutdown(signal){
  logger.info({ signal }, 'shutting_down');
  server.close(() => { logger.info('http_closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
