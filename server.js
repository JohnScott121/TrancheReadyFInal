import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { cfg } from './lib/config.js';

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

// Helmet + CSP (tight by default—adjust later if you add external assets)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"], // allow our inline focus styles
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));

// Static assets
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// CORS: allow same-origin and (optionally) one marketing origin
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl or same-origin
    if (origin === cfg.APP_ORIGIN || (cfg.MARKETING_ORIGIN && origin === cfg.MARKETING_ORIGIN)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Rate limits
const baseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use(baseLimiter);

// ---------- Health & diagnostics ----------
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), origin: cfg.APP_ORIGIN });
});
app.get('/api/version', (_req, res) => {
  res.json({ name: 'trancheready', version: '0.1.0' });
});

// ---------- App placeholder (will be replaced in Part 3) ----------
app.get('/', (_req, res) => res.render('index', { appOrigin: cfg.APP_ORIGIN }));

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
