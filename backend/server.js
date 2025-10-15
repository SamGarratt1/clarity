import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import twilioPkg from 'twilio';
import cors from 'cors';

const app = express();                         // ← create the app FIRST
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(cors({
  origin: (origin, cb) => {
    const allow = !origin
      || origin === 'https://clarity-frontend-three.vercel.app'
      || /\.vercel\.app$/.test(origin)
      || origin === 'http://localhost:5500';
    cb(allow ? null : new Error('CORS blocked for ' + origin), allow);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.options('*', cors());

// ----- Env / Clients -----
const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TEST_CLINIC_PHONE
} = process.env;

const twilio = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ----- In-memory stores -----
const smsSessions = new Map();            // key: user (phone or app:userId)
const lastCallByPatient = new Map();      // key: callback number
const preferredClinicsByPatient = new Map(); // key: user

// ----- Helpers -----
const isValidZip = s => /^\d{5}$/.test((s||'').trim());
const isValidYN = s => /^(y|n)$/i.test((s||'').trim());
const ynToBool = s => /^y/i.test(s||'');
const isValidDate = s => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test((s||'').trim());
const isValidTime = s => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test((s||'').trim());
const splitFirstLast = s => {
  const parts = (s||'').trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };
};

const inferSpecialty = (symptom='') => {
  const s = symptom.toLowerCase();
  if (/skin|rash|acne/.test(s)) return 'dermatology';
  if (/ear|nose|throat|sinus/.test(s)) return 'ENT';
  if (/eye|vision/.test(s)) return 'optometry';
  if (/urgent|fever|cough|injury/.test(s)) return 'urgent care';
  return 'primary care';
};

const nextIntakePrompt = (s) => {
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
};

const savePreferredClinic = (from, clinic) => {
  if (!preferredClinicsByPatient.has(from)) preferredClinicsByPatient.set(from, []);
  preferredClinicsByPatient.get(from).push(clinic);
};
const getPreferredClinics = (from) => preferredClinicsByPatient.get(from) || [];

async function findClinics(zip, specialty='clinic') {
  // MVP placeholder — you can hook Google Places here.
  return [
    { name: `${specialty} Clinic near ${zip}`, phone: TEST_CLINIC_PHONE || TWILIO_PHONE_NUMBER, address: '123 Main St' }
  ];
}

async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  if (!to) throw new Error('Missing clinic phone.');
  const twiml = new twilioPkg.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Amy' }, `Hello. This is Clarity Health Concierge calling to schedule for ${name}. Reason: ${reason}.`);
  const call = await twilio.calls.create({
    to,
    from: TWILIO_PHONE_NUMBER,
    twiml: twiml.toString()
  });
  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}

function speak(twiml, text) { twiml.say({ voice: 'Polly.Amy' }, text); }

// ----- Shared conversational engine (SMS + App) -----
async function handleText(from, rawBody) {
  const body = (rawBody || '').trim();
  const lower = body.toLowerCase();

  // Basic commands
  if (/^(help)$/i.test(lower)) return 'Clarity: transactional appointment scheduling. Reply NEW to start, STOP to opt out.';
  if (/^(stop|end|unsubscribe|quit|cancel)$/i.test(lower)) { smsSessions.delete(from); return 'You are opted out for this conversation.'; }

  let s = smsSessions.get(from);

  // NEW or first message starts intake
  if (!s || /\b(new|restart|reset)\b/.test(lower)) {
    s = {
      state: 'intake_name',
      firstName: '', lastName: '', patientName: '',
      symptoms: '', zip: '', insuranceY: null,
      dateStr: '', timeStr: '', specialty: ''
    };
    smsSessions.set(from, s);
    return `Welcome to Clarity — AI appointment assistant.\n${nextIntakePrompt(s)}`;
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
  }

  if (s.state === 'calling') return 'Working on it — I’ll update you once confirmed.';
  return 'Reply NEW to begin.';
}

// ----- SMS webhook -----
app.post('/sms', async (req, res) => {
  const MessagingResponse = twilioPkg.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim();
  const reply = await handleText(from, body);
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ----- In-app chat endpoint -----
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

// ----- Optional: simple gather with “anytime / walk-in” guard -----
app.post('/gather', async (req, res) => {
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || '').trim();
  const lower = speech.toLowerCase();

  const anyTimeRe = /\b(any\s*time|anytime|come anytime|walk[\s-]?in|free all day|no appointment needed)\b/i;
  if (anyTimeRe.test(lower)) {
    const ask = `Thanks. Could we put the patient on the schedule at your earliest specific time today or tomorrow morning?`;
    const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST' });
    speak(g, ask);
    return res.type('text/xml').send(twiml.toString());
  }
  const noTimeInfo = /\b(no specific time|just walk in|come by any time)\b/i;
  if (noTimeInfo.test(lower)) {
    speak(twiml, 'Understood. We will note this as a walk-in during business hours. Is there anything the patient should bring?');
    const g2 = twiml.gather({ input: 'speech', action: '/gather', method: 'POST' });
    return res.type('text/xml').send(twiml.toString());
  }
  speak(twiml, 'Thank you. Goodbye.');
  res.type('text/xml').send(twiml.toString());
});

// ----- Health check -----
app.get('/healthz', (_req, res) => res.json({ ok:true }));

// ----- Start -----
app.listen(PORT, () => console.log(`🚀 Clarity backend listening on ${PORT}`));
