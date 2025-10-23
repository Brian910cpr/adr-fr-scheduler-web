
const $ = (q)=>document.querySelector(q);
const msg = $('#msg');
const step1 = $('#step1'), step2 = $('#step2');
const sendBtn = $('#send'), verifyBtn=$('#verify');
const ident = $('#ident'), codeIn = $('#code');
const mask = $('#mask');

sendBtn.onclick = async ()=>{
  msg.textContent = "";
  const identVal = ident.value.trim();
  if(!identVal){ msg.textContent = "Please enter your member # or name."; return; }
  sendBtn.disabled = true;
  try{
    const r = await fetch('/api/auth/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ member_identifier: identVal }) });
    const j = await r.json();
    if(!j.ok){ throw new Error(j.error || 'Failed to send code'); }
    mask.textContent = `We sent a code to ${j.channel === 'sms' ? 'phone' : 'email'}: ${j.mask}`;
    step2.classList.remove('hidden');
    codeIn.focus();
  }catch(e){
    msg.innerHTML = `<span class="err">${e.message}</span>`;
  }finally{
    sendBtn.disabled = false;
  }
};

verifyBtn.onclick = async ()=>{
  msg.textContent = "";
  const identVal = ident.value.trim();
  const codeVal = codeIn.value.trim();
  if(!codeVal){ msg.textContent = "Enter the 6-digit code."; return; }
  verifyBtn.disabled = true;
  try{
    const r = await fetch('/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ member_identifier: identVal, code: codeVal }) });
    const j = await r.json();
    if(!j.ok){ throw new Error(j.error || 'Invalid code'); }
    msg.innerHTML = `<span class="ok">Welcome, ${j.display} (${j.role}). You’re signed in.</span>`;
    setTimeout(()=>location.href='/', 700);
  }catch(e){
    msg.innerHTML = `<span class="err">${e.message}</span>`;
  }finally{
    verifyBtn.disabled = false;
  }
};
