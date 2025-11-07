export const cfg = {
  PORT: parseInt(process.env.PORT || '10000', 10),
  APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:10000',
  MARKETING_ORIGIN: process.env.MARKETING_ORIGIN || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Infra
  TRUST_PROXY: process.env.TRUST_PROXY === '1',

  // Verify link TTL (minutes)
  VERIFY_TTL_MIN: parseInt(process.env.VERIFY_TTL_MIN || '60', 10),

  // Optional Ed25519 signing (base64 raw keys)
  SIGN_PUBLIC_KEY: process.env.SIGN_PUBLIC_KEY || '',
  SIGN_PRIVATE_KEY: process.env.SIGN_PRIVATE_KEY || '',

  // Stripe (optional)
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PRICE_ID_STARTER: process.env.STRIPE_PRICE_ID_STARTER || '',
  STRIPE_PRICE_ID_TEAM: process.env.STRIPE_PRICE_ID_TEAM || '',

  // Request log sampling (0..1)
  REQUEST_LOG_SAMPLE: Math.max(0, Math.min(1, parseFloat(process.env.REQUEST_LOG_SAMPLE || '1.0')))
};
