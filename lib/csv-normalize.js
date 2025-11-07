import { parseISO, isValid, isAfter, subMonths } from 'date-fns';
import { z } from 'zod';

// Canonical fields + synonyms (lowercased comparison)
const CLIENT_MAP = {
  client_id: ['client_id','clientid','customer_id','customerid','id'],
  full_name: ['full_name','name','client_name','fullname'],
  dob: ['dob','date_of_birth','birthdate'],
  residency_country: ['residency_country','country','country_of_residence','residence_country'],
  delivery_channel: ['delivery_channel','channel','onboarding_channel'],
  services: ['services','service','products'],
  pep_flag: ['pep','pep_flag','is_pep'],
  sanctions_flag: ['sanctions','sanctions_flag','is_sanctioned'],
  kyc_last_reviewed_at: ['kyc_last_reviewed_at','kyc_date','kyc_last_reviewed','last_kyc']
};

const TX_MAP = {
  tx_id: ['tx_id','transaction_id','id'],
  client_id: ['client_id','clientid','customer_id','customerid'],
  date: ['date','tx_date','timestamp','posted_at'],
  amount: ['amount','amt','value'],
  currency: ['currency','ccy'],
  direction: ['direction','dr_cr','in_out','flow'], // in/out
  method: ['method','instrument','channel'],        // cash/wire/eft/cheque/mo
  counterparty_name: ['counterparty_name','payer_name','payee_name','beneficiary'],
  counterparty_country: ['counterparty_country','cp_country','country_to','country_from','destination_country','origin_country'],
  matter_id: ['matter_id','file_id','case_id','engagement_id']
};

const CASH = ['cash','notes','branch_cash'];
const OUT_KEYS = ['out','debit','send'];
const IN_KEYS  = ['in','credit','receive'];

const lc = v => (v ?? '').toString().trim().toLowerCase();

function mapHeaders(row, dict) {
  const out = {};
  for (const k of Object.keys(row)) {
    const lk = lc(k);
    const canonical = Object.keys(dict).find(can => dict[can].includes(lk));
    out[canonical || lk] = row[k];
  }
  return out;
}

export function normalizeClients(rows) {
  const headerMap = {};
  if (rows[0]) {
    for (const k of Object.keys(rows[0])) {
      const lk = lc(k);
      const canonical = Object.keys(CLIENT_MAP).find(can => CLIENT_MAP[can].includes(lk));
      headerMap[k] = canonical || lk;
    }
  }

  const schema = z.object({
    client_id: z.string().min(1).or(z.number().transform(String)),
    full_name: z.string().optional(),
    dob: z.string().optional(),
    residency_country: z.string().optional(),
    delivery_channel: z.string().optional(),
    services: z.string().optional(),
    pep_flag: z.string().optional(),
    sanctions_flag: z.string().optional(),
    kyc_last_reviewed_at: z.string().optional()
  });

  const normalized = rows.map(r => mapHeaders(r, CLIENT_MAP))
    .map(r => schema.safeParse(r).success ? r : r); // keep row even if soft-invalid
  return { clients: normalized, clientHeaderMap: headerMap };
}

export function normalizeTransactions(rows) {
  const headerMap = {};
  if (rows[0]) {
    for (const k of Object.keys(rows[0])) {
      const lk = lc(k);
      const canonical = Object.keys(TX_MAP).find(can => TX_MAP[can].includes(lk));
      headerMap[k] = canonical || lk;
    }
  }

  const rejects = [];
  const txs = rows.map((r, i) => {
    const t = mapHeaders(r, TX_MAP);

    // Date
    let d = typeof t.date === 'string' ? parseISO(t.date) : null;
    if (!isValid(d)) d = null;

    // Amount
    let amt = typeof t.amount === 'string' ? Number(t.amount.replace(/[^0-9.-]/g, '')) : Number(t.amount);
    if (!Number.isFinite(amt)) amt = null;

    // Direction
    const dirRaw = lc(t.direction);
    let direction = null;
    if (OUT_KEYS.some(x => dirRaw.includes(x))) direction = 'out';
    else if (IN_KEYS.some(x => dirRaw.includes(x))) direction = 'in';
    else if (dirRaw === 'in' || dirRaw === 'out') direction = dirRaw;

    // Method
    const mRaw = lc(t.method);
    let method = null;
    if (CASH.some(x => mRaw.includes(x))) method = 'cash';
    else if (mRaw.includes('wire') || mRaw.includes('swift') || mRaw.includes('intl')) method = 'wire';
    else if (mRaw.includes('eft') || mRaw.includes('ach') || mRaw.includes('transfer')) method = 'eft';
    else if (mRaw.includes('cheque') || mRaw.includes('check')) method = 'cheque';
    else if (mRaw.includes('mo') || mRaw.includes('money order')) method = 'money_order';
    else method = mRaw || null;

    // Country
    const ctry = (t.counterparty_country || '').toString().trim().toUpperCase();

    const tx = {
      tx_id: t.tx_id ?? null,
      client_id: (t.client_id ?? '').toString(),
      date: d ? d.toISOString().slice(0,10) : null,
      amount: amt,
      currency: (t.currency || 'AUD').toString().toUpperCase(),
      direction,
      method,
      counterparty_name: t.counterparty_name || null,
      counterparty_country: ctry || null,
      matter_id: t.matter_id || null
    };

    if (!tx.client_id || !tx.date || !Number.isFinite(tx.amount)) {
      rejects.push({ index: i, reason: 'Missing client_id/date/amount', row: r });
      return null;
    }
    return tx;
  }).filter(Boolean);

  // Lookback: 18 months based on latest tx date
  const latest = txs.reduce((acc, t) => {
    const d = parseISO(t.date);
    return !acc || isAfter(d, acc) ? d : acc;
  }, null);
  const lookback = {
    end: (latest || new Date()).toISOString().slice(0,10),
    start: subMonths(latest || new Date(), 18).toISOString().slice(0,10)
  };

  return { txs, rejects, txHeaderMap: headerMap, lookback };
}
