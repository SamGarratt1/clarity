// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- ENV ----------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY,
  PORT = 3000,
  BRAND_NAME = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant',
  TTS_VOICE = 'Polly.Joanna-Neural'
} = process.env;

// ---------- Clients ----------
const client = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const mapsClient = new GoogleMapsClient({});

// ---------- App ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// (nice to have small root + health)
app.get('/', (_req, res) => res.type('text/plain').send('Clarity backend alive'));
app.get('/healthz', (_req, res) => {
  const checks = {
    env: true,
    twilio: !!TWILIO_ACCOUNT_SID,
    maps: !!GOOGLE_MAPS_API_KEY,
    openai: !!OPENAI_API_KEY
  };
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 500).json({ ok, checks });
});

// ---------- Helpers ----------
function speak(twiml, text) {
  // Formal but warm voice; Polly works on Twilio <Say> when enabled on the account
  twiml.say({ voice: TTS_VOICE }, text);
}

// limits & safety rails
const MAX_CALL_MS   = 3 * 60 * 1000;  // 3 min
const MAX_HOLD_MS   = 90 * 1000;      // 90s on hold

// retry scheduler
const DEFAULT_RETRY_MS = 15 * 60 * 1000; // 15 min
const SHORT_WAIT_MS    = 5  * 60 * 1000; // 5 min

// memory stores
const sessions            = new Map(); // voice sessions (key: CallSid)
const smsSessions         = new Map(); // sms state per patient (key: From)
const lastCallByPatient   = new Map(); // last call details per patient (key: From)
const pendingRetries      = new Map(); // scheduled retry timers (key: From)

// NEW: preferred clinics per patient (key = patient phone)
const preferredClinicsByPatient = new Map();
function getPreferredClinics(patientPhone) {
  return preferredClinicsByPatient.get(patientPhone) || [];
}
function savePreferredClinic(patientPhone, clinic) {
  const list = preferredClinicsByPatient.get(patientPhone) || [];
  const exists = list.find(c =>
    (clinic.phone && c.phone && c.phone.trim() === (clinic.phone || '').trim()) ||
    (clinic.name && c.name && c.name.toLowerCase() === clinic.name.toLowerCase())
  );
  if (!exists) {
    list.push({
      name: (clinic.name || 'My Clinic').trim(),
      phone: (clinic.phone || '').trim(),
      address: (clinic.address || '').trim(),
      notes: (clinic.notes || '').trim()
    });
  }
  preferredClinicsByPatient.set(patientPhone, list);
  return list;
}

// ---------- Validation ----------
const nameLFRe = /^\s*([A-Za-z'.\- ]+)\s*,\s*([A-Za-z'.\- ]+)\s*$/; // "Last, First"
const zipRe    = /^\d{5}$/;
const ynRe     = /^(y|yes|n|no)$/i;
const timeRe   = /^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i;
const dateRe   = /^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/;

const isValidNameLF = s => nameLFRe.test(s||'');
const parseNameLF = s => {
  const m = (s||'').match(nameLFRe); if(!m) return null;
  const last = m[1].trim(), first = m[2].trim();
  return { last, first, full: `${first} ${last}` };
};
const isValidZip  = s => zipRe.test((s||'').trim());
const isValidYN   = s => ynRe.test((s||'').trim());
const ynToBool    = s => /^y/i.test(s||'');
const isValidTime = s => timeRe.test((s||'').trim());
const isValidDate = s => dateRe.test((s||'').trim());

