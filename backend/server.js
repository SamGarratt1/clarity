import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

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

// small root + health
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

// preferred clinics per patient (key = patient phone)
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

// Bulk intake parser
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
  const nameOk = obj.name && isValidNameLF(obj.name);
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
      phone: null // (MVP) fetch via Place Details later
    }));
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

// ---------- GPT ----------
function buildSystemPrompt(userReq) {
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
    awaitingBring: false,
    turns: 0,
    startedAt: Date.now(),
    onHoldSince: null
  });

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
    if (!userRequest.clinicPhone) throw new Error('Required parameter "params[\\'to\\']" missing.');
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

  // after we ask “what to bring”, capture that
  if (session.awaitingBring) {
    const bringText = speech || 'No special items';
    session.confirmed = session.confirmed || {};
    session.confirmed.bring = bringText;
    const thanks = `Perfect. Thank you very much. We’ll note it for the patient ${session.userRequest.name}. Have a wonderful day.`;
    session.status = 'confirmed';
    session.transcript.push({ from: 'ai', text: thanks });
    speak(twiml, thanks);
    twiml.hangup();
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

  // intent detection
  let intent = 'other';
  if (/\b(yes|yeah|yep|works|okay|ok|sure|that[’']?s fine|perfect|sounds good)\b/i.test(lower)) intent = 'yes';
  else if (/\b(no|nope|not available|can[’']?t|unavailable)\b/i.test(lower)) intent = 'no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next)\b/i.test(lower)
        || /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/i.test(lower)
        || /\b(morning|afternoon|evening|noon|midday)\b/i.test(lower)) intent = 'time';

  if (intent === 'time') {
    const parsedDate = chrono.parseDate(speech, new Date());
    const cleanTime = parsedDate
      ? parsedDate.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : speech;
    session.confirmed = { ...(session.confirmed||{}), time: cleanTime };
    const confirmLine = `Great, I have you down for ${cleanTime} for patient ${session.userRequest.name}. Can you confirm?`;
    session.transcript.push({ from: 'ai', text: confirmLine });
    speak(twiml, confirmLine);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 6 });
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'yes' && session.confirmed?.time) {
    const askBring = `Thank you. Is there anything that ${session.userRequest.name} needs to bring?`;
    session.awaitingBring = true;
    session.transcript.push({ from: 'ai', text: askBring });
    const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 7 });
    speak(g, askBring);
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'no') {
    const retry = 'No problem. Could you share another available time—morning or afternoon works too?';
    session.transcript.push({ from: 'ai', text: retry });
    speak(twiml, retry);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 6 });
    return res.type('text/xml').send(twiml.toString());
  }

  // fallback to GPT or polite repeat
  let reply;
  try { reply = await nextAIUtterance(callSid); }
  catch { reply = "I didn't catch that. Could you share an available day and time?"; }

  session.transcript.push({ from: 'ai', text: reply });
  speak(twiml, reply);
  const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 6 });
  speak(g, "I'm listening.");
  return res.type('text/xml').send(twiml.toString());
});

// Call status → SMS retry prompt
app.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = (req.body.CallStatus || '').toLowerCase();
  const session = sessions.get(callSid);
  if (!session) return res.sendStatus(200);

  if (callStatus === 'completed' && session.status !== 'confirmed') {
    try {
      await client.messages.create({
        to: session.userRequest.callback,
        from: TWILIO_CALLER_ID,
        body: `The clinic ended the call before we could confirm. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
      });
    } catch {}
  }

  if (/(failed|busy|no-answer|canceled)/i.test(callStatus)) {
    try {
      await client.messages.create({
        to: session.userRequest.callback,
        from: TWILIO_CALLER_ID,
        body: `Call didn’t go through (${callStatus}). Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
      });
    } catch {}
  }

  return res.sendStatus(200);
});

