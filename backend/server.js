// --- Imports and setup ---
import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import twilioPkg from "twilio";
import fetch from "node-fetch";
import cors from "cors";

// allow your Vercel site + local dev
const ALLOWED_ORIGINS = [
  "https://clarity-frontend-three.vercel.app",
  /\.vercel\.app$/ // any vercel preview
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-to-server / curl
    if (ALLOWED_ORIGINS.some(o => (o instanceof RegExp ? o.test(origin) : o === origin))) {
      return cb(null, true);
    }
    return cb(new Error("CORS blocked for origin " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors()); // handle preflight


dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Config ---
const PORT = process.env.PORT || 3000;
const BRAND_NAME = "Clarity Health Concierge";
const BRAND_SLOGAN = "AI-powered appointment scheduling";
const twilioClient = twilioPkg(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- In-memory stores ---
const smsSessions = new Map();
const lastCallByPatient = new Map();
const preferredClinicsByPatient = new Map();

// --- Helper functions ---
const savePreferredClinic = (from, clinic) => {
  if (!preferredClinicsByPatient.has(from)) preferredClinicsByPatient.set(from, []);
  preferredClinicsByPatient.get(from).push(clinic);
};
const getPreferredClinics = (from) => preferredClinicsByPatient.get(from) || [];

const isValidNameLF = (s) => /,/.test(s);
const parseNameLF = (s) => {
  const [last, first] = s.split(",").map((x) => x.trim());
  return { first, last };
};
const splitFirstLast = (s) => {
  const parts = s.split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(" ") };
};
const isValidZip = (s) => /^\d{5}$/.test(s);
const isValidYN = (s) => /^[YNyn]$/.test(s);
const ynToBool = (s) => /^[Yy]/.test(s);
const isValidDate = (s) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s);
const isValidTime = (s) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s);

const inferSpecialty = (symptom) => {
  const lower = symptom.toLowerCase();
  if (lower.includes("eye")) return "optometrist";
  if (lower.includes("skin")) return "dermatologist";
  if (lower.includes("ear") || lower.includes("throat")) return "ENT";
  return "primary care";
};

const nextIntakePrompt = (s) => {
  switch (s.state) {
    case "intake_name": return "What is the patient's full name?";
    case "intake_symptoms": return "What’s the reason for the visit?";
    case "intake_zip": return "What ZIP code should I search near?";
    case "intake_ins": return "Do you have insurance? (Y/N)";
    case "intake_date": return "What date works best? (MM/DD/YYYY)";
    case "intake_time": return "Preferred time? (e.g., 10:30 AM)";
    case "confirm_intake": return `Confirm booking for ${s.patientName} about "${s.symptoms}" near ${s.zip} on ${s.dateStr} at ${s.timeStr}? Reply YES to continue.`;
    default: return "Reply NEW to start over.";
  }
};

// --- Twilio voice helper ---
const speak = (g, text) => g.say({ voice: "Polly.Amy" }, text);

// --- Find clinics mock (replace with real API later) ---
async function findClinics(zip, specialty) {
  return [
    { name: `${specialty} Clinic of ${zip}`, phone: process.env.TEST_CLINIC_PHONE, address: "123 Main St" },
  ];
}

// --- Start a clinic call ---
async function startClinicCall(details) {
  if (!details.to) throw new Error('Missing clinic number');
  console.log(`Calling clinic ${details.clinicName} (${details.to}) for ${details.name}`);
  lastCallByPatient.set(details.callback, details);

  const call = await twilioClient.calls.create({
    twiml: `<Response><Say>Calling ${details.clinicName} for ${details.name} about ${details.reason}</Say></Response>`,
    to: details.to,
    from: process.env.TWILIO_PHONE_NUMBER,
  });
  return call.sid;
}

// --- AI call prompt builder ---
function buildSystemPrompt(userReq) {
  const nameText = userReq.name || "John Doe";
  return `
You are a polite, concise patient concierge calling a clinic to book an appointment.
Goal: secure the earliest suitable slot that matches the patient’s preferences.

Handling rules:
- If staff says "anytime", "come anytime", "we are free all day", or "walk-in":
  • Prefer a specific time slot. Politely ask: "Could we put ${nameText} on the schedule at your earliest specific time today, or tomorrow morning?"
  • If they only accept walk-ins, confirm "Walk-in (any time during business hours)" and proceed.
- Always confirm: patient name, reason, callback, insurance if pressed.
- Confirm: "Great, please confirm: [date/time or Walk-in], provider if available, any prep."
- Before ending, ask: "Is there anything that ${nameText} needs to bring?"
- Then thank and end call.

Patient:
Name: ${nameText}
Reason: ${userReq.reason || "Check-up"}
Preferred: ${JSON.stringify(userReq.preferredTimes || ["This week"])}
Callback: ${userReq.callback || "N/A"}
`.trim();
}

