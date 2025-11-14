// chat-full.js

const API_URL = "https://clarity-mo5i.onrender.com"; // <- your Render backend base

const messagesEl = document.getElementById("chat-messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const quickButtons = document.querySelectorAll(".chip");
const langButtons = document.querySelectorAll(".lang-pill");

let currentLang = "en";

// Helpers
function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = "msg";

  const meta = document.createElement("span");
  meta.className =
    "msg-meta " + (role === "assistant" ? "msg-meta--assistant" : "msg-meta--user");
  meta.textContent = role === "assistant" ? "Assistant:" : "You:";

  const body = document.createElement("span");
  body.textContent = " " + text;

  row.appendChild(meta);
  row.appendChild(body);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setLang(lang) {
  currentLang = lang;
  langButtons.forEach((btn) => {
    btn.classList.toggle("lang-pill--active", btn.dataset.lang === lang);
  });
}

// Initial greeting
addMessage(
  "assistant",
  "Welcome to Clarity — I'll grab the details and book for you. Type NEW to begin, or say ASAP for the earliest slot."
);

// Send to backend
async function sendToAssistant(text) {
  const payload = {
    message: text,
    source: "web",
    lang: currentLang
  };

  try {
    const res = await fetch(`${API_URL}/chat/web`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const t = await res.text();
      addMessage("assistant", `Server error: ${t || res.status}`);
      return;
    }

    const data = await res.json();
    if (data && data.reply) {
      addMessage("assistant", data.reply);
    } else {
      addMessage("assistant", "I received a response but couldn't read it.");
    }
  } catch (err) {
    addMessage("assistant", "Network error talking to the server.");
    console.error(err);
  }
}

// Form submit
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = (inputEl.value || "").trim();
  if (!text) return;

  addMessage("user", text);
  inputEl.value = "";
  sendToAssistant(text);
});

// Quick buttons
quickButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.quick;
    let text;
    switch (action) {
      case "NEW":
        text = "NEW";
        break;
      case "MY_CLINIC":
        text = "Use my usual clinic.";
        break;
      case "NEARBY":
        text = "Show nearby clinics.";
        break;
      case "ASAP":
        text = "ASAP";
        break;
      default:
        text = action;
    }

    addMessage("user", text);
    sendToAssistant(text);
  });
});

// Language selection buttons
langButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setLang(btn.dataset.lang);
    addMessage(
      "assistant",
      `Language set. I'll triage in your language, but translate for the clinic when we call.`
    );
  });
});
