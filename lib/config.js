export const cfg = {
  PORT: parseInt(process.env.PORT || '10000', 10),
  APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:10000',
  MARKETING_ORIGIN: process.env.MARKETING_ORIGIN || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Verify link TTL (minutes)
  VERIFY_TTL_MIN: parseInt(process.env.VERIFY_TTL_MIN || '60', 10),

  // Optional Ed25519 signing (base64 raw keys). If not set, manifest has no signature.
  SIGN_PUBLIC_KEY: process.env.SIGN_PUBLIC_KEY || '',
  SIGN_PRIVATE_KEY: process.env.SIGN_PRIVATE_KEY || ''
};
