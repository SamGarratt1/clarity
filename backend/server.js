// -------------------- Imports --------------------
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import twilioPkg from 'twilio';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

// -------------------- App setup --------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Parsers first
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Minimal CORS (no 'cors' package required)
app.use((req, res, next) => {
  // If you want to restrict, replace * with your Vercel origin
  // res.header('Access-Control-Allow-Origin', 'https://YOUR-VERCEL-DOMAIN.vercel.app');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Light request log (skip health)
app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    console.log(new Date().toISOString(), req.method, req.path);
  }
  next();
});

// -------------------- Env / Clients --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,          // your TFN/verified From
  TEST_CLINIC_PHONE,            // optional override for demo calling
  GOOGLE_MAPS_API_KEY,          // optional; if present we use Places
  BRAND_NAME  = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant'
} = process.env;

const twilio =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const maps =
  GOOGLE_MAPS_API_KEY
    ? new GoogleMapsClient({})
    : null;

// -------------------- In-memory state --------------------
const smsSessions = new Map();               // key: userId (phone or app:<id>)
const lastCallByPatient = new Map();         // key: callback number
const preferredClinicsByPatient = new Map(); // key: userId -> [{name,phone,address}]

// -------------------- Utilities --------------------
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
// ---- phone helpers (add under other helpers) ----
const phoneRe = /^\+1\d{10}$|^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/;
const cleanUSPhone = s => {
  if (!s) return null;
  const digits = (s.replace(/[^\d]/g, '') || '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
};


function nextIntakePrompt(s) {
  switch (s.state) {
    case 'intake_name':
      return 'Great — whose appointment is this for? Please share the full name like "Jane Doe".';
    case 'intake_symptoms':
      return 'Thanks, Jane. In one or two lines, what’s going on? (e.g., “sore throat and fever” or “ankle pain”).';
    case 'intake_zip':
      return 'What ZIP code should I search near? (5 digits)';
    case 'intake_ins':
      return 'Do you have insurance I should mention if asked? Reply Y or N.';
    case 'intake_date':
      return 'What day works best? (MM/DD/YYYY)';
    case 'intake_time':
      return 'Any time preference? Share a time like “10:30 AM”.';
    case 'confirm_intake':
      return `Let me make sure I’ve got it right:\n• Name: ${s.patientName}\n• Reason: ${s.symptoms}\n• Area: ${s.zip}\n• When: ${s.dateStr} at ${s.timeStr}\n\nIf that looks good, reply YES and I’ll start calling.`;
    default:
      return 'Reply NEW to start over.';
  }
}


// Preferred clinic helpers (for future onboarding / “use my clinic”)
function savePreferredClinic(userId, clinic) {
  if (!preferredClinicsByPatient.has(userId)) preferredClinicsByPatient.set(userId, []);
  preferredClinicsByPatient.get(userId).push(clinic);
}
const getPreferredClinics = (userId) => preferredClinicsByPatient.get(userId) || [];

// -------------------- Clinic search --------------------
/**
 * Try Google Maps Places if GOOGLE_MAPS_API_KEY is provided.
 * Otherwise return a single safe placeholder with a guaranteed phone number.
 */
async function findClinics(zip, specialty='clinic') {
  const FALLBACK_PHONE =
    TEST_CLINIC_PHONE || TWILIO_PHONE_NUMBER || '+18337224939'; // your TFN as safe demo value

  if (!zip || !isValidZip(zip)) {
    return [{ name: `${specialty} clinic`, phone: FALLBACK_PHONE, address: 'Near you' }];
  }

  // If Google Places available, do a quick nearby search
  if (maps && GOOGLE_MAPS_API_KEY) {
    try {
      // Geocode ZIP -> lat/lng
      const geo = await maps.geocode({
        params: { address: zip, key: GOOGLE_MAPS_API_KEY }
      });
      if (!geo.data.results?.length) throw new Error('No geocode results');
      const loc = geo.data.results[0].geometry.location;

      // Nearby Search — using keyword so we can pass specialty text
      const places = await maps.placesNearby({
        params: {
          location: loc,
          radius: 8000,
          keyword: specialty,
          type: 'doctor',
          key: GOOGLE_MAPS_API_KEY
        }
      });

      const items = places.data.results?.slice(0, 5) || [];
      // NOTE: Places Nearby doesn’t include phone. For full phone you’d call Place Details.
      // For now we attach FALLBACK_PHONE so the downstream call logic always has a number.
      if (items.length) {
        return items.map(p => ({
          name: p.name,
          address: p.vicinity || p.formatted_address || 'Address not provided',
          phone: FALLBACK_PHONE
        }));
      }
    } catch (err) {
      console.warn('Maps lookup failed, using fallback:', err.message);
    }
  }

  // Fallback – always return at least one clinic with a phone number
  return [{
    name: `${specialty} clinic near ${zip}`,
    phone: FALLBACK_PHONE,
    address: '123 Main St'
  }];
}

// -------------------- Optional call placement --------------------
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  if (!twilio) throw new Error('Twilio not configured');
  if (!to) throw new Error('Missing clinic phone');

  const twiml = new twilioPkg.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Amy' },
    `Hello. This is ${BRAND_NAME} calling to schedule for ${name}. Reason: ${reason}.`);

  const call = await twilio.calls.create({
    to,
    from: TWILIO_PHONE_NUMBER,
    twiml: twiml.toString()
  });

  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}