// --- handleText (shared logic for SMS + App) ---
async function handleText(from, rawBody) {
  const body = (rawBody || "").trim();
  const lower = body.toLowerCase();
  const send = (t) => t;

  let s = smsSessions.get(from);

  if (!s || /\b(new|restart|reset)\b/.test(lower)) {
    s = { state: "intake_name" };
    smsSessions.set(from, s);
    return send(`Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}.\nLet's begin.\n${nextIntakePrompt(s)}`);
  }

  if (s.state === "intake_name") {
    const fl = splitFirstLast(body);
    if (!fl) return "Please enter first and last name.";
    s.firstName = fl.first; s.lastName = fl.last; s.patientName = `${fl.first} ${fl.last}`;
    s.state = "intake_symptoms"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "intake_symptoms") {
    s.symptoms = body;
    s.state = "intake_zip"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "intake_zip") {
    if (!isValidZip(body)) return "ZIP should be 5 digits.";
    s.zip = body; s.state = "intake_ins"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "intake_ins") {
    if (!isValidYN(body)) return "Reply Y or N.";
    s.insuranceY = ynToBool(body);
    s.state = "intake_date"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "intake_date") {
    if (!isValidDate(body)) return "Use MM/DD/YYYY.";
    s.dateStr = body; s.state = "intake_time"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "intake_time") {
    if (!isValidTime(body)) return "Use time like 10:30 AM.";
    s.timeStr = body; s.state = "confirm_intake"; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }

  if (s.state === "confirm_intake") {
    if (!/^yes\b/i.test(body)) return "Please reply YES to continue.";
    const clinics = await findClinics(s.zip, s.specialty || "primary care");
    const top = clinics[0];
    if (!top) return "No clinics found. Try again.";
    await startClinicCall({
      to: top.phone, name: s.patientName, reason: s.symptoms,
      preferredTimes: [`${s.dateStr} ${s.timeStr}`],
      clinicName: top.name, callback: from,
    });
    s.state = "calling"; smsSessions.set(from, s);
    return `Calling ${top.name} to book for ${s.dateStr} ${s.timeStr}. I’ll text you the result.`;
  }

  if (s.state === "calling") return "Call in progress. I’ll text you once confirmed.";
  return "Reply NEW to start a booking.";
}

// --- Twilio SMS webhook ---
app.post("/sms", async (req, res) => {
  const twiml = new twilioPkg.twiml.MessagingResponse();
  const from = req.body.From?.trim();
  const body = req.body.Body?.trim();
  const reply = await handleText(from, body);
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

// --- App chat endpoint ---
app.post("/app-chat", async (req, res) => {
  try {
    console.log("POST /app-chat", {
      origin: req.headers.origin,
      ua: req.headers["user-agent"],
      body: req.body
    });
    const { userId, message } = req.body || {};
    if (!userId || !message) {
      return res.status(400).json({ ok: false, error: "userId and message required" });
    }
    const reply = await handleText(`app:${userId}`, message);
    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("Error in /app-chat:", err);
    return res.status(500).json({ ok: false, error: err.message || "server_error" });
  }
});


// --- Twilio /gather endpoint (voice AI call) ---
app.post("/gather", async (req, res) => {
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const transcript = (req.body.SpeechResult || "").trim();
  const lower = transcript.toLowerCase();
  const session = req.session || {};

  // Detect "anytime / walk-in"
  const anyTimeRe = /\b(any\s*time|anytime|come anytime|walk.?in|free all day|no appointment needed)\b/i;
  if (anyTimeRe.test(lower)) {
    const askSlot = `Thank you. Could we put ${session.userRequest?.name || "the patient"} on the schedule at your earliest specific time today or tomorrow morning?`;
    const g = twiml.gather({ input: "speech", action: "/gather", method: "POST" });
    speak(g, askSlot);
    return res.type("text/xml").send(twiml.toString());
  }

  const noTimeInfo = /\b(no specific time|no need|just walk in|come by any time)\b/i;
  if (noTimeInfo.test(lower)) {
    const askBring = `Understood. Is there anything that ${session.userRequest?.name || "the patient"} needs to bring?`;
    const g2 = twiml.gather({ input: "speech", action: "/gather", method: "POST" });
    speak(g2, askBring);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say("Thank you for confirming. Goodbye.");
  res.type("text/xml").send(twiml.toString());
});

// --- Health check ---
app.get("/healthz", (_, res) => res.json({ ok: true, status: "up" }));

// --- Start server ---
app.listen(PORT, () => console.log(`🚀 ${BRAND_NAME} listening on ${PORT}`));
