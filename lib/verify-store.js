import crypto from 'crypto';

class Store {
  constructor(){ this.map = new Map(); }
  put(token, zipBuffer, manifest, ttlMin){
    const exp = Date.now() + (ttlMin * 60 * 1000);
    this.map.set(token, { zipBuffer, manifest, exp });
  }
  get(token){
    const v = this.map.get(token);
    if (!v) return null;
    if (Date.now() > v.exp){ this.map.delete(token); return null; }
    return v;
  }
}
export const verifyStore = new Store();
export function newToken(){ return crypto.randomBytes(16).toString('hex'); }
