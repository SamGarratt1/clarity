const API_URL = "https://clarity-mo5i.onrender.com"; // your backend

// persistent user id
function uid(){
  const k="clarity_user_id"; let v=localStorage.getItem(k);
  if(!v){ v="u_"+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(k,v); }
  return v;
}
const USER_ID = uid();

// dom
const thread = document.getElementById("thread");
const msg = document.getElementById("msg");
const send = document.getElementById("send");
const chips = document.querySelectorAll(".chip");

function add(text, who="ai"){
  const b = document.createElement("div");
  b.className = `bubble ${who}`;
  b.textContent = text;
  thread.appendChild(b);
  thread.scrollTop = thread.scrollHeight;
}
function busy(on){ msg.disabled=on; send.disabled=on; }

async function ask(message){
  busy(true);
  try{
    const res = await fetch(`${API_URL}/app-chat`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userId: USER_ID, message })
    });
    const data = await res.json().catch(()=>null);
    if(!res.ok || !data?.ok){ add(`Server error: ${data?.error || res.statusText}`,"ai"); return; }
    add(data.reply,"ai");
  }catch(e){
    add("Couldn't reach the assistant. Please try again.","ai");
    console.error(e);
  }finally{
    busy(false);
  }
}

function sendCurrent(){
  const text = msg.value.trim(); if(!text) return;
  add(text,"me"); msg.value = ""; ask(text);
}

send.addEventListener("click", sendCurrent);
msg.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); sendCurrent(); }});
chips.forEach(c=> c.addEventListener("click", ()=>{ add(c.dataset.q,"me"); ask(c.dataset.q); }));

// friendly opener
add("Hi! I’m your Clarity assistant. I’ll ask a couple quick questions and then call the clinic to book for you.\n\nTap Start or type NEW to begin.");