// Bulk intake parser: expects labeled lines in one SMS
// Example:
// Name: Doe, Jane
// Symptoms: sore throat, fever
// ZIP: 30309
// Insurance: Y
// Preferred: 10/05/2025, 10:30 AM
function parseBulkIntake(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const obj = {};
  for (const line of lines) {
    const m = line.match(/^([A-Za-z ]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase().trim();
    const val = m[2].trim();
    if (key.startsWith('name')) obj.name = val;
    else if (key.startsWith('symptom')) obj.symptoms = val;
    else if (key === 'zip' || key === 'zipcode' || key === 'postal') obj.zip = val;
    else if (key.startsWith('insur')) obj.insurance = val;
    else if (key.startsWith('preferred')) obj.preferred = val;
  }
  // validate
  const nameOk = obj.name && isValidNameLF(obj.name);
  const zipOk  = obj.zip && isValidZip(obj.zip);
  const insOk  = obj.insurance && isValidYN(obj.insurance);
  let dateStr = '', timeStr = '';
  if (obj.preferred) {
    const parts = obj.preferred.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      dateStr = parts[0];
      timeStr = parts[1];
    }
  }
  const dateOk = isValidDate(dateStr);
  const timeOk = isValidTime(timeStr);

  if (!nameOk || !zipOk || !insOk || !dateOk || !timeOk || !obj.symptoms) return null;
  const nameParsed = parseNameLF(obj.name);
  return {
    patientName: nameParsed.full,
    firstName: nameParsed.first,
    lastName: nameParsed.last,
    nameLF: obj.name,
    symptoms: obj.symptoms,
    zip: obj.zip,
    insuranceY: ynToBool(obj.insurance),
    dateStr,
    timeStr,
    windowText: `${dateStr} ${timeStr}`
  };
}

// ---------- Maps ----------
function inferSpecialty(symptoms = '') {
  const s = (symptoms || '').toLowerCase();
  if (/skin|rash|acne|mole|dermat/i.test(s)) return 'dermatologist';
  if (/tooth|gum|dent/i.test(s)) return 'dentist';
  if (/eye|vision|ophthalm/i.test(s)) return 'ophthalmologist';
  if (/throat|ear|nose|sinus|ent/i.test(s)) return 'otolaryngologist';
  if (/chest pain|shortness|palpit/i.test(s)) return 'cardiologist';
  if (/stomach|abdomen|nausea|gi/i.test(s)) return 'gastroenterologist';
  if (/bone|joint|fracture|ortho/i.test(s)) return 'orthopedic';
  if (/flu|fever|cough|urgent|injury|stitches/i.test(s)) return 'urgent care';
  return 'clinic';
}

async function findClinics(zip, specialty = 'clinic') {
  try {
    const geoResp = await mapsClient.geocode({
      params: { address: zip, key: GOOGLE_MAPS_API_KEY }
    });
    if (!geoResp.data.results.length) return [];
    const { lat, lng } = geoResp.data.results[0].geometry.location;

    const placesResp = await mapsClient.placesNearby({
      params: {
        location: { lat, lng },
        radius: 8000,
        keyword: specialty,
        type: 'doctor',
        key: GOOGLE_MAPS_API_KEY
      }
    });

    return placesResp.data.results.slice(0, 8).map(p => ({
      name: p.name,
      address: p.vicinity || p.formatted_address || '',
      rating: p.rating || null,
      location: p.geometry?.location,
      phone: null // (MVP) phone requires Place Details; add later if you want
    }));
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

// ---------- GPT ----------
function buildSystemPrompt(userReq) {
  // First/Last format (more natural)
  const nameText = userReq.name || 'John Doe';
  return `
You are a polite, concise patient concierge calling a clinic to book an appointment.
Goal: secure the earliest suitable slot that matches the patient’s preferences.
Rules:
- Do NOT diagnose or offer medical advice.
- Be friendly, clear, and efficient; use concise, professional phrasing.
- Always confirm: patient name, reason, callback, insurance if pressed.
- Confirm: "Great, please confirm: [date/time], provider if available, any prep."
- Before ending, ask: "Is there anything that ${nameText} needs to bring?"
- Then thank and end call.

Patient:
Name: ${nameText}
Reason: ${userReq.reason || 'Check-up'}
Preferred: ${JSON.stringify(userReq.preferredTimes || ['This week'])}
Callback: ${userReq.callback || 'N/A'}
`.trim();
}

async function nextAIUtterance(callSid) {
  const session = sessions.get(callSid);
  const lastTurns = (session?.transcript || []).slice(-3);
  const messages = [
    { role: 'system', content: buildSystemPrompt(session.userRequest) },
    ...lastTurns.map(t => ({ role: t.from === 'ai' ? 'assistant' : 'user', content: t.text }))
  ];
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages
  });
  return (resp.choices?.[0]?.message?.content || '').trim();
}

// ---------- Call helpers / retry ----------
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  const call = await client.calls.create({
    to,
    from: TWILIO_CALLER_ID,
    url: `${PUBLIC_BASE_URL}/voice?sid=${uuidv4()}`,
    statusCallback: `${PUBLIC_BASE_URL}/status`,
    statusCallbackEvent: ['initiated','ringing','answered','completed'],
    statusCallbackMethod: 'POST'
  });

  sessions.set(call.sid, {
    userRequest: { name, reason, preferredTimes, clinicName, callback, clinicPhone: to },
    transcript: [],
    status: 'in_progress',
    confirmed: null,
    awaitingBring: false, // NEW: after time is confirmed, ask what to bring
    turns: 0,
    startedAt: Date.now(),
    onHoldSince: null
  });

  // remember for SMS-driven retry and SAVE CLINIC
  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });

  return call.sid;
}

