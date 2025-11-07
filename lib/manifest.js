import crypto from 'crypto';
import nacl from 'tweetnacl';
import { cfg } from './config.js';

export function buildManifest(namedFiles, rulesMeta){
  const files = Object.entries(namedFiles).map(([name, buf]) => ({
    name,
    bytes: buf.length,
    sha256: sha256Hex(buf)
  }));
  const manifest = {
    created_utc: new Date().toISOString(),
    hash_algo: 'SHA-256',
    ruleset_id: rulesMeta.ruleset_id,
    files
  };

  if (cfg.SIGN_PRIVATE_KEY && cfg.SIGN_PUBLIC_KEY){
    try{
      const msg = Buffer.from(JSON.stringify({
        files,
        created_utc: manifest.created_utc,
        ruleset_id: manifest.ruleset_id
      }));
      const secret = Buffer.from(cfg.SIGN_PRIVATE_KEY, 'base64');
      const signature = nacl.sign.detached(new Uint8Array(msg), new Uint8Array(secret));
      manifest.signing = {
        key_id: 'ed25519:app',
        signature: Buffer.from(signature).toString('base64')
      };
    }catch(_e){
      // skip signing on error
    }
  }

  return manifest;
}

function sha256Hex(buf){
  return crypto.createHash('sha256').update(buf).digest('hex');
}
