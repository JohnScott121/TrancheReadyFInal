import crypto from 'crypto';

export function reqIdFromHeaders(req) {
  // Respect common reverse-proxy IDs if present
  const h = req.headers;
  const prior =
    h['x-request-id'] ||
    h['x-correlation-id'] ||
    h['cf-ray'] ||
    h['x-amzn-trace-id'];
  if (prior && typeof prior === 'string') return prior.slice(0, 128);

  // Deterministic-ish per connection (best-effort)
  const seed = `${req.ip || ''}|${req.method}|${req.url}|${Date.now()}|${Math.random()}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}
