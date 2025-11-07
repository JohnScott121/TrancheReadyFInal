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
import { parse as csvParse } from 'csv-parse/sync';

import { cfg } from './lib/config.js';
import { normalizeClients, normalizeTransactions } from './lib/csv-normalize.js';

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

// Memory uploads (no temp files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 2 }
});

// ---------- Health & diagnostics ----------
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), origin: cfg.APP_ORIGIN });
});
app.get('/api/version', (_req, res) => {
  res.json({ name: 'trancheready', version: '0.2.0' });
});

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

// ---------- Validate (CSV → normalized view) ----------
app.post('/api/validate', heavyLimiter, upload.fields([{ name: 'clients', maxCount: 1 }, { name: 'transactions', maxCount: 1 }]), (req, res) => {
  try {
    const clientsFile = req.files?.clients?.[0];
    const txFile = req.files?.transactions?.[0];
    if (!clientsFile || !txFile) return res.status(400).json({ ok:false, error: 'Both files required: clients, transactions' });

    const clientsCsv = csvParse(clientsFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });
    const txCsv = csvParse(txFile.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });

    const { clients, clientHeaderMap } = normalizeClients(clientsCsv);
    const { txs, txHeaderMap, rejects, lookback } = normalizeTransactions(txCsv);

    res.json({
      ok: true,
      counts: { clients: clients.length, txs: txs.length, rejects: rejects.length },
      clientHeaderMap,
      txHeaderMap,
      rejects,
      lookback
    });
  } catch (err) {
    req.log?.error?.(err, 'validate_failed');
    res.status(500).json({ ok:false, error: 'Validation failed' });
  }
});

// ---------- UI (upload/validate) ----------
app.get('/', (_req, res) => res.render('app'));

// 404
app.use((_req, res) => res.status(404).send('Not Found'));

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'unhandled_error');
  res.status(500).json({ error: 'Internal error' });
});

// ---------- Start + graceful shutdown ----------
const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'listening'));
function shutdown(signal){
  logger.info({ signal }, 'shutting_down');
  server.close(() => { logger.info('http_closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
