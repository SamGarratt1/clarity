// -------------------- Imports --------------------
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import twilioPkg from 'twilio'; // ok if not used; safe to keep

// -------------------- App setup --------------------
const app = express();                                // MUST come first
const PORT = process.env.PORT || 3000;

// Body parsers (must be before routes)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Minimal CORS (no extra package needed)
app.use((req, res, next) => {
  // If you want to restrict: replace * with your Vercel origin
  // res.header('Access-Control-Allow-Origin', 'https://clarity-frontend-three.vercel.app');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Optional request log while debugging
app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

// -------------------- Env / Clients --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TEST_CLINIC_PHONE,          // use this for test calls if you like
  BRAND_NAME = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant'
} = process.env;

const twilio = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null; // null if creds not set – web chat does not need Twilio

// -------------------- In-memory stores --------------------
const smsSessions = new Map();               // key: userId (phone or app:<id>)
const lastCallByPatient = new Map();         // key: callback number
const preferredClinicsByPatient = new Map(); // key: userId

// -------------------- Helpers --------------------
const isValidZip  = s => /^\d{5}$/.test((s||'').trim());
const isValidYN   = s => /^(y|n)$/i.test((s||'').trim());
const ynToBool    = s => /^y/i.test(s||'');
const isValidDate = s => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test((s||'').trim());
const isValidTime = s => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test((s||'').trim());

function splitFirstLast(s) {
  const parts = (s||'').trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function inferSpecialty(symptom='') {
  const s = symptom.toLowerCase();
  if (/skin|rash|acne/.test(s)) return 'dermatology';
  if (/ear|nose|throat|sinus/.test(s)) return 'ENT';
  if (/eye|vision/.test(s)) return 'optometry';
  if (/urgent|fever|cough|injury/.test(s)) return 'urgent care';
  return 'primary care';
}

function nextIntakePrompt(s) {
  switch (s.state) {
    case 'intake_name': return 'What is the patient’s full name? (First Last)';
    case 'intake_symptoms': return 'What’s the reason for the visit? (brief)';
    case 'intake_zip': return 'What ZIP code should I search near? (5 digits)';
    case 'intake_ins': return 'Do you have insurance? (Y/N)';
    case 'intake_date': return 'What date works best? (MM/DD/YYYY)';
    case 'intake_time': return 'Preferred time? (e.g., 10:30 AM)';
    case 'confirm_intake':
      return `Confirm: ${s.patientName} — "${s.symptoms}" near ${s.zip} on ${s.dateStr} at ${s.timeStr}. Reply YES to continue.`;
    default: return 'Reply NEW to start over.';
  }
}

// Save/recall preferred clinics (optional feature)
function savePreferredClinic(from, clinic) {
  if (!preferredClinicsByPatient.has(from)) preferredClinicsByPatient.set(from, []);
  preferredClinicsByPatient.get(from).push(clinic);
}
const getPreferredClinics = (from) => preferredClinicsByPatient.get(from) || [];

// Simple placeholder for clinic search (swap with Google Places later)
async function findClinics(zip, specialty='clinic') {
  return [
    { name: `${specialty} Clinic near ${zip}`, phone: TEST_CLINIC_PHONE || TWILIO_PHONE_NUMBER, address: '123 Main St' }
  ];
}

// Optional voice call starter – not used by web chat
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  if (!twilio) throw new Error('Twilio not configured.');
  if (!to) throw new Error('Missing clinic phone.');
  const twiml = new twilioPkg.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Amy' }, `Hello. This is ${BRAND_NAME} calling to schedule for ${name}. Reason: ${reason}.`);
  const call = await twilio.calls.create({
    to,
    from: TWILIO_PHONE_NUMBER,
    twiml: twiml.toString()
  });
  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}

// -------------------- Shared triage engine (SMS + Web) --------------------
async function handleText(from, rawBody) {
  const body  = (rawBody || '').trim();
  const lower = body.toLowerCase();

  // simple commands
  if (/^(help)$/i.test(lower)) return `${BRAND_NAME}: transactional scheduling. Reply NEW to start.`;
  if (/^(stop|end|unsubscribe|quit|cancel)$/i.test(lower)) {
    smsSessions.delete(from);
    return 'You are opted out for this conversation.';
  }

  let s = smsSessions.get(from);

  // Start NEW / first message
  if (!s || /\b(new|restart|reset)\b/.test(lower)) {
    s = {
      state: 'intake_name',
      firstName: '', lastName: '', patientName: '',
      symptoms: '', zip: '', insuranceY: null,
      dateStr: '', timeStr: '', specialty: ''
    };
    smsSessions.set(from, s);
    return `Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}.\n${nextIntakePrompt(s)}`;
  }

  // Intake steps
  if (s.state === 'intake_name') {
    const fl = splitFirstLast(body);
    if (!fl) return 'Please enter first and last name (e.g., Jane Doe).';
    s.firstName = fl.first; s.lastName = fl.last; s.patientName = `${fl.first} ${fl.last}`;
    s.state = 'intake_symptoms'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'intake_symptoms') {
    s.symptoms = body; s.specialty = inferSpecialty(body);
    s.state = 'intake_zip'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'intake_zip') {
    if (!isValidZip(body)) return 'ZIP should be 5 digits.';
    s.zip = body; s.state = 'intake_ins'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'intake_ins') {
    if (!isValidYN(body)) return 'Reply Y or N.';
    s.insuranceY = ynToBool(body); s.state = 'intake_date'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'intake_date') {
    if (!isValidDate(body)) return 'Use MM/DD/YYYY.';
    s.dateStr = body; s.state = 'intake_time'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'intake_time') {
    if (!isValidTime(body)) return 'Use a time like 10:30 AM.';
    s.timeStr = body; s.state = 'confirm_intake'; smsSessions.set(from, s);
    return nextIntakePrompt(s);
  }
  if (s.state === 'confirm_intake') {
    if (!/^yes\b/i.test(body)) return 'Please reply YES to continue.';
    const clinics = await findClinics(s.zip, s.specialty);
    const top = clinics[0];
    if (!top) return `No clinics found near ${s.zip}. Reply RESET to try again.`;

    // If Twilio is configured, place a call; otherwise just "pretend confirm" for web demo
    if (twilio) {
      await startClinicCall({
        to: top.phone,
        name: s.patientName,
        reason: s.symptoms,
        preferredTimes: [`${s.dateStr} ${s.timeStr}`],
        clinicName: top.name,
        callback: from
      });
      s.state = 'calling'; smsSessions.set(from, s);
      return `Calling ${top.name} to book for ${s.dateStr} ${s.timeStr}. I’ll message you the result.`;
    } else {
      // Demo path if Twilio not set: pretend we confirmed
      s.state = 'done'; smsSessions.set(from, s);
      return `✅ Tentative booking placed with ${top.name} for ${s.dateStr} ${s.timeStr}. (Twilio not configured on server, so this is a demo confirmation.)`;
    }
  }

  if (s.state === 'calling') return 'Working on it — I’ll update you once confirmed.';
  if (s.state === 'done') return 'All set. Reply NEW to book another appointment.';
  return 'Reply NEW to begin.';
}

// -------------------- Routes --------------------
// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Web app chat (the website uses this)
app.post('/app-chat', async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    if (!userId || !message) return res.status(400).json({ ok:false, error:'userId and message required' });
    const reply = await handleText(`app:${userId}`, message);
    return res.json({ ok:true, reply });
  } catch (e) {
    console.error('Error in /app-chat:', e);
    return res.status(500).json({ ok:false, error:e.message || 'server_error' });
  }
});

// SMS webhook (optional; requires Twilio to be configured)
app.post('/sms', async (req, res) => {
  const MessagingResponse = twilioPkg.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim();
  const reply = await handleText(from, body);
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`🚀 ${BRAND_NAME} listening on ${PORT}`);
});