function scheduleRetry(patientNumber, details, delayMs) {
  const existing = pendingRetries.get(patientNumber);
  if (existing) clearTimeout(existing);

  const timeoutId = setTimeout(async () => {
    pendingRetries.delete(patientNumber);
    try {
      await startClinicCall(details);
      await client.messages.create({
        to: details.callback,
        from: TWILIO_CALLER_ID,
        body: `Retrying your booking with ${details.clinicName} now. I’ll text the result.`
      });
    } catch (e) {
      console.error('Scheduled retry failed:', e.message);
      try {
        await client.messages.create({
          to: details.callback,
          from: TWILIO_CALLER_ID,
          body: `Couldn’t retry the call just now. Reply RETRY to try again.`
        });
      } catch {}
    }
  }, delayMs);

  pendingRetries.set(patientNumber, timeoutId);
}

function cancelRetry(patientNumber) {
  const t = pendingRetries.get(patientNumber);
  if (t) {
    clearTimeout(t);
    pendingRetries.delete(patientNumber);
    return true;
  }
  return false;
}

// ---------- Routes ----------

// Register/append a preferred clinic (for app/website onboarding)
app.post('/profile/clinic', (req, res) => {
  try {
    const { patientPhone, name, phone, address = '', notes = '' } = req.body || {};
    if (!patientPhone || !name || !phone) {
      return res.status(400).json({ ok:false, error:'patientPhone, name, phone required' });
    }
    const out = savePreferredClinic(patientPhone, { name, phone, address, notes });
    return res.json({ ok:true, clinics: out });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// Start call (manual/programmatic)
app.post('/call', async (req, res) => {
  // helpful debug:
  console.log('POST /call body:', req.body);

  const userRequest = {
    name: req.body.name,
    reason: req.body.reason,
    preferredTimes: Array.isArray(req.body.preferredTimes)
      ? req.body.preferredTimes
      : (typeof req.body.preferredTimes === 'string'
          ? (() => { try { return JSON.parse(req.body.preferredTimes); } catch { return [req.body.preferredTimes]; } })()
          : []),
    clinicName: req.body.clinicName || '',
    callback: req.body.callback || '',
    clinicPhone: req.body.clinicPhone || req.body.to
  };

  try {
    if (!userRequest.clinicPhone) throw new Error('Required parameter "params[\'to\']" missing.');
    const callSid = await startClinicCall({
      to: userRequest.clinicPhone,
      name: userRequest.name,
      reason: userRequest.reason,
      preferredTimes: userRequest.preferredTimes,
      clinicName: userRequest.clinicName,
      callback: userRequest.callback
    });
    return res.json({ ok: true, callSid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// First voice response
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new twilioPkg.twiml.VoiceResponse();

  const session = sessions.get(callSid);
  if (!session) {
    speak(twiml, 'I lost the call context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const firstLine =
    `Hello, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. ` +
    `I’m calling to book an appointment for ${session.userRequest.name}. ` +
    `${session.userRequest.reason ? 'Reason: ' + session.userRequest.reason + '. ' : ''}` +
    `Do you have availability ${session.userRequest.preferredTimes?.[0] || 'this week'}?`;

  session.transcript.push({ from: 'ai', text: firstLine });

  speak(twiml, firstLine);
  const gather = twiml.gather({
    input: 'speech',
    action: '/gather',
    method: 'POST',
    speechTimeout: 'auto'
  });
  speak(gather, 'I can wait for your available times.');

  res.type('text/xml').send(twiml.toString());
});

// Handle receptionist speech
app.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const session = sessions.get(callSid);

  if (!session) {
    speak(twiml, 'I lost the call context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // total call cap
  const elapsedMs = Date.now() - (session.startedAt || Date.now());
  if (elapsedMs > MAX_CALL_MS) {
    speak(twiml, "I have to wrap here. We'll follow up by text. Thank you.");
    twiml.hangup();
    try {
      await client.messages.create({
        to: session.userRequest.callback,
        from: TWILIO_CALLER_ID,
        body: `Clinic line busy/long. Reply RETRY for another attempt, WAIT 5 / WAIT 15 to schedule, or CANCEL.`
      });
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  if (speech) session.transcript.push({ from: 'rx', text: speech });
  const lower = speech.toLowerCase();

  // hold detection
  if (/\b(please hold|hold on|one moment|just a moment|put you on hold|one sec|minute)\b/i.test(lower)) {
    if (!session.onHoldSince) session.onHoldSince = Date.now();
    if (Date.now() - session.onHoldSince > MAX_HOLD_MS) {
      speak(twiml, "I’ll follow up later. Thank you.");
      twiml.hangup();
      try {
        const details = {
          to: session.userRequest.clinicPhone,
          name: session.userRequest.name,
          reason: session.userRequest.reason,
          preferredTimes: session.userRequest.preferredTimes,
          clinicName: session.userRequest.clinicName,
          callback: session.userRequest.callback
        };
        await client.messages.create({
          to: session.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `Clinic kept us on hold too long. Reply NOW/RETRY to call again, or WAIT 5 / WAIT 15 / CANCEL.`
        });
        scheduleRetry(session.userRequest.callback, details, DEFAULT_RETRY_MS);
      } catch {}
      return res.type('text/xml').send(twiml.toString());
    }
    speak(twiml, "Certainly, I can hold.");
    twiml.pause({ length: 15 });
    const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    speak(g, "I’m still here.");
    return res.type('text/xml').send(twiml.toString());
  } else if (session.onHoldSince) {
    session.onHoldSince = null;
  }

  // path: if we just asked “what to bring”, capture that now
  if (session.awaitingBring) {
    const bringText = speech || 'No special items';
    session.confirmed = session.confirmed || {};
    session.confirmed.bring = bringText;
    const thanks = `Perfect. Thank you very much. We’ll note it for the patient ${session.userRequest.name}. Have a wonderful day.`;
    session.status = 'confirmed';
    session.transcript.push({ from: 'ai', text: thanks });
    speak(twiml, thanks);
    twiml.hangup();
    // SMS patient with full confirmation
    try {
      const clinicName = session.userRequest.clinicName || 'the clinic';
      const when = session.confirmed.time || '(time pending)';
      const bring = session.confirmed.bring ? `\nBring: ${session.confirmed.bring}` : '';
      await client.messages.create({
        to: session.userRequest.callback,
        from: TWILIO_CALLER_ID,
        body: `✅ Confirmed: ${when} at ${clinicName}.${bring}\nReply SAVE CLINIC to remember this clinic for next time.`
      });
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  // basic intent
  let intent = 'other';
  if (/\b(yes|yeah|yep|works|okay|ok|sure|that[’']?s fine|perfect|sounds good)\b/i.test(lower)) intent = 'yes';
  else if (/\b(no|nope|not available|can[’']?t|unavailable)\b/i.test(lower)) intent = 'no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next)\b/i.test(lower)
        || /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/i.test(lower)
        || /\b(morning|afternoon|evening|noon|midday)\b/i.test(lower)) intent = 'time';

  if (intent === 'time') {
    const parsedDate = chrono.parseDate(speech, new Date());
    const cleanTime = parsedDate
      ? parsedDate.toLocaleString('en-US',
