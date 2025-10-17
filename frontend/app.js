// ===== Config =====
const API_URL = "https://clarity-mo5i.onrender.com"; // your backend

// ===== Debug badge =====
const badge = document.getElementById("chat-status");
function dbg(msg){
  const ts = new Date().toLocaleTimeString();
  if (badge) badge.textContent = `chat: ${msg} @ ${ts}`;
  console.log("[chat]", msg);
}
dbg("JS loaded");

// ===== Safe ID helper =====
function must(id){
  const el = document.getElementById(id);
  if(!el){ dbg(`missing #${id}`); throw new Error(`missing #${id}`); }
  return el;
}

// ===== Persistent user id =====
function getUserId(){
  const k="clarity_user_id";
  let id=localStorage.getItem(k);
  if(!id){ id="u_"+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(k,id); }
  return id;
}
const USER_ID = getUserId();

// ===== DOM =====
const panel  = must("chat-panel");
const toggle = must("chat-toggle");
const closeX = must("chat-close");
const log    = must("chat-log");
const input  = must("chat-input");
const send   = must("chat-send");
const chips  = document.querySelectorAll(".chip");

// ===== UI helpers =====
function addMsg(text, who="ai"){
  const div=document.createElement("div");
  div.className=`msg ${who==="me"?"msg--me":"msg--ai"}`;
  div.textContent=text;
  log.appendChild(div);
  log.scrollTop=log.scrollHeight;
}
function setBusy(b){ input.disabled=b; send.disabled=b; }

// ===== API =====
async function sendToAssistant(message){
  setBusy(true);
  dbg("posting /app-chat");
  try{
    const res = await fetch(`${API_URL}/app-chat`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userId: USER_ID, message })
    });
    dbg(`response ${res.status}`);
    let data=null; try{ data = await res.json(); }catch{}
    if(!res.ok){ addMsg(`Server error: ${data?.error || ("HTTP "+res.status)}`,"ai"); return; }
    if(!data?.ok){ addMsg(`Assistant error: ${data?.error || "unknown"}`,"ai"); return; }
    addMsg(data.reply,"ai");
  }catch(e){
    console.error(e);
    dbg("fetch error");
    addMsg("Couldn’t reach the assistant. Please try again.","ai");
  }finally{
    setBusy(false);
  }
}

// ===== Events =====
toggle.addEventListener("click", ()=>{
  panel.hidden = !panel.hidden;
  dbg(panel.hidden ? "panel closed" : "panel opened");
  if(!panel.hidden && log.children.length===0){
    addMsg("Welcome to Clarity — I’ll grab the details and book for you. Type NEW to begin, or tap Start.");
  }
});

closeX.addEventListener("click", ()=>{
  panel.hidden = true;
  dbg("panel closed (X)");
});

send.addEventListener("click", ()=>{
  const text=input.value.trim();
  if(!text){ dbg("empty input"); return; }
  dbg(`send clicked: "${text}"`);
  addMsg(text,"me");
  input.value="";
  sendToAssistant(text);
});

// Enter to send
input.addEventListener("keydown",(e)=>{
  if(e.key === "Enter"){
    e.preventDefault();
    dbg("enter pressed");
    send.click();
  }
});

// Chips
chips.forEach(btn=>{
  btn.addEventListener("click",()=>{
    const q=btn.dataset.q;
    dbg(`chip ${q}`);
    addMsg(q,"me"); sendToAssistant(q);
  });
});

// Auto-open first visit
if(!sessionStorage.getItem("clarity_opened")){
  toggle.click();
  sessionStorage.setItem("clarity_opened","1");
  dbg("auto-open");
}

dbg("boot complete");
