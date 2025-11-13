(() => {
  const stream = document.getElementById('stream');
  const form   = document.getElementById('chatForm');
  const input  = document.getElementById('chatInput');
  const sendBtn= document.getElementById('sendBtn');
  const langRow= document.getElementById('langRow');

  // build language buttons
  const makeLangBtn = (id,label) => {
    const b = document.createElement('button');
    b.type='button'; b.className='lang' + (id===currentLang?' active':'');
    b.textContent = label; b.dataset.id=id;
    b.onclick = () => {
      currentLang = id;
      localStorage.setItem('clarity:web:lang', id);
      [...langRow.querySelectorAll('.lang')].forEach(x=>x.classList.toggle('active', x.dataset.id===id));
      // tell backend language changed (optional)
      sendSystem(`LANG:${id}`);
    };
    return b;
  };
  LANGS.forEach(([id,label]) => langRow.appendChild(makeLangBtn(id,label)));

  // quick actions
  document.querySelectorAll('.pill').forEach(p=>{
    p.addEventListener('click', () => {
      input.value = p.dataset.send || p.textContent.trim();
      form.requestSubmit();
    });
  });

  // helpers
  const addMsg = (role, text) => {
    const row = document.createElement('div');
    row.className = `msg ${role==='user'?'you':'ai'}`;
    const who = document.createElement('div');
    who.className='who';
    who.textContent = role==='user' ? 'You:' : 'Assistant:';
    const body = document.createElement('div');
    body.className='text';
    body.textContent = text;
    row.appendChild(who); row.appendChild(body);
    stream.appendChild(row);
    stream.scrollTop = stream.scrollHeight;
  };

  const sendSystem = (text) => send(text, true);

  async function send(text, isSystem=false){
    if(!text) return;
    addMsg(isSystem?'user':'user', text);   // show what we send
    input.value = ''; sendBtn.disabled = true;

    try{
      const res = await fetch(SEND_ENDPOINT, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          from: FROM,
          session: SESSION,
          text,
          lang: currentLang
        })
      });
      if(!res.ok){
        addMsg('assistant', `Server error: ${res.status} ${res.statusText}`);
      }else{
        const data = await res.json(); // {reply: "..."}
        addMsg('assistant', data.reply || '');
      }
    }catch(err){
      addMsg('assistant', `Network error: ${String(err)}`);
    }finally{
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // form submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    send(text);
  });

  // auto-greet if first time
  if(!localStorage.getItem('clarity:web:greeted')){
    localStorage.setItem('clarity:web:greeted','1');
    sendSystem('Start');
  }

  // small UX: Enter to send; Shift+Enter newline
  input.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      form.requestSubmit();
    }
  });
})();
