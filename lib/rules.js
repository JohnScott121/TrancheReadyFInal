import { parseISO, differenceInCalendarDays, isAfter } from 'date-fns';

const HR_COUNTRIES = new Set(['RU','CN','HK','AE','IN','IR']);

function toBand(score){
  if (score >= 30) return 'High';
  if (score >= 15) return 'Medium';
  return 'Low';
}

function daysBetween(a, b){ return Math.abs(differenceInCalendarDays(parseISO(a), parseISO(b))); }

export async function scoreAll(clients, txs, lookback /*, openaiKeyOptional */){
  // Index txs by client within lookback
  const txByClient = new Map();
  const lbStart = parseISO(lookback.start);
  for (const t of txs){
    const td = parseISO(t.date);
    if (isAfter(td, lbStart) || t.date === lookback.start) {
      if (!txByClient.has(t.client_id)) txByClient.set(t.client_id, []);
      txByClient.get(t.client_id).push(t);
    }
  }

  const results = [];
  for (const c of clients){
    const reasons = [];
    let score = 0;

    // ---- Profile signals ----
    const pep = String(c.pep_flag || '').toLowerCase() === 'true';
    const sanc = String(c.sanctions_flag || '').toLowerCase() === 'true';
    if (pep)    { score += 20; reasons.push(reason('profile','PEP flag',20)); }
    if (sanc)   { score += 25; reasons.push(reason('profile','Sanctions flag',25)); }

    // KYC stale (> 12 months)
    if (c.kyc_last_reviewed_at){
      const kd = parseISO(c.kyc_last_reviewed_at);
      if (isNaN(kd)) {
        // ignore unparsable
      } else {
        const latest = parseISO(lookback.end);
        const days = differenceInCalendarDays(latest, kd);
        if (days > 365){ score += 5; reasons.push(reason('profile','Stale KYC > 12 months',5)); }
      }
    }

    // Delivery channel
    const chan = (c.delivery_channel || '').toString().toLowerCase();
    if (chan.includes('online')) { score += 3; reasons.push(reason('profile','Online channel',3)); }

    // Services
    const svc = (c.services || '').toString().toLowerCase();
    if (svc.includes('remittance')) { score += 6; reasons.push(reason('profile','Remittance service',6)); }
    if (svc.includes('property'))   { score += 4; reasons.push(reason('profile','Property service',4)); }

    // Country exposure (client residency or declared country list on profile)
    const rc = (c.residency_country || '').toString().toUpperCase();
    if (HR_COUNTRIES.has(rc)) { score += 8; reasons.push(reason('profile','High-risk residency',8)); }

    // ---- Behavioural in last 18 months ----
    const txlist = (txByClient.get(c.client_id) || []).sort((a,b)=> a.date.localeCompare(b.date));

    // Structuring: >=4 cash deposits 9600–9999 within 7 days
    const cashIn = txlist.filter(t => t.direction==='in' && t.method==='cash' && t.currency==='AUD' && t.amount >= 9600 && t.amount <= 9999);
    let structured = false;
    for (let i=0;i<cashIn.length;i++){
      const win = [cashIn[i]];
      for (let j=i+1;j<cashIn.length;j++){
        if (daysBetween(cashIn[i].date, cashIn[j].date) <= 7) win.push(cashIn[j]);
      }
      if (win.length >= 4){ structured = true; break; }
    }
    if (structured){ score += 12; reasons.push(reason('behaviour','Structuring pattern (≥4 cash deposits 9.6–9.999k in 7 days)',12)); }

    // High-risk corridors: ≥2 intl (out) to HR countries with ≥1 ≥ 20k
    const intlHR = txlist.filter(t => t.direction==='out' && HR_COUNTRIES.has(t.counterparty_country || '') && t.currency==='AUD');
    if (intlHR.length >= 2 && intlHR.some(t => t.amount >= 20000)){
      score += 10; reasons.push(reason('behaviour','High-risk corridor transfers (≥2; one ≥ 20k)',10));
    }

    // Large domestic transfers ≥ 100k (either direction, AU↔AU or no cp country)
    const largeAU = txlist.filter(t => t.currency==='AUD' && t.amount >= 100000 && (!t.counterparty_country || t.counterparty_country === 'AU'));
    if (largeAU.length >= 1){
      score += 8; reasons.push(reason('behaviour','Large domestic transfer ≥ 100k',8));
    }

    results.push({
      client_id: c.client_id,
      score,
      band: toBand(score),
      reasons: reasons.map(r => ({ type:'reason', ...r }))
    });
  }

  return { scores: results, rulesMeta: {
    ruleset_id: 'dnfbp-2025.11',
    lookback,
    corridors: Array.from(HR_COUNTRIES),
    banding: { High: '>=30', Medium: '>=15', Low: '<15' }
  }};
}

function reason(family, text, points){ return { family, text, points }; }
