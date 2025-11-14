// Modern Chat Interface JavaScript

const API_URL = "https://clarity-mo5i.onrender.com"; // Update this to your backend URL

const messagesEl = document.getElementById("chat-messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const quickButtons = document.querySelectorAll(".chip");
const langButtons = document.querySelectorAll(".lang-pill");

let currentLang = "en";
let isLoading = false;

// Generate or retrieve session ID for persistent sessions
function getSessionId() {
  let sessionId = localStorage.getItem('clarity_session_id');
  if (!sessionId) {
    sessionId = 'web-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('clarity_session_id', sessionId);
  }
  return sessionId;
}

// Helper: Add message to chat
function addMessage(role, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = "msg";

  const meta = document.createElement("span");
  meta.className = `msg-meta ${role === "assistant" ? "msg-meta--assistant" : "msg-meta--user"}`;
  meta.textContent = role === "assistant" ? "Assistant" : "You";

  const body = document.createElement("span");
  // Handle markdown-style bold (**text**)
  body.innerHTML = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  msgDiv.appendChild(meta);
  msgDiv.appendChild(body);
  messagesEl.appendChild(msgDiv);
  
  // Smooth scroll to bottom
  messagesEl.scrollTo({
    top: messagesEl.scrollHeight,
    behavior: 'smooth'
  });
}

// Helper: Show loading indicator
function showLoading() {
  if (isLoading) return;
  isLoading = true;
  
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "msg";
  loadingDiv.id = "loading-indicator";
  
  const meta = document.createElement("span");
  meta.className = "msg-meta msg-meta--assistant";
  meta.textContent = "Assistant";
  
  const body = document.createElement("span");
  body.innerHTML = '<span class="typing-indicator"><span>.</span><span>.</span><span>.</span></span>';
  
  loadingDiv.appendChild(meta);
  loadingDiv.appendChild(body);
  messagesEl.appendChild(loadingDiv);
  messagesEl.scrollTo({
    top: messagesEl.scrollHeight,
    behavior: 'smooth'
  });
}

// Helper: Remove loading indicator
function hideLoading() {
  const loading = document.getElementById("loading-indicator");
  if (loading) {
    loading.remove();
  }
  isLoading = false;
}

// Helper: Set language
function setLang(lang) {
  currentLang = lang;
  langButtons.forEach((btn) => {
    btn.classList.toggle("lang-pill--active", btn.dataset.lang === lang);
  });
}

// Initial greeting
addMessage(
  "assistant",
  "Welcome to Clarity Health Concierge! I'm here to help you book a medical appointment. Type **NEW** to begin, or use the quick actions below."
);

// API: Send message to assistant
async function sendToAssistant(text) {
  if (isLoading) return;
  
  const payload = {
    message: text,
    source: "web",
    lang: currentLang,
    sessionId: getSessionId()
  };

  showLoading();

  try {
    const res = await fetch(`${API_URL}/chat/web`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    hideLoading();

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Server error:", res.status, errorText);
      let errorMsg = `Sorry, I encountered an error (${res.status}). `;
      if (res.status === 404) {
        errorMsg += "The server endpoint was not found. Please check if the backend is running.";
      } else if (res.status === 500) {
        errorMsg += "The server encountered an internal error.";
      } else {
        errorMsg += "Please try again.";
      }
      addMessage("assistant", errorMsg);
      return;
    }

    const data = await res.json();
    if (data && data.reply) {
      addMessage("assistant", data.reply);
    } else {
      addMessage("assistant", "I received a response but couldn't process it. Please try again.");
    }
  } catch (err) {
    hideLoading();
    console.error("Network error:", err);
    let errorMsg = "I'm having trouble connecting to the server. ";
    if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")) {
      errorMsg += `The backend at ${API_URL} might be down or unreachable. Please check your connection.`;
    } else {
      errorMsg += `Error: ${err.message}. Please try again.`;
    }
    addMessage("assistant", errorMsg);
  }
}

// Form submit handler
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = (inputEl.value || "").trim();
  if (!text || isLoading) return;

  addMessage("user", text);
  inputEl.value = "";
  sendToAssistant(text);
});

// Quick action buttons
quickButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isLoading) return;
    
    const action = btn.dataset.quick;
    let text;

    switch (action) {
      case "NEW":
        text = "NEW";
        break;
      case "MY_CLINIC":
        text = "Use my usual clinic";
        break;
      case "NEARBY":
        text = "Nearby options";
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

// Language selector buttons
langButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const lang = btn.dataset.lang;
    const oldLang = currentLang;
    setLang(lang);
    
    // Only show message if language actually changed
    if (oldLang !== lang) {
      addMessage(
        "assistant",
        `Language updated to ${btn.textContent}. I'll communicate with you in this language and translate for the clinic when I call. Type "NEW" to start a new conversation in ${btn.textContent}.`
      );
      
      // Send language update to backend silently to update the session
      // This ensures future messages use the new language
      fetch(`${API_URL}/chat/web`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `[Language changed to ${lang}]`,
          source: "web",
          lang: lang,
          sessionId: getSessionId()
        })
      }).then(() => {
        // After language is updated, also send a test message to verify
        console.log(`Language updated to ${lang} in backend`);
      }).catch(err => console.error("Language update error:", err));
    }
  });
});

// Add typing indicator CSS
const style = document.createElement('style');
style.textContent = `
  .typing-indicator {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .typing-indicator span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--primary-light);
    animation: typing 1.4s infinite;
  }
  .typing-indicator span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .typing-indicator span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes typing {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.7;
    }
    30% {
      transform: translateY(-10px);
      opacity: 1;
    }
  }
`;
document.head.appendChild(style);
