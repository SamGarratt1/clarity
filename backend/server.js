// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { DateTime, FixedOffsetZone } from 'luxon';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

// ===== ENV =====
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
  TTS_VOICE = 'Polly.Joanna-Neural',
  USE_REDIS = 'false',
  REDIS_URL = '',
} = process.env;

function requireEnv(name) {
  if (!process.env[name] || String(process.env[name]).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
}
['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_CALLER_ID','PUBLIC_BASE_URL','OPENAI_API_KEY','GOOGLE_MAPS_API_KEY']
  .forEach(requireEnv);

// ===== Clients =====
const client = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const mapsClient = new GoogleMapsClient({});

// optional Redis/BullMQ for retries
let useRedis = /^true$/i.test(USE_REDIS);
let retryQueue = null;
let redis = null;
if (useRedis) {
  const { Queue, Worker, QueueScheduler } = await import('bullmq');
  const IORedis = (await import('ioredis')).default;
  redis = new IORedis(REDIS_URL);
  retryQueue = new Queue('concierge-retries', { connection: redis });
  new QueueScheduler('concierge-retries', { connection: redis });
  new Worker('concierge-retries', async (job) => {
    const { patientNumber, details } = job.data || {};
    try {
      await startClinicCall(details);
      await client.messages.create({
        to: details.callback, from: TWILIO_CALLER_ID,
        body: `Retrying your booking with ${details.clinicName} now. I’ll text the result.`
      });
    } catch {
      await client.messages.create({
        to: details.callback, from: TWILIO_CALLER_ID,
        body: `Couldn’t retry the call. Reply RETRY to try again.`
      });
    }
  }, { connection: redis });
}

// ===== App =====
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Helpers =====
function speakSSML(twiml, text) {
  const safe = (text || '')
    .replace(/[&<>"]/g, '')   // strip XML specials
    .replace(/’/g, "'")
    .replace(/“|”/g, '"');

  // No <prosody> wrapper – just pass clean text
  twiml.say({ voice: TTS_VOICE, language: 'en-US' }, safe);
}



// name normalization: "Last, First" -> "First Last"
const nameLFRe = /^\s*([A-Za-z'.\- ]+)\s*,\s*([A-Za-z'.\- ]+)\s*$/;
function normalizeNameToFirstLast(s='') {
  const m = s.match(nameLFRe);
  if (!m) return s.trim();
  const last = m[1].trim(), first = m[2].trim();
  return `${first} ${last}`;
}

// limits & safety rails
const MAX_CALL_MS = 3 * 60 * 1000; // 3 min
const MAX_HOLD_MS = 90 * 1000;     // 90s

// retry scheduler
const DEFAULT_RETRY_MS = 15 * 60 * 1000;
const SHORT_WAIT_MS    = 5  * 60 * 1000;

// memory stores
const sessions          = new Map();
const smsSessions       = new Map();
const lastCallByPatient = new Map();
const pendingRetries    = new Map();

// ===== Validation =====
const zipRe    = /^\d{5}$/;
const ynRe     = /^(y|yes|n|no)$/i;
const timeRe   = /^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i;
const dateRe   = /^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/;

const isValidZip  = s => zipRe.test((s||'').trim());
const isValidYN   = s => ynRe.test((s||'').trim());
const ynToBool    = s => /^y/i.test(s||'');
const isValidTime = s => timeRe.test((s||'').trim());
const isValidDate = s => dateRe.test((s||'').trim());

// Bulk intake parser (single SMS, labeled lines)
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
  const nameOk = !!obj.name;
  const zipOk  = obj.zip && isValidZip(obj.zip);
  const insOk  = obj.insurance && isValidYN(obj.insurance);
  let dateStr = '', timeStr = '';
  if (obj.preferred) {
    const parts = obj.preferred.split(',').map(s => s.trim());
    if (parts.length >= 2) { dateStr = parts[0]; timeStr = parts[1]; }
  }
  const dateOk = isValidDate(dateStr);
  const timeOk = isValidTime(timeStr);

  if (!nameOk || !zipOk || !insOk || !dateOk || !timeOk || !obj.symptoms) return null;
  return {
    patientName: normalizeNameToFirstLast(obj.name),
    nameLF: obj.name,
    symptoms: obj.symptoms,
    zip: obj.zip,
    insuranceY: ynToBool(obj.insurance),
    dateStr,
    timeStr,
    windowText: `${dateStr} ${timeStr}`
  };
}

// ===== Specialty & Maps =====
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
function specialtyToPlaceType(spec) {
  const s = (spec || '').toLowerCase();
  if (s.includes('dent')) return 'dentist';
  if (s.includes('urgent')) return 'hospital';
  return 'doctor';
}
async function findClinics(zip, specialty = 'clinic', insuranceY = true) {
  try {
    const geoResp = await mapsClient.geocode({ params: { address: zip, key: GOOGLE_MAPS_API_KEY } });
    if (!geoResp.data.results.length) return [];
    const { lat, lng } = geoResp.data.results[0].geometry.location;

    const keyword = insuranceY ? specialty : 'free clinic community health center sliding scale';
    const type = insuranceY ? (specialtyToPlaceType(specialty) || 'doctor') : 'health';

    const placesResp = await mapsClient.placesNearby({
      params: { location: { lat, lng }, radius: 8000, type, keyword, key: GOOGLE_MAPS_API_KEY }
    });

    const basics = placesResp.data.results.slice(0, 8);
    const detailed = await Promise.all(basics.map(async (p) => {
      try {
        const det = await mapsClient.placeDetails({
          params: {
            place_id: p.place_id,
            fields: ['name','formatted_address','formatted_phone_number','international_phone_number','geometry','rating','utc_offset_minutes'],
            key: GOOGLE_MAPS_API_KEY
          }
        });
        const d = det.data.result || {};
        return {
          name: d.name || p.name,
          address: d.formatted_address || p.vicinity || '',
          rating: d.rating ?? p.rating ?? null,
          location: (d.geometry || p.geometry)?.location,
          phone: d.international_phone_number || d.formatted_phone_number || null,
          tzOffsetMin: (typeof d.utc_offset_minutes === 'number') ? d.utc_offset_minutes : null
        };
      } catch {
        return {
          name: p.name, address: p.vicinity || '', rating: p.rating || null,
          location: p.geometry?.location, phone: null, tzOffsetMin: null
        };
      }
    }));
    return detailed;
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

// ===== GPT (guarded against outages) =====
function buildSystemPrompt(userReq) {
  return `
You are a polite, concise scheduler calling a clinic to book an appointment.
Goal: secure the earliest suitable slot matching the patient’s preferences.
Rules:
- Do NOT diagnose or offer medical advice.
- Be friendly, clear, and efficient.
- Confirm date/time, provider (if available), any prep, and callback number.
- After confirmation, thank them and end the call.
Patient:
Reason: ${userReq.reason ? '[on file]' : 'General check-up'}
Preferred: ${JSON.stringify(userReq.preferredTimes || ['This week'])}
Callback: ${userReq.callback ? '[on file]' : 'N/A'}
`.trim();
}
async function safeOpenAIChat(options, fallback) {
  try {
    const resp = await openai.chat.completions.create(options);
    return (resp.choices?.[0]?.message?.content || '').trim() || fallback;
  } catch (e) {
    console.warn('OpenAI error (continuing without LLM):', e?.message || e);
    return fallback;
  }
}
async function nextAIUtterance(callSid) {
  const session = sessions.get(callSid);
  const lastTurns = (session?.transcript || []).slice(-3);
  const messages = [
    { role: 'system', content: buildSystemPrompt(session.userRequest) },
    ...lastTurns.map(t => ({ role: t.from === 'ai' ? 'assistant' : 'user', content: t.text }))
  ];
  return await safeOpenAIChat(
    { model: 'gpt-4o-mini', temperature: 0.3, messages },
    "Could you share an available day and time?"
  );
}
async function nluExtractIntentAndTime({ transcriptTurns }) {
  const prompt = `
You are an assistant for phone scheduling. Classify the receptionist's latest message.
Return STRICT JSON with keys:
- "intent": one of ["yes","no","time","other"]
- "time_text": the offered/confirmed time phrase if present (else "")
Latest message:
${transcriptTurns[transcriptTurns.length - 1]?.text || ''}
`.trim();
  const text = await safeOpenAIChat(
    { model: 'gpt-4o-mini', temperature: 0, messages: [{ role: 'system', content: prompt }] },
    '{"intent":"other","time_text":""}'
  );
  try { return JSON.parse(text); } catch { return { intent: 'other', time_text: '' }; }
}

// ===== Call helpers / retry =====
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback, clinicTzOffsetMin = null }) {
  const call = await client.calls.create({
    to,
    from: TWILIO_CALLER_ID,
    url: `${PUBLIC_BASE_URL}/voice?sid=${uuidv4()}`,
    statusCallback: `${PUBLIC_BASE_URL}/status`,
    statusCallbackEvent: ['initiated','ringing','answered','completed'],
    statusCallbackMethod: 'POST'
  });

  sessions.set(call.sid, {
    userRequest: { name, reason, preferredTimes, clinicName, callback, clinicPhone: to, clinicTzOffsetMin },
    transcript: [],
    status: 'in_progress',
    confirmed: null,
    prepNotes: null,
    awaitingPrep: false,
    startedAt: Date.now(),
    onHoldSince: null
  });

  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback, clinicTzOffsetMin });
  return call.sid;
}
async function scheduleRetry(patientNumber, details, delayMs) {
  if (useRedis && retryQueue) {
    await retryQueue.add('retry-call', { patientNumber, details }, { delay: delayMs, removeOnComplete: true, removeOnFail: true });
    return;
  }
  const existing = pendingRetries.get(patientNumber);
  if (existing) clearTimeout(existing);
  const timeoutId = setTimeout(async () => {
    pendingRetries.delete(patientNumber);
    try {
      await startClinicCall(details);
      await client.messages.create({ to: details.callback, from: TWILIO_CALLER_ID, body: `Retrying your booking with ${details.clinicName} now. I’ll text the result.` });
    } catch {
      try { await client.messages.create({ to: details.callback, from: TWILIO_CALLER_ID, body: `Couldn’t retry the call just now. Reply RETRY to try again.` }); } catch {}
    }
  }, delayMs);
  pendingRetries.set(patientNumber, timeoutId);
}
function cancelRetry(patientNumber) {
  const t = pendingRetries.get(patientNumber);
  if (t) { clearTimeout(t); pendingRetries.delete(patientNumber); return true; }
  return false;
}
function endSession(callSid) { sessions.delete(callSid); }

