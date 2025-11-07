// Elements
const form = document.getElementById('uform');
const clientsInput = document.getElementById('clientsInput');
const txInput = document.getElementById('txInput');
const drop = document.getElementById('drop');
const progress = document.getElementById('progress'); const bar = progress?.querySelector('.bar');
const skeleton = document.getElementById('skeleton');
const out = document.getElementById('out');
const toastEl = document.getElementById('toast');
const submitBtn = document.getElementById('submitBtn');

// Toast
function toast(msg, ms=2200){
  toastEl.textContent = msg; toastEl.hidden = false;
  requestAnimationFrame(()=> toastEl.classList.add('show'));
  setTimeout(()=> { toastEl.classList.remove('show'); setTimeout(()=>toastEl.hidden=true, 180); }, ms);
}

// Drag & drop
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

// Submit
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!clientsInput.files[0] || !txInput.files[0]) { toast('Select both files'); return; }
  if (!/\.csv$/i.test(clientsInput.files[0].name) || !/\.csv$/i.test(txInput.files[0].name)) { toast('Files must be .csv'); return; }

  try{
    submitBtn.classList.add('loading');
    out.textContent = '';
    skeleton.hidden = false; progress.hidden = false; setBar(10);

    const fd = new FormData();
    fd.append('clients', clientsInput.files[0]);
    fd.append('transactions', txInput.files[0]);

    setBar(40);
    const res = await fetch('/api/validate', { method:'POST', body: fd });
    setBar(70);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Validation failed');

    out.textContent = JSON.stringify(data, null, 2);
    toast('Validated');
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
});

function setBar(p){ if(bar) bar.style.width = `${Math.max(0, Math.min(100, p))}%`; }