// -------------------- Triage / state machine --------------------
async function handleText(from, rawBody) {
  const body  = (rawBody || '').trim();
  const lower = body.toLowerCase();

  // Simple commands
  if (/^(help)$/i.test(lower)) return `${BRAND_NAME}: transactional scheduling. Reply NEW to start.`;
  if (/^(stop|end|unsubscribe|quit|cancel)$/i.test(lower)) {
    smsSessions.delete(from);
    return 'You are opted out for this conversation.';
  }

  let s = smsSessions.get(from);

  // New / restart
  // New / restart
  if (!s || /\b(new|restart|reset)\b/.test(lower)) {
    s = {
      state: 'intake_name',
      firstName: '', lastName: '', patientName: '',
      symptoms: '', zip: '', insuranceY: null,
      dateStr: '', timeStr: '', specialty: ''
    };
    smsSessions.set(from, s);
    return `Hi! I’m your Clarity assistant. I’ll ask a couple quick questions, then call the clinic and book the earliest slot for you.\n\nWhat is the patient’s full name? (First Last)`;
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

  // Confirm and place/simulate call
  if (s.state === 'confirm_intake') {
    if (!/^yes\b/i.test(body)) return 'Please reply YES to continue.';
    const clinics = await findClinics(s.zip, s.specialty);
    const top = clinics[0];
    if (!top) return `No clinics found near ${s.zip}. Reply RESET to try again.`;

    const canPlaceCall = Boolean(twilio && top.phone);
    if (!canPlaceCall) {
      s.state = 'done'; smsSessions.set(from, s);
      return `✅ Tentative booking placed with ${top.name} for ${s.dateStr} ${s.timeStr}. ` +
             `We’ll confirm by text shortly. (No live call placed in this environment.)`;
    }

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
  if (s.state === 'done') return 'All set. Reply NEW to book another appointment.';
  return 'Reply NEW to begin.';
}

// -------------------- Routes --------------------
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Web chat endpoint
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

// Twilio SMS webhook (optional)
app.post('/sms', async (req, res) => {
  const MessagingResponse = twilioPkg.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim();
  const reply = await handleText(from, body);
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`🚀 ${BRAND_NAME} listening on ${PORT}`);
});

// Simple anti-spam (30 requests/min per IP)
const rateLimit = {};
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  rateLimit[ip] = rateLimit[ip] || [];
  rateLimit[ip] = rateLimit[ip].filter(ts => now - ts < 60_000);
  if (rateLimit[ip].length > 30)
    return res.status(429).send('Too many requests, slow down.');
  rateLimit[ip].push(now);
  next();
});
