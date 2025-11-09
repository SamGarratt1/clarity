// --- CONFIG ---
const BACKEND = (location.hostname.includes('localhost') || location.hostname.includes('127.0.0.1'))
  ? 'http://localhost:10000'
  : 'https://clarity-mo5i.onrender.com';

const userId = (() => {
  const k = 'clarity_uid';
  let v = localStorage.getItem(k);
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v); }
  return v;
})();

let currentLang = 'en';
let started = false;

// --- UI helpers ---
const msgsEl = document.getElementById('msgs');
const entryEl = document.getElementById('entry');
const sendBtn = document.getElementById('sendBtn');
const langRow = document.getElementById('langRow');
const langPicked = document.getElementById('langPicked');

function addMsg(text, who='ai') {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function setLangUI(code) {
  currentLang = code;
  for (const b of langRow.querySelectorAll('.lang')) {
    b.setAttribute('aria-pressed', b.dataset.code === code ? 'true' : 'false');
  }
  const label = { en:'English', es:'Español', pt:'Português', fr:'Français' }[code] || 'English';
  langPicked.textContent = `Language: ${label}`;
}

async function setLanguageOnServer(code) {
  try {
    await fetch(`${BACKEND}/user/lang`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ userId, lang: code })
    });
  } catch (_) {}
}

// --- language buttons ---
langRow.addEventListener('click', async (e) => {
  const btn = e.target.closest('.lang');
  if (!btn) return;
  const code = btn.dataset.code;
  setLangUI(code);
  await setLanguageOnServer(code);

  if (!started) {
    started = true;
    addMsg('…', 'ai');
    const r = await fetch(`${BACKEND}/app-chat`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ userId, message: 'start', lang: currentLang })
    });
    const j = await r.json();
    msgsEl.lastChild.remove();
    addMsg(j.reply || 'Ready.');
  }
});

// --- send flow ---
async function sendMessage() {
  const text = entryEl.value.trim();
  if (!text) return;
  entryEl.value = '';
  addMsg(text, 'me');

  addMsg('…', 'ai');
  const r = await fetch(`${BACKEND}/app-chat`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ userId, message: text, lang: currentLang })
  });
  const j = await r.json();
  msgsEl.lastChild.remove();
  if (!j.ok) { addMsg(j.error || 'Error.'); return; }

  if (j.clinics && Array.isArray(j.clinics) && j.clinics.length) {
    const lines = j.clinics.map(c => {
      const tags = (c.tags || []).join(', ');
      const extras = [
        c.distanceMiles!=null ? `${c.distanceMiles} mi` : null,
        c.rating!=null ? `⭐ ${c.rating}` : null,
        tags ? `[${tags}]` : null
      ].filter(Boolean).join(' · ');
      return `• ${c.id}. ${c.name}${c.address ? ' — ' + c.address : ''}${extras ? '\n   ' + extras : ''}`;
    }).join('\n');
    addMsg(lines, 'ai');
  }

  if (j.note) addMsg(j.note, 'ai');
  addMsg(j.reply || 'OK', 'ai');
}

sendBtn.addEventListener('click', sendMessage);
entryEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// default select English and wait for user click
setLangUI('en');