// ---------- SMS webhook ----------
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

  // Retry controls available anytime
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
  if (/^cancel$/.test(lower)) {
    const cancelled = cancelRetry(from);
    return send(cancelled ? "Okay, cancelled the scheduled retry." : "No retry was scheduled.");
  }

  // Preferred clinic SMS commands
  if (/^my\s+clinic\s*:/i.test(body)) {
    const after = body.split(/:/i)[1] || '';
    const parts = after.split('|').map(s => s.trim());
    const name = parts[0] || '';
    const phone = parts[1] || '';
    const address = parts[2] || '';
    if (!name || !phone) return send('Please use: MY CLINIC: Name | +1XXXXXXXXXX | Address (optional)');
    savePreferredClinic(from, { name, phone, address });
    const list = getPreferredClinics(from);
    return send(`Saved. You now have ${list.length} clinic${list.length>1?'s':''} on file.\nReply CLINICS to view, or NEW to start a booking.`);
  }
  if (/^clinics$/i.test(body)) {
    const list = getPreferredClinics(from);
    if (!list.length) return send('No clinics saved. Add one with:\nMY CLINIC: Name | +1XXXXXXXXXX | Address');
    const lines = list.map((c,i)=>`${i+1}) ${c.name}${c.phone?' — '+c.phone:''}${c.address?' — '+c.address:''}`);
    return send(`Your clinics:\n${lines.join('\n')}\n\nReply NEW to start, or CLEAR CLINICS to remove all.`);
  }
  if (/^clear\s+clinics$/i.test(body)) {
    preferredClinicsByPatient.delete(from);
    return send('Cleared your saved clinics.');
  }
  if (/^save\s+clinic$/i.test(body)) {
    const last = lastCallByPatient.get(from);
    if (!last || !last.clinicName || !last.to) return send(`I don’t have a recent clinic to save. Try again after a booking.`);
    savePreferredClinic(from, { name: last.clinicName, phone: last.to, address: '' });
    return send(`Saved ${last.clinicName}. Reply CLINICS to view.`);
  }

  // SMS session
  let s = smsSessions.get(from);

  // Start NEW / RESET at any time
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
      `Name: Doe, Jane\nSymptoms: sore throat, fever\nZIP: 30309\nInsurance: Y\nPreferred: 10/05/2025, 10:30 AM\n\n` +
      `Tip: Save your usual clinic now:\nMY CLINIC: Midtown Family Practice | +1 555 123 4567 | 123 Main St`
    );
  }

  // Intake: expect the one-shot bulk message
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
      state: 'choose_source', // choose preferred vs nearby
      patientName: parsed.patientName,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
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

    const mine = getPreferredClinics(from);
    if (mine.length) {
      s.preferredList = mine;
      s.chosenClinic = null;
      smsSessions.set(from, s);
      const listStr = mine.slice(0,3).map((c,i)=>`${i+1}) ${c.name}${c.address? ' — '+c.address : ''}`).join('\n');
      return send(
        `Would you like me to try your usual clinic first?\n` +
        `${listStr}${mine.length>3?`\n…and ${mine.length-3} more.`:''}\n\n` +
        `Reply MINE to use #1, MINE 2 (or 3) to pick another, or NEARBY to search clinics near ${s.zip}.`
      );
    }

    // no saved clinics → search nearby
    const clinics = await findClinics(s.zip, s.specialty);
    s.clinics = clinics;
    const top = clinics[0];
    if (!top) {
      s.state = 'await_bulk';
      smsSessions.set(from, s);
      return send(`I couldn’t find clinics nearby. Reply RESET to try again with a different ZIP or symptoms.`);
    }
    s.state = 'select_clinic';
    s.chosenClinic = { name: top.name, phone: top.phone, address: top.address };
    smsSessions.set(from, s);

    return send(
      `Found: ${top.name}${top.address ? ' — ' + top.address : ''}\n` +
      `Book for ${s.windowText}? Reply YES to call, or NEXT for another option.\n` +
      `Tip: Save your own clinic with "MY CLINIC: Name | +1XXXXXXXXXX".`
    );
  }

  // Choose preferred vs nearby
  if (s.state === 'choose_source') {
    // MINE [index]
    const mMine = body.match(/^mine\s*(\d+)?$/i);
    if (mMine) {
      const idx = Math.max(1, parseInt(mMine[1]||'1',10)) - 1;
      const mine = s.preferredList || [];
      const pick = mine[idx];
      if (!pick) return send(`I don’t have that index. Reply MINE for #1, MINE 2, or NEARBY.`);
      if (!pick.phone) return send(`Your saved clinic doesn’t have a phone on file. Update it via:\nMY CLINIC: Name | +1XXXXXXXXXX | Address`);
      s.state = 'calling';
      s.chosenClinic = { name: pick.name, phone: pick.phone, address: pick.address };
      smsSessions.set(from, s);
      try {
        await startClinicCall({
          to: pick.phone,
          name: s.patientName,
          reason: s.symptoms,
          preferredTimes: [s.windowText],
          clinicName: pick.name,
          callback: from
        });
        return send(`Calling ${pick.name} now to book for ${s.windowText}. I’ll text you the confirmation.\nIf it fails, reply RETRY / WAIT 5 / WAIT 15 / CANCEL.`);
      } catch {
        return send(`Couldn’t start the call just now. Reply MINE again or NEARBY to search alternatives.`);
      }
    }

    // NEARBY
    if (/^nearby$/i.test(body)) {
      const clinics = await findClinics(s.zip, s.specialty);
      s.clinics = clinics;
      const top = clinics[0];
      if (!top) {
        s.state = 'await_bulk';
        smsSessions.set(from, s);
        return send(`I couldn’t find clinics nearby. Reply RESET to try again with a different ZIP or symptoms.`);
      }
      s.state = 'select_clinic';
      s.chosenClinic = { name: top.name, phone: top.phone, address: top.address };
      smsSessions.set(from, s);
      return send(
        `Found: ${top.name}${top.address ? ' — ' + top.address : ''}\n` +
        `Book for ${s.windowText}? Reply YES to call, or NEXT for another option.`
      );
    }

    return send(`Reply MINE (or MINE 2) to use your saved clinic, or NEARBY to search clinics.`);
  }

  // Selecting/confirming clinic (NEARBY flow)
  if (s.state === 'select_clinic') {
    if (/^yes\b/i.test(body)) {
      if (!s?.chosenClinic?.phone) {
        return send(`This clinic didn’t list a phone. Reply NEXT for another option or RESET to start over.`);
      }
      try {
        await startClinicCall({
          to: s.chosenClinic.phone,
          name: s.patientName,
          reason: s.symptoms,
          preferredTimes: [s.windowText],
          clinicName: s.chosenClinic.name,
          callback: from
        });
        s.state = 'calling';
        smsSessions.set(from, s);
        return send(`Calling ${s.chosenClinic.name} now to book for ${s.windowText}. I’ll text you the confirmation.\nIf it fails, reply RETRY / WAIT 5 / WAIT 15 / CANCEL.`);
      } catch {
        return send(`Couldn’t start the call just now. Reply YES again in a moment, or NEXT for another option.`);
      }
    }
    if (/^next\b/i.test(body)) {
      const list = s.clinics || [];
      const idx = list.findIndex(c => c.name === s.chosenClinic?.name);
      const next = list[idx + 1];
      if (!next) return send('No more options nearby. Reply RESET to start over or change ZIP.');
      s.chosenClinic = { name: next.name, phone: next.phone, address: next.address };
      smsSessions.set(from, s);
      return send(`Next: ${next.name}${next.address ? ' — ' + next.address : ''}\nBook for ${s.windowText}? Reply YES to call, or NEXT for another option.`);
    }
    return send(`Reply YES to call this clinic, or NEXT for another option.`);
  }

  // If we reach here while calling/in-between
  if (s.state === 'calling') {
    return send(`I’m on it. I’ll text you once I confirm the time. You can also reply RETRY / WAIT 5 / WAIT 15 / CANCEL.`);
  }

  return send(`Reply NEW to begin a booking. To save your usual clinic: MY CLINIC: Name | +1XXXXXXXXXX | Address`);
});

// ---------- Server ----------
app.listen(PORT, () => {
  console.log(`Concierge listening on :${PORT}`);
});
