// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import cors from 'cors';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

// ---------- ENV ----------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY,
  PORT = 10000,
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

// allow your vercel frontend
app.use(cors({
  origin: [
    /\.vercel\.app$/,
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  credentials: false
}));

// ---------- Simple health ----------
app.get('/healthz', (req, res) => res.json({ ok: true, brand: BRAND_NAME }));

// ---------- Helpers ----------
function speak(twiml, text) {
  twiml.say({ voice: TTS_VOICE }, text);
}

// limits & safety rails
const MAX_CALL_MS   = 3 * 60 * 1000;
const MAX_HOLD_MS   = 90 * 1000;

// retry scheduler
const DEFAULT_RETRY_MS = 15 * 60 * 1000;
const SHORT_WAIT_MS    = 5  * 60 * 1000;

// memory stores
const sessionsVoice       = new Map(); // key: CallSid → voice call session
const smsSessions         = new Map(); // key: From (phone) → sms intake session
const lastCallByPatient   = new Map(); // key: From → last call details
const pendingRetries      = new Map(); // key: From → timer
const sessionsChat        = new Map(); // key: userId → web chat session
const userUsualClinics    = new Map(); // key: userId → {name, phone, address} (optional)

// ---------- Validation ----------
const nameLFRe = /^\s*([A-Za-z'.\- ]+)\s*,\s*([A-Za-z'.\- ]+)\s*$/; // "Last, First"
const nameStdRe = /^\s*([A-Za-z'.\- ]+)\s+([A-Za-z'.\- ]+)\s*$/;    // "First Last"
const zipRe    = /^\d{5}$/;
const ynRe     = /^(y|yes|n|no)$/i;
const timeRe   = /^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i;
const dateRe   = /^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/;

const isValidZip  = s => zipRe.test((s||'').trim());
const isValidYN   = s => ynRe.test((s||'').trim());
const ynToBool    = s => /^y/i.test(s||'');
const isValidTime = s => timeRe.test((s||'').trim());
const isValidDate = s => dateRe.test((s||'').trim());
const parseNameFirstLast = s => {
  const m = (s||'').match(nameStdRe); if(!m) return null;
  return { first: m[1].trim(), last: m[2].trim(), full: `${m[1].trim()} ${m[2].trim()}` };
};
const parseNameLastFirst = s => {
  const m = (s||'').match(nameLFRe); if(!m) return null;
  return { last: m[1].trim(), first: m[2].trim(), full: `${m[2].trim()} ${m[1].trim()}` };
};

// phone helpers
const phoneRe = /^\+1\d{10}$|^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/;
const cleanUSPhone = s => {
  if (!s) return null;
  const digits = (s.replace(/[^\d]/g, '') || '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
};

// ---------- Maps ----------
function inferSpecialty(symptoms = '') {
  const s = symptoms.toLowerCase();
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

// Fetch clinics near ZIP, then get phone via Place Details
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

    const basics = (placesResp.data.results || []).slice(0, 6).map(p => ({
      place_id: p.place_id,
      name: p.name,
      address: p.vicinity || p.formatted_address || '',
      rating: p.rating || null,
      location: p.geometry?.location,
    }));

    const detailed = [];
    for (const b of basics) {
      try {
        const details = await mapsClient.placeDetails({
          params: {
            place_id: b.place_id,
            fields: [
              'name',
              'formatted_phone_number',
              'international_phone_number',
              'formatted_address',
              'website',
              'opening_hours'
            ],
            key: GOOGLE_MAPS_API_KEY
          }
        });
        const d = details.data.result || {};
        detailed.push({
          name: d.name || b.name,
          address: d.formatted_address || b.address || '',
          rating: b.rating,
          location: b.location,
          phone: d.international_phone_number || d.formatted_phone_number || null,
          website: d.website || null,
          hours: d.opening_hours?.weekday_text || null
        });
      } catch {
        detailed.push({ ...b, phone: null });
      }
    }
    return detailed;
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

// ---------- GPT for voice fallback ----------
function buildSystemPrompt(userReq) {
  return `
You are a polite, concise patient concierge calling a clinic to book an appointment.
Goal: secure the earliest suitable slot that matches the patient’s preferences.
Rules:
- Do NOT diagnose or offer medical advice.
- Be friendly, clear, and efficient.
- Always confirm: patient name, reason, callback, insurance if pressed.
- Confirm: "Great, please confirm: [date/time], provider if available, any prep."
- Then thank and end call.

Patient:
Name: ${userReq.name || 'John Doe'}
Reason: ${userReq.reason || 'Check-up'}
Preferred: ${JSON.stringify(userReq.preferredTimes || ['This week'])}
Callback: ${userReq.callback || 'N/A'}
`.trim();
}

async function nextAIUtterance(callSid) {
  const session = sessionsVoice.get(callSid);
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
  return resp.choices[0].message.content.trim();
}

// ---------- Call helpers / retry ----------
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  if (!to) throw new Error('Required parameter "params[\'to\']" missing.');
  const call = await client.calls.create({
    to,
    from: TWILIO_CALLER_ID,
    url: `${PUBLIC_BASE_URL}/voice?sid=${uuidv4()}`,
    statusCallback: `${PUBLIC_BASE_URL}/status`,
    statusCallbackEvent: ['initiated','ringing','answered','completed'],
    statusCallbackMethod: 'POST'
  });

  sessionsVoice.set(call.sid, {
    userRequest: { name, reason, preferredTimes, clinicName, callback, clinicPhone: to },
    transcript: [],
    status: 'in_progress',
    confirmed: null,
    startedAt: Date.now(),
    onHoldSince: null
  });

  // remember for SMS-driven retry
  if (callback) {
    lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  }
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

// ---------- Web chat booking helper ----------
async function proceedToBooking(s) {
  const when = `${s.dateStr || ''} ${s.timeStr || ''}`.trim();
  const clinic = s.chosenClinic;

  if (!clinic) {
    s.state = 'intake_zip';
    return "I couldn't find a clinic yet. What ZIP should I search near?";
  }

  if (!clinic.phone) {
    s.state = 'select_clinic';
    return `I found ${clinic.name}, but couldn't retrieve a phone number to call. Try NEXT for another clinic, or type HOME to restart.`;
  }

  if (s.userPhone) {
    try {
      await startClinicCall({
        to: clinic.phone,
        name: s.patientName || 'Patient',
        reason: s.symptoms || 'Visit',
        preferredTimes: [when || 'This week'],
        clinicName: clinic.name,
        callback: s.userPhone,
      });
      s.state = 'calling';
      return `Calling ${clinic.name} now to book ${when || 'the earliest time'}. I’ll text you at ${s.userPhone} with the result.`;
    } catch (e) {
      return `Couldn't place the call just now (${e.message}). Type YES to retry or HOME to restart.`;
    }
  }

  s.state = 'await_phone';
  return "To place the call and text your confirmation, what's the best phone number for updates? (e.g., 555-123-4567)";
}

// ---------- Routes ----------

// manual start call (debug)
app.post('/call', async (req, res) => {
  const userRequest = {
    name: req.body.name,
    reason: req.body.reason,
    preferredTimes: req.body.preferredTimes || [],
    clinicName: req.body.clinicName || '',
    callback: req.body.callback || '',
    clinicPhone: req.body.clinicPhone || req.body.to
  };
  try {
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

// ---------- Voice: first response ----------
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new twilioPkg.twiml.VoiceResponse();

  const session = sessionsVoice.get(callSid);
  if (!session) {
    speak(twiml, 'I lost the call context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const nameToSay = session.userRequest?.name || 'the patient';

  const firstLine =
    `Hi, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. ` +
    `I'm calling to book an appointment for ${nameToSay}. ` +
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

// ---------- Voice: handle receptionist speech ----------
app.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const session = sessionsVoice.get(callSid);

  if (!session) {
    speak(twiml, 'I lost the call context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // total call cap
  const elapsedMs = Date.now() - (session.startedAt || Date.now());
  if (elapsedMs > MAX_CALL_MS) {
    speak(twiml, "I have to wrap here. We'll follow up by text. Thank you!");
    twiml.hangup();
    try {
      if (session.userRequest.callback) {
        await client.messages.create({
          to: session.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `Clinic line busy/long. Reply RETRY for another attempt, WAIT 5 / WAIT 15 to schedule, or CANCEL.`
        });
      }
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  if (speech) session.transcript.push({ from: 'rx', text: speech });

  const lower = speech.toLowerCase();
  let intent = 'other';
  if (/\b(yes|yeah|yep|works|okay|ok|sure|that[’']s fine|perfect|sounds good)\b/i.test(lower)) intent = 'yes';
  else if (/\b(no|nope|not available|can[’']t|can’t|unavailable)\b/i.test(lower)) intent = 'no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next)\b/i.test(lower)
        || /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/i.test(lower)
        || /\b(morning|afternoon|evening|noon|midday)\b/i.test(lower)) intent = 'time';

  // hold detection
  if (/\b(please hold|hold on|one moment|just a moment|put you on hold|one sec|minute)\b/i.test(lower)) {
    if (!session.onHoldSince) session.onHoldSince = Date.now();
    if (Date.now() - session.onHoldSince > MAX_HOLD_MS) {
      speak(twiml, "I’ll follow up later. Thank you!");
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
        if (session.userRequest.callback) {
          await client.messages.create({
            to: session.userRequest.callback,
            from: TWILIO_CALLER_ID,
            body: `Clinic kept us on hold too long. Reply NOW/RETRY to call again, or WAIT 5 / WAIT 15 / CANCEL.`
          });
          scheduleRetry(session.userRequest.callback, details, DEFAULT_RETRY_MS);
        }
      } catch {}
      return res.type('text/xml').send(twiml.toString());
    }
    speak(twiml, "Sure, I can hold.");
    twiml.pause({ length: 15 });
    const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    speak(g, "I’m still here.");
    return res.type('text/xml').send(twiml.toString());
  } else if (session.onHoldSince) {
    session.onHoldSince = null;
  }

  if (intent === 'time') {
    const parsedDate = chrono.parseDate(speech, new Date());
    const cleanTime = parsedDate
      ? parsedDate.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : speech;
    session.confirmed = { time: cleanTime };
    const confirmLine = `Great, I have you down for ${cleanTime} for patient ${session.userRequest.name}. Can you confirm? Also, is there anything ${session.userRequest.name} needs to bring?`;
    session.transcript.push({ from: 'ai', text: confirmLine });
    speak(twiml, confirmLine);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'yes' && session.confirmed?.time) {
    const thanks = `Perfect, thank you very much. Please note the patient name ${session.userRequest.name}. Have a great day.`;
    session.status = 'confirmed';
    session.transcript.push({ from: 'ai', text: thanks });
    speak(twiml, thanks);
    twiml.hangup();
    try {
      if (session.userRequest.callback) {
        await client.messages.create({
          to: session.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `✅ Confirmed: ${session.confirmed.time} at ${session.userRequest.clinicName}.`
        });
      }
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'no') {
    const retry = 'No problem. Could you share another available time—morning or afternoon works too?';
    session.transcript.push({ from: 'ai', text: retry });
    speak(twiml, retry);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(twiml.toString());
  }

  // receptionist says "come anytime"
  if (/\b(come\s+any\s*time|walk[-\s]?in|anytime today|free anytime)\b/i.test(lower)) {
    const askDocs = `Thanks! To confirm, walk-in is okay. Is there anything ${session.userRequest.name} should bring?`;
    session.transcript.push({ from: 'ai', text: askDocs });
    speak(twiml, askDocs);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(twiml.toString());
  }

  // fallback to GPT
  let reply;
  try { reply = await nextAIUtterance(callSid); }
  catch { reply = "I didn't catch that. Could you share an available day and time?"; }

  session.transcript.push({ from: 'ai', text: reply });
  speak(twiml, reply);
  const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
  speak(g, "I'm listening.");
  return res.type('text/xml').send(twiml.toString());
});

// ---------- Call status → SMS retry prompt ----------
app.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = (req.body.CallStatus || '').toLowerCase();
  const session = sessionsVoice.get(callSid);
  if (!session) return res.sendStatus(200);

  if (callStatus === 'completed' && session.status !== 'confirmed') {
    try {
      if (session.userRequest.callback) {
        await client.messages.create({
          to: session.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `The clinic ended the call before we could confirm. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
        });
      }
    } catch {}
  }

  if (/(failed|busy|no-answer|canceled)/i.test(callStatus)) {
    try {
      if (session.userRequest.callback) {
        await client.messages.create({
          to: session.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `Call didn’t go through (${callStatus}). Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
        });
      }
    } catch {}
  }

  return res.sendStatus(200);
});

// ---------- SMS webhook (still supported) ----------
app.post('/sms', async (req, res) => {
  const MessagingResponse = twilioPkg.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from  = (req.body.From || '').trim();
  const raw   = (req.body.Body || '');
  const body  = raw.trim();
  const lower = body.toLowerCase();

  const send = (text) => { twiml.message(text); return res.type('text/xml').send(twiml.toString()); };

  // A2P keywords
  if (/\b(stop|end|unsubscribe|quit|cancel)\b/.test(lower)) {
    cancelRetry(from);
    return send("You’re opted out and won’t receive more texts. Reply START to opt back in.");
  }
  if (/\b(start)\b/.test(lower)) return send("You’re opted in. Reply HELP for info.");
  if (/\b(help)\b/.test(lower))  return send(`${BRAND_NAME}: Msg&data rates may apply. Reply STOP to opt out.`);

  // Retry controls
  if (/\b(retry|now|call\s*again|call\s*back)\b/.test(lower)) {
    const details = lastCallByPatient.get(from);
    if (!details || !details.to) return send("I don’t have a clinic on file to call back. Start a new request first.");
    cancelRetry(from);
    try {
      await startClinicCall(details);
      return send(`Calling ${details.clinicName} again now. I’ll text the result.`);
    } catch {
      return send(`Couldn’t place the call just now. Reply RETRY again in a moment, or WAIT 5 / WAIT 15.`);
    }
  }
  if (/\bwait\s*5\b/.test(lower)) {
    const details = lastCallByPatient.get(from);
    if (!details || !details.to) return send("No clinic on file. Start a new request first.");
    cancelRetry(from);
    scheduleRetry(from, details, SHORT_WAIT_MS);
    return send("Okay—will retry in 5 minutes.");
  }
  if (/\bwait\s*15\b/.test(lower)) {
    const details = lastCallByPatient.get(from);
    if (!details || !details.to) return send("No clinic on file. Start a new request first.");
    cancelRetry(from);
    scheduleRetry(from, details, DEFAULT_RETRY_MS);
    return send("Got it—will retry in 15 minutes.");
  }
  if (/\bcancel\b/.test(lower)) {
    const cancelled = cancelRetry(from);
    return send(cancelled ? "Okay, cancelled the scheduled retry." : "No retry was scheduled.");
  }

  // For brevity, SMS intake flow omitted here (web app supersedes). You can keep your old SMS logic if needed.
  return send("Thanks! For now, please use our website chat to start a request: clarity frontend.");
});

// ---------- Web Chat API ----------
app.post('/app-chat', async (req, res) => {
  const { userId, message } = req.body || {};
  if (!userId || !message) return res.status(400).json({ ok: false, error: 'Missing userId or message' });

  const say = (text) => res.json({ ok: true, reply: text });

  let s = sessionsChat.get(userId);

  // commands
  if (/^\s*home\s*$/i.test(message)) {
    s = null;
    sessionsChat.delete(userId);
  }

  if (!s || /^\s*new\s*$/i.test(message)) {
    s = {
      state: 'intake_name',
      source: 'web',
      userPhone: null,
      patientName: null,
      symptoms: null,
      zip: null,
      insuranceY: null,
      dateStr: null,
      timeStr: null,
      chosenClinic: null,
      clinics: []
    };
    sessionsChat.set(userId, s);
    return say("Great, let's get you booked.\nWhat’s your full name? (First Last)");
  }

  const msg = message.trim();

  // quick intents
  if (/^\s*help\s*$/i.test(msg)) return say("I’ll ask your name, symptoms, ZIP, insurance (Y/N), and preferred date & time. Then I’ll contact a clinic for you.\nType HOME to restart any time.");
  if (/^\s*mine\s*$/i.test(msg)) {
    const usual = userUsualClinics.get(userId);
    if (!usual) return say("I don’t have a usual clinic saved yet. After we book today, I can save it for next time.");
    s.chosenClinic = usual;
    s.state = 'confirm_intake';
    const when = `${s.dateStr || 'soon'} ${s.timeStr || ''}`.trim();
    return say(`Okay—using your usual clinic: ${usual.name}${usual.address? ' — ' + usual.address: ''}.\nWe’ll try for ${when || 'the earliest time'}. Does that look right? (YES/NO)`);
  }

  // state machine
  if (s.state === 'intake_name') {
    const parsed = parseNameFirstLast(msg) || parseNameLastFirst(msg);
    if (!parsed) return say("Could you share your name as First Last?");
    s.patientName = `${parsed.first} ${parsed.last}`;
    s.state = 'intake_symptoms';
    return say(`Thanks, ${parsed.first}. What brings you in (symptoms)?`);
  }

  if (s.state === 'intake_symptoms') {
    s.symptoms = msg;
    s.state = 'intake_zip';
    return say("What ZIP code should I search near?");
  }

  if (s.state === 'intake_zip') {
    if (!isValidZip(msg)) return say("Please share a 5-digit US ZIP code.");
    s.zip = msg;
    s.state = 'intake_insurance';
    return say("Do you have insurance? (Y/N)");
  }

  if (s.state === 'intake_insurance') {
    if (!isValidYN(msg)) return say("Please reply Y or N for insurance.");
    s.insuranceY = ynToBool(msg);
    s.state = 'intake_preferred';
    return say("What’s your preferred date and time? (MM/DD/YYYY, HH:MM AM/PM)\nYou can also say “tomorrow morning” etc.");
  }

  if (s.state === 'intake_preferred') {
    // accept either strict format or chrono free-form
    let d = '', t = '';
    if (/,/.test(msg) && isValidDate(msg.split(',')[0]) && isValidTime(msg.split(',')[1] || '')) {
      d = msg.split(',')[0].trim();
      t = msg.split(',')[1].trim();
    } else {
      const parsed = chrono.parseDate(msg);
      if (parsed) {
        d = parsed.toLocaleDateString('en-US');
        t = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      }
    }
    if (!d || !t) return say("I couldn’t read that date/time. Try like: 10/25/2025, 10:30 AM — or say “tomorrow morning”.");
    s.dateStr = d; s.timeStr = t;

    // find clinics now
    const specialty = inferSpecialty(s.symptoms);
    const list = await findClinics(s.zip, s.insuranceY ? specialty : 'free clinic');
    s.clinics = list;
    if (!list.length) {
      s.state = 'intake_zip';
      return say("I couldn’t find clinics nearby. What ZIP should I search near?");
    }
    s.chosenClinic = list[0];
    s.state = 'confirm_intake';
    const top = s.chosenClinic;
    return say(
      `Here’s an option: ${top.name}${top.address ? ' — ' + top.address : ''}${top.phone? ' ('+top.phone+')':''}.\n` +
      `Book for ${s.dateStr} ${s.timeStr}? (YES to call, or NEXT for another option)`
    );
  }

  if (s.state === 'confirm_intake') {
    if (/^yes\b/i.test(msg)) {
      if (s.source === 'web' && !s.userPhone) {
        s.state = 'await_phone';
        return say("Great — to place the call and text your confirmation, what’s the best phone number for updates? (e.g., 555-123-4567)");
      }
      const reply = await proceedToBooking(s);
      return say(reply);
    }
    if (/^next\b/i.test(msg)) {
      const list = s.clinics || [];
      const idx = list.findIndex(c => c.name === s.chosenClinic?.name);
      const next = list[idx + 1];
      if (!next) return say("That’s the last option I found. Type YES to use it, or HOME to restart.");
      s.chosenClinic = next;
      return say(`Next: ${next.name}${next.address ? ' — ' + next.address : ''}${next.phone? ' ('+next.phone+')':''}.\nYES to use this, or NEXT again.`);
    }
    if (/^no\b/i.test(msg)) {
      s.state = 'intake_preferred';
      return say("No problem—what’s a better date/time?");
    }
    return say("Please reply YES to proceed, NEXT for another clinic, or NO to change the time.");
  }

  if (s.state === 'await_phone') {
    const p = cleanUSPhone(msg);
    if (!p) return say("I couldn’t read that. Please share a US number like 555-123-4567.");
    s.userPhone = p;
    const reply = await proceedToBooking(s);
    return say(reply);
  }

  if (s.state === 'calling') {
    return say("I’m on it. I’ll text you with the result. Type HOME to start over.");
  }

  return say("I didn’t understand that. Type HOME to start over, or HELP for help.");
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`${BRAND_NAME} concierge listening on ${PORT}`);
});
