const form = document.getElementById('uform');
const clientsInput = document.getElementById('clientsInput');
const txInput = document.getElementById('txInput');
const drop = document.getElementById('drop');
const progress = document.getElementById('progress'); const bar = progress?.querySelector('.bar');
const skeleton = document.getElementById('skeleton');
const out = document.getElementById('out');

const summary = document.getElementById('summary');
const verifyUrlEl = document.getElementById('verifyUrl');
const copyVerify = document.getElementById('copyVerify');
const openVerify = document.getElementById('openVerify');
const downloadZip = document.getElementById('downloadZip');
const riskWrap = document.getElementById('riskWrap'); const riskBody = document.getElementById('riskBody');

const toastEl = document.getElementById('toast');
const submitBtn = document.getElementById('submitBtn');
const validateBtn = document.getElementById('validateBtn');

function toast(msg, ms=2200){
  toastEl.textContent = msg; toastEl.hidden = false;
  requestAnimationFrame(()=> toastEl.classList.add('show'));
  setTimeout(()=> { toastEl.classList.remove('show'); setTimeout(()=>toastEl.hidden=true, 180); }, ms);
}

if (drop){
  const setHover = (v)=> drop.setAttribute('data-hover', v?'true':'false');
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); setHover(true); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if(ev==='drop'){ handleDrop(e); } setHover(false); }));
  drop.addEventListener('click', ()=> clientsInput?.click());
  drop.addEventListener('keydown', (e)=>{ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); clientsInput?.click(); } });

  function handleDrop(e){
    const files = [...(e.dataTransfer?.files || [])];
    const clients = files.find(f => /\.csv$/i.test(f.name) && /clients?/i.test(f.name));
    const txs = files.find(f => /\.csv$/i.test(f.name) && /(transactions?|transfers?)/i.test(f.name));
    if (clients) setFile(clientsInput, clients);
    if (txs) setFile(txInput, txs);
    if (!clients || !txs) toast('Need both Clients.csv and Transactions.csv');
  }
  function setFile(input, file){ const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; }
}

validateBtn?.addEventListener('click', () => run('/api/validate'));
form?.addEventListener('submit', (e) => { e.preventDefault(); run('/upload', true); });

async function run(url, isGenerate=false){
  if (!clientsInput.files[0] || !txInput.files[0]) { toast('Select both files'); return; }
  if (!/\.csv$/i.test(clientsInput.files[0].name) || !/\.csv$/i.test(txInput.files[0].name)) { toast('Files must be .csv'); return; }

  try{
    if (isGenerate) submitBtn.classList.add('loading');
    out.textContent = '';
    summary.hidden = true; riskWrap.hidden = true;
    skeleton.hidden = false; progress.hidden = false; setBar(8);

    const fd = new FormData();
    fd.append('clients', clientsInput.files[0]);
    fd.append('transactions', txInput.files[0]);

    setBar(35);
    const res = await fetch(url, { method:'POST', body: fd });
    setBar(65);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    if (isGenerate){
      // Show verify + download + risk table
      verifyUrlEl.textContent = data.verify_url;
      openVerify.href = data.verify_url;
      downloadZip.href = data.download_url;
      summary.hidden = false;

      renderRisk(data.risk);
      riskWrap.hidden = false;
      out.textContent = ''; // keep console clean on generate
      toast('Evidence ready');
    } else {
      // Show validation JSON
      out.textContent = JSON.stringify(data, null, 2);
      toast('Validated');
    }

    setBar(100);
  }catch(err){
    out.textContent = JSON.stringify({ ok:false, error: err.message || String(err) }, null, 2);
    toast('Error: ' + (err.message || 'failed'));
  }finally{
    skeleton.hidden = true;
    setTimeout(()=> progress.hidden = true, 500);
    submitBtn.classList.remove('loading');
    setBar(0);
  }
}

copyVerify?.addEventListener('click', async ()=>{
  try { await navigator.clipboard.writeText(verifyUrlEl.textContent); toast('Verify link copied'); }
  catch { toast('Copy failed'); }
});

function setBar(p){ if(bar) bar.style.width = `${Math.max(0, Math.min(100, p))}%`; }

function renderRisk(items){
  riskBody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const tr = document.createElement('tr');

    const tdC = document.createElement('td'); tdC.innerHTML = `<span class="mono">${esc(item.client_id||'—')}</span>`; tr.appendChild(tdC);

    const tdB = document.createElement('td');
    const band = (item.band||'').toLowerCase();
    tdB.innerHTML = `<span class="badge ${band==='high'?'high':band==='medium'?'med':'low'}">${esc(item.band)}</span>`;
    tr.appendChild(tdB);

    const tdS = document.createElement('td'); tdS.textContent = String(item.score ?? 0); tr.appendChild(tdS);

    const tdR = document.createElement('td');
    const reasons = (item.reasons||[]).filter(r=>r.type==='reason');
    if (reasons.length){
      const det = document.createElement('details'); const sum = document.createElement('summary'); sum.textContent = `${reasons.length} reason${reasons.length===1?'':'s'}`;
      const list = document.createElement('div'); list.className = 'reason-list';
      reasons.forEach(r => {
        const row = document.createElement('div'); row.className = 'reason';
        const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = r.family + (r.points?` +${r.points}`:'');
        const txt = document.createElement('span'); txt.textContent = r.text; row.append(tag, txt); list.appendChild(row);
      });
      det.append(sum, list); tdR.appendChild(det);
    } else { tdR.innerHTML = '<span class="muted">—</span>'; }
    tr.appendChild(tdR);

    frag.appendChild(tr);
  }
  riskBody.appendChild(frag);
}
function esc(s){ return (s??'').toString().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
