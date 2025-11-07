(function(){
  const msg = document.getElementById('msg');
  function setMsg(t){ msg.textContent = t || ''; }

  async function go(plan){
    setMsg('Creating checkout session…');
    try{
      const res = await fetch('/api/create-checkout-session', {
        method:'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ plan })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout failed');
      location.href = data.url;
    }catch(e){
      setMsg('Error: ' + (e.message || 'failed'));
    }
  }

  document.querySelectorAll('button[data-plan]').forEach(btn => {
    btn.addEventListener('click', ()=> go(btn.getAttribute('data-plan')));
  });

  const q = new URLSearchParams(location.search);
  if (q.get('success')) setMsg('Payment successful — thank you!');
  if (q.get('canceled')) setMsg('Payment canceled.');
})();