// ===== Twilio signature verification =====
function verifyTwilio(req, res, next) {
  try {
    const signature = req.headers['x-twilio-signature'];
    const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;
    const valid = twilioPkg.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
    if (!valid) return res.status(403).send('Forbidden'); next();
  } catch { return res.status(403).send('Forbidden'); }
}

// ===== Routes =====
app.get('/healthz', async (_req, res) => {
  const checks = { env:true, twilio:!!TWILIO_ACCOUNT_SID, maps:!!GOOGLE_MAPS_API_KEY, openai:!!OPENAI_API_KEY, redis: useRedis ? !!REDIS_URL : true };
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 500).json({ ok, checks });
});

// Start call (manual/programmatic)
app.post('/call', async (req, res) => {
  console.log('POST /call body:', req.body);
  const rawName = req.body.name || '';
  const userRequest = {
    name: normalizeNameToFirstLast(rawName), // << First Last for voice
    reason: req.body.reason,
    preferredTimes: req.body.preferredTimes || [],
    clinicName: req.body.clinicName || '',
    callback: req.body.callback || '',
    clinicPhone: req.body.clinicPhone || req.body.to,
    clinicTzOffsetMin: req.body.clinicTzOffsetMin ?? null
  };
  const preferredTimesNormalized = Array.isArray(userRequest.preferredTimes)
    ? userRequest.preferredTimes
    : (typeof userRequest.preferredTimes === 'string' ? (() => { try { return JSON.parse(userRequest.preferredTimes); } catch { return []; } })() : []);
  try {
    const callSid = await startClinicCall({
      to: userRequest.clinicPhone,
      name: userRequest.name,
      reason: userRequest.reason,
      preferredTimes: preferredTimesNormalized,
      clinicName: userRequest.clinicName,
      callback: userRequest.callback,
      clinicTzOffsetMin: userRequest.clinicTzOffsetMin ?? null
    });
    return res.json({ ok: true, callSid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// First voice response
app.post('/voice', verifyTwilio, async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const session = sessions.get(callSid);

  if (!session) {
    speakSSML(twiml, 'Sorry, I lost context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const firstLine =
    `Hello, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. ` +
    `I’m calling to schedule an appointment for ${session.userRequest.name}. ` +
    `${session.userRequest.reason ? 'Reason: ' + session.userRequest.reason + '. ' : ''}` +
    `Do you have availability ${session.userRequest.preferredTimes?.[0] || 'this week'}?`;

  session.transcript.push({ from: 'ai', text: firstLine });

  speakSSML(twiml, firstLine);
  const gather = twiml.gather({
    input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', language: 'en-US',
    speechModel: 'phone_call',
    hints: 'yes, no, that works, confirmed, confirm, booked, schedule, morning, afternoon, evening, monday, tuesday, wednesday, thursday, friday, saturday, sunday, a.m., p.m., o’clock'
  });
  speakSSML(gather, 'I can wait for your available times.');

  res.type('text/xml').send(twiml.toString());
});

// Handle receptionist speech
app.post('/gather', verifyTwilio, async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const session = sessions.get(callSid);

  if (!session) {
    speakSSML(twiml, 'I lost the call context. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const elapsedMs = Date.now() - (session.startedAt || Date.now());
  if (elapsedMs > MAX_CALL_MS) {
    speakSSML(twiml, "I have to wrap here. We'll follow up by text. Thank you.");
    twiml.hangup();
    try {
      await client.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `Clinic line busy/long. Reply RETRY for another attempt, WAIT 5 / WAIT 15 to schedule, or CANCEL.`
      });
    } catch {}
    endSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (speech) session.transcript.push({ from: 'rx', text: speech });

  // Intent detection
  const lower = speech.toLowerCase().trim();
  const timeLike = /\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next)\b/i.test(lower)
    || /\b\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)?\b/i.test(lower)
    || /\b(morning|afternoon|evening|noon|midday|lunch)\b/i.test(lower);
  const yesLike = /\b(yes|yeah|yep|works|okay|ok|sure|that(?:'|’)s fine|perfect|sounds good|that works|that should work|we can do that|book it|go ahead|confirm|confirmed|you are all set|all set|scheduled)\b/i.test(lower);
  const noLike  = /\b(no|nope|not available|can(?:'|’)t|cannot|unavailable|doesn(?:'|’)t work|won(?:'|’)t work|need to reschedule)\b/i.test(lower);

  let intent = 'other';
  if (yesLike) intent = 'yes';
  else if (noLike) intent = 'no';
  else if (timeLike) intent = 'time';

  // Hold detection
  if (/\b(please hold|hold on|one moment|just a moment|put you on hold|one sec|minute)\b/i.test(lower)) {
    if (!session.onHoldSince) session.onHoldSince = Date.now();
    if (Date.now() - session.onHoldSince > MAX_HOLD_MS) {
      speakSSML(twiml, "I’ll follow up later. Thank you.");
      twiml.hangup();
      try {
        const details = {
          to: session.userRequest.clinicPhone,
          name: session.userRequest.name,
          reason: session.userRequest.reason,
          preferredTimes: session.userRequest.preferredTimes,
          clinicName: session.userRequest.clinicName,
          callback: session.userRequest.callback,
          clinicTzOffsetMin: session.userRequest.clinicTzOffsetMin ?? null
        };
        await client.messages.create({
          to: session.userRequest.callback, from: TWILIO_CALLER_ID,
          body: `Clinic kept us on hold too long. Reply NOW/RETRY to call again, or WAIT 5 / WAIT 15 / CANCEL.`
        });
        await scheduleRetry(session.userRequest.callback, details, DEFAULT_RETRY_MS);
      } catch {}
      endSession(callSid);
      return res.type('text/xml').send(twiml.toString());
    }
    speakSSML(twiml, 'Certainly, I can hold.');
    twiml.pause({ length: 15 });
    const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5, language:'en-US', speechModel:'phone_call', hints:'yes, no, still here, back, continue' });
    speakSSML(g, 'I’m still here.');
    return res.type('text/xml').send(twiml.toString());
  } else if (session.onHoldSince) {
    session.onHoldSince = null;
  }

  // NLU fallback if unclear
  if (intent === 'other') {
    try {
      const { intent: mlIntent, time_text } = await nluExtractIntentAndTime({
        transcriptTurns: session.transcript.concat([{ from:'rx', text: speech }])
      });
      if (mlIntent === 'time' && time_text) {
        intent = 'time';
        // override speech with extracted time text for parsing
        session.transcript.push({ from: 'sys', text: `(nlu time: ${time_text})` });
        handleTime(time_text);
        return; // response sent within handleTime
      } else if (mlIntent !== 'other') {
        intent = mlIntent;
      }
    } catch {}
  }

  // Helper to parse a time phrase and confirm
  function handleTime(textForParse) {
    const parsedDate = chrono.parseDate(textForParse, new Date());
    let cleanTime = textForParse;
    if (parsedDate) {
      const tzOffsetMin = session.userRequest.clinicTzOffsetMin;
      if (typeof tzOffsetMin === 'number') {
        const z = FixedOffsetZone.instance(tzOffsetMin);
        cleanTime = DateTime.fromJSDate(parsedDate, { zone: z }).toFormat('EEEE, LLL d, h:mm a');
      } else {
        cleanTime = DateTime.fromJSDate(parsedDate).toFormat('EEEE, LLL d, h:mm a');
      }
    }
    session.confirmed = { time: cleanTime };
    const confirmLine = `Great, I have you down for ${cleanTime} for patient ${session.userRequest.name}. Can you confirm?`;
    session.transcript.push({ from: 'ai', text: confirmLine });
    speakSSML(twiml, confirmLine);
    twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5, language:'en-US', speechModel:'phone_call', hints:'yes, confirmed, that works, correct' });
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'time') {
    handleTime(speech);
    return;
  }

  // If we’re waiting for prep notes (after time is confirmed and they said yes)
  if (session.awaitingPrep) {
    // Capture and finish
    session.prepNotes = speech || null;
    session.awaitingPrep = false;

    const thanks = `Perfect, thank you very much. Please note the patient name ${session.userRequest.name}. Have a great day.`;
    session.status = 'confirmed';
    session.transcript.push({ from: 'ai', text: thanks });
    speakSSML(twiml, thanks);
    twiml.hangup();
    try {
      const prepPart = session.prepNotes ? ` Bring: ${session.prepNotes}` : '';
      await client.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `✅ Confirmed: ${session.confirmed?.time || '(time not captured)'} at ${session.userRequest.clinicName}.${prepPart}`
      });
    } catch {}
    endSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'yes' && session.confirmed?.time) {
    // Ask explicitly for documents/prep before ending call
    const askPrep = `Thank you. Is there anything that ${session.userRequest.name} needs to bring, like an ID, insurance card, or forms?`;
    session.transcript.push({ from: 'ai', text: askPrep });
    session.awaitingPrep = true; // next turn we capture it
    speakSSML(twiml, askPrep);
    const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:10, language:'en-US', speechModel:'phone_call', hints:'photo ID, insurance card, referral, copay, arrive early, forms' });
    speakSSML(g, 'I’ll note any documents or preparation needed.');
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'no') {
    const retry = 'No problem. Could you share another available time—morning or afternoon works as well?';
    session.transcript.push({ from: 'ai', text: retry });
    speakSSML(twiml, retry);
    const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5, language:'en-US', speechModel:'phone_call', hints:'monday, tuesday, afternoon, morning, 10:30 a.m., 2:45 p.m.' });
    speakSSML(g, 'I’m listening.');
    return res.type('text/xml').send(twiml.toString());
  }

  // fallback to LLM smalltalk if available
  const reply = await nextAIUtterance(callSid);
  session.transcript.push({ from: 'ai', text: reply });
  speakSSML(twiml, reply);
  const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5, language:'en-US', speechModel:'phone_call', hints:'monday, tuesday, afternoon, morning, 10:30 a.m., 2:45 p.m.' });
  speakSSML(g, "I'm listening.");
  return res.type('text/xml').send(twiml.toString());
});

