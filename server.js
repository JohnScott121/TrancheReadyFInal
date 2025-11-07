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
import Stripe from 'stripe';
import swaggerUi from 'swagger-ui-express';

import { cfg } from './lib/config.js';
import { normalizeClients, normalizeTransactions } from './lib/csv-normalize.js';
import { scoreAll } from './lib/rules.js';
import { buildCases } from './lib/cases.js';
import { buildManifest } from './lib/manifest.js';
import { zipNamedBuffers } from './lib/zip.js';
import { verifyStore, newToken } from './lib/verify-store.js';
import { reqIdFromHeaders } from './lib/request-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
if (cfg.TRUST_PROXY) app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Logger ----------
const logger = pino({ level: cfg.LOG_LEVEL });
const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = reqIdFromHeaders(req);
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    // sample successful request logs
    if (!err && res.statusCode < 400 && Math.random() > cfg.REQUEST_LOG_SAMPLE) return 'silent';
    return err ? 'error' : res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[redacted]'
  }
});

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
      "script-src": ["'self'"], // all site scripts are local
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "frame-src": [],          // block iframes
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "no-referrer" },
  xssFilter: true
}));

// Static assets (marketing + app)
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use('/site', express.static(path.join(__dirname, 'public', 'site'), { maxAge: '30m', etag: true }));

// CORS
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin === cfg.APP_ORIGIN || (cfg.MARKETING_ORIGIN && origin === cfg.MARKETING_ORIGIN)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));

// Rate limits
const baseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const heavyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// Uploads (memory only)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 }});

// ---------- Health & diagnostics ----------
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/status', (_req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  origin: cfg.APP_ORIGIN,
  ruleset_id: 'dnfbp-2025.11',
  tokens_active: verifyStore.map?.size || 0,
  features: {
    stripe: Boolean(cfg.STRIPE_SECRET_KEY && (cfg.STRIPE_PRICE_ID_STARTER || cfg.STRIPE_PRICE_ID_TEAM)),
    signing: Boolean(cfg.SIGN_PUBLIC_KEY && cfg.SIGN_PRIVATE_KEY)
  }
}));
app.get('/status', (_req, res) => res.render('status', {
  env: {
    app_origin: cfg.APP_ORIGIN,
    marketing_origin: cfg.MARKETING_ORIGIN || '(not set)',
    stripe: Boolean(cfg.STRIPE_SECRET_KEY && (cfg.STRIPE_PRICE_ID_STARTER || cfg.STRIPE_PRICE_ID_TEAM)),
    signing: Boolean(cfg.SIGN_PUBLIC_KEY && cfg.SIGN_PRIVATE_KEY),
    verify_ttl_min: cfg.VERIFY_TTL_MIN
  }
}));
app.get('/api/version', (_req, res) => res.json({ name: 'trancheready', version: '1.0.0', ruleset_id: 'dnfbp-2025.11' }));

// ---------- Swagger UI (/docs) ----------
const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
if (fs.existsSync(openapiPath)) {
  const yamlServePath = '/docs/openapi.yaml';
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: yamlServePath }, customSiteTitle: 'TrancheReady API Docs' }));
  app.get(yamlServePath, (_req, res) => res.type('text/yaml').send(fs.readFileSync(openapiPath,'utf8')));
}

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

// ---------- Upload → Evidence ----------
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

// ---------- Stripe Checkout ----------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!cfg.STRIPE_SECRET_KEY) return res.status(400).json({ error: 'Stripe not configured.' });
    const stripe = new Stripe(cfg.STRIPE_SECRET_KEY);
    const plan = (req.body?.plan || '').toLowerCase();
    const priceId = plan === 'team' ? cfg.STRIPE_PRICE_ID_TEAM : cfg.STRIPE_PRICE_ID_STARTER;
    if (!priceId) return res.status(400).json({ error: 'Missing price id for plan.' });

    const session = await stripe.checkout.sessions.create({
      mode: plan === 'team' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: new URL('/public/pricing.html?success=1', cfg.APP_ORIGIN).toString(),
      cancel_url: new URL('/public/pricing.html?canceled=1', cfg.APP_ORIGIN).toString()
    });
    res.json({ url: session.url });
  } catch (e) {
    req.log?.error?.(e, 'stripe_error');
    res.status(500).json({ error: 'Stripe error' });
  }
});

// ---------- Marketing routes (nice URLs) ----------
app.get('/pricing', (_req, res) => res.redirect(302, '/public/pricing.html'));
app.get('/features', (_req, res) => res.redirect(302, '/site/features.html'));
app.get('/faq', (_req, res) => res.redirect(302, '/site/faq.html'));

// App root
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
