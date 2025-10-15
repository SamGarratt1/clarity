// ===== Config =====
const API_URL = "https://clarity-mo5i.onrender.com";  // <- your Render backend URL

// ===== Simple persistent user id =====
function getUserId(){
  const k = "clarity_user_id";
  let id = localStorage.getItem(k);
  if(!id){
    id = "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(k, id);
  }
  return id;
}
const USER_ID = getUserId();

// ===== DOM =====
const panel = document.getElementById("chat-panel");
const toggle = document.getElementById("chat-toggle");
const closeBtn = document.getElementById("chat-close");
const log = document.getElementById("chat-log");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const quick = document.querySelectorAll(".chip");

// ===== UI helpers =====
function addMsg(text, who="ai"){
  const div = document.createElement("div");
  div.className = `msg ${who === "me" ? "msg--me" : "msg--ai"}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function setBusy(b){
  input.disabled = b;
  form.querySelector("button[type=submit]").disabled = b;
}

// ===== API =====
async function sendToAssistant(message){
  setBusy(true);
  try{
    const res = await fetch(`${API_URL}/app-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER_ID, message })
    });
    const data = await res.json();
    if(!data.ok) throw new Error(data.error || "Server error");
    addMsg(data.reply, "ai");
  }catch(e){
    addMsg("Hmm, I couldn’t reach the assistant. Please try again.", "ai");
    console.error(e);
  }finally{
    setBusy(false);
  }
}

// ===== Events =====
toggle.addEventListener("click", ()=>{
  panel.hidden = !panel.hidden;
  if(!panel.hidden && log.children.length === 0){
    // greet once
    addMsg("Welcome to Clarity — I’ll grab the details and book for you. Type NEW to begin, or tap Start.");
  }
});
closeBtn.addEventListener("click", ()=> panel.hidden = true);

form.addEventListener("submit", (e)=>{
  e.preventDefault();
  const text = input.value.trim();
  if(!text) return;
  addMsg(text, "me");
  input.value = "";
  sendToAssistant(text);
});

quick.forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const q = btn.dataset.q;
    addMsg(q, "me");
    sendToAssistant(q);
  });
});

// Optional: auto-open + auto-start first-time visitors
if(!sessionStorage.getItem("opened")){
  toggle.click(); // open
  sessionStorage.setItem("opened","1");
}