// Call status → SMS retry prompt
app.post('/status', verifyTwilio, async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = (req.body.CallStatus || '').toLowerCase();
  const session = sessions.get(callSid);
  if (!session) return res.sendStatus(200);

  if (callStatus === 'completed' && session.status !== 'confirmed') {
    try {
      await client.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `The clinic ended the call before we could confirm. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
      });
    } catch {}
  }

  if (/(failed|busy|no-answer|canceled)/i.test(callStatus)) {
    try {
      await client.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `Call didn’t go through (${callStatus}). Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
      });
    } catch {}
  }

  if (/(completed|failed|busy|no-answer|canceled)/i.test(callStatus)) endSession(callSid);
  return res.sendStatus(200);
});

// ===== SMS webhook =====
app.post('/sms', verifyTwilio, async (req, res) => {
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
    try { await startClinicCall(details); return send(`Calling ${details.clinicName} again now. I’ll text you the result.`); }
    catch { return send(`Couldn’t place the call just now. Reply RETRY again in a moment, or WAIT 5 / WAIT 15.`); }
  }
  if (/\bwait\s*5\b/.test(lower)) {
    const details = lastCallByPatient.get(from);
    if (!details || !details.to) return send("No clinic on file. Start a new request first.");
    cancelRetry(from); await scheduleRetry(from, details, SHORT_WAIT_MS);
    return send("Okay—will retry in 5 minutes.");
  }
  if (/\bwait\s*15\b/.test(lower)) {
    const details = lastCallByPatient.get(from);
    if (!details || !details.to) return send("No clinic on file. Start a new request first.");
    cancelRetry(from); await scheduleRetry(from, details, DEFAULT_RETRY_MS);
    return send("Got it—will retry in 15 minutes.");
  }
  if (/\bcancel\b/.test(lower)) {
    const cancelled = cancelRetry(from);
    return send(cancelled ? "Okay, cancelled the scheduled retry." : "No retry was scheduled.");
  }

  // SMS session
  let s = smsSessions.get(from);

  if (!s || /\b(new|restart|reset)\b/.test(lower)) {
    smsSessions.set(from, { state: 'await_bulk' });
    return send(
      `Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}.\n` +
      `Please reply in ONE message using this format:\n\n` +
      `Name: Last, First\n` +
      `Symptoms: <brief>\n` +
      `ZIP: 12345\n` +
      `Insurance: Y/N\n` +
      `Preferred: MM/DD/YYYY, HH:MM AM/PM\n\n` +
      `Example:\n` +
      `Name: Doe, Jane\nSymptoms: sore throat, fever\nZIP: 30309\nInsurance: Y\nPreferred: 10/05/2025, 10:30 AM`
    );
  }

  if (s.state === 'await_bulk') {
    const parsed = parseBulkIntake(body);
    if (!parsed) {
      return send(
        `I couldn’t read that. Please copy this template and fill it in:\n\n` +
        `Name: Last, First\nSymptoms: <brief>\nZIP: 12345\nInsurance: Y/N\nPreferred: MM/DD/YYYY, HH:MM AM/PM`
      );
    }
    const specialty = inferSpecialty(parsed.symptoms);
    s = {
      state: 'select_clinic',
      patientName: parsed.patientName,
      nameLF: parsed.nameLF,
      symptoms: parsed.symptoms,
      zip: parsed.zip,
      insuranceY: parsed.insuranceY,
      dateStr: parsed.dateStr,
      timeStr: parsed.timeStr,
      windowText: parsed.windowText,
      specialty
    };
    smsSessions.set(from, s);

    const clinics = await findClinics(s.zip, s.specialty, s.insuranceY);
    s.clinics = clinics;
    const top = clinics[0];
    if (!top) {
      s.state = 'await_bulk'; smsSessions.set(from, s);
      return send(`I couldn’t find clinics nearby. Reply RESET to try again with a different ZIP or symptoms.`);
    }
    s.chosenClinic = { name: top.name, phone: top.phone, address: top.address, tzOffsetMin: top.tzOffsetMin ?? null };
    smsSessions.set(from, s);

    return send(
      `Found: ${top.name}${top.address ? ' — ' + top.address : ''}\n` +
      `Book for ${s.windowText}? Reply YES to call, or NEXT for another option.\n` +
      `You can also reply CANCEL to stop.`
    );
  }

  if (s.state === 'select_clinic') {
    if (/^yes\b/i.test(body)) {
      if (!s?.chosenClinic?.phone) {
        return send(`This clinic didn’t list a phone. Reply NEXT for another option or RESET to start over.`);
      }
      try {
        await startClinicCall({
          to: s.chosenClinic.phone,
          name: s.patientName,                       // already First Last
          reason: s.symptoms,
          preferredTimes: [s.windowText],
          clinicName: s.chosenClinic.name,
          callback: from,
          clinicTzOffsetMin: s.chosenClinic.tzOffsetMin ?? null
        });
        s.state = 'calling'; smsSessions.set(from, s);
        return send(`Calling ${s.chosenClinic.name} now to book for ${s.windowText}. I’ll text you the confirmation.\nIf it fails, reply RETRY / WAIT 5 / WAIT 15 / CANCEL.`);
      } catch {
        return send(`Couldn’t start the call just now. Reply YES again in a moment, or NEXT for another option.`);
      }
    }
    if (/^next\b/i.test(body)) {
      const list = s.clinics || [];
      const idx = Math.max(0, list.findIndex(c => c.name === s.chosenClinic?.name));
      const next = list[(idx + 1) % list.length];
      s.chosenClinic = { name: next.name, phone: next.phone, address: next.address, tzOffsetMin: next.tzOffsetMin ?? null };
      smsSessions.set(from, s);
      return send(`Option: ${next.name}${next.address ? ' — ' + next.address : ''}\nBook for ${s.windowText}? Reply YES to call, or NEXT for another option.`);
    }
    if (/^cancel\b/i.test(body)) { smsSessions.delete(from); return send('Cancelled. Text NEW to start again.'); }
    return send(`Reply YES to call this clinic, NEXT for another option, or CANCEL.`);
  }

  if (s.state === 'calling') {
    if (/\b(retry|now|call\s*again)\b/i.test(lower)) {
      const details = lastCallByPatient.get(from);
      if (!details || !details.to) return send("I don’t have a clinic on file to call back. Start a new request first.");
      cancelRetry(from);
      try { await startClinicCall(details); return send(`Calling ${details.clinicName} again now. I’ll text you the result.`); }
      catch { return send(`Couldn’t place the call just now. Reply RETRY again in a moment, or WAIT 5 / WAIT 15.`); }
    }
    return send(`I’ll text you as soon as I confirm with the clinic. Reply RETRY / WAIT 5 / WAIT 15 / CANCEL anytime.`);
  }

  return send(`Say NEW to start a fresh request, or HELP for info.`);
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`Concierge listening on :${PORT}`);
});
