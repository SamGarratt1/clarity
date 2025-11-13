import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

/* ---------- ENV ---------- */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY,
  REDIS_URL, // optional for future scaling
  PORT = 10000,
  BRAND_NAME = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant',
  TTS_VOICE = 'Polly.Joanna-Neural'
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error('Missing required env var: PUBLIC_BASE_URL');
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_CALLER_ID) throw new Error('Missing Twilio env vars');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const client = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const mapsClient = new GoogleMapsClient({});

/* ---------- App ---------- */
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ---------- Basic anti-abuse ---------- */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // 60 requests/min/IP
  standardHeaders: true, legacyHeaders: false
});
app.use(limiter);

/* ---------- Memory stores ---------- */
const sessions      = new Map(); // voice sessions (key: CallSid)
const smsSessions   = new Map(); // sms/web chat triage (key: From)
const lastCallByKey = new Map(); // last call per user key (From or web)

const MAX_CALL_MS   = 3 * 60 * 1000;
const MAX_HOLD_MS   = 90 * 1000;

/* ---------- Helpers ---------- */
function speak(twiml, text) {
  twiml.say({ voice: TTS_VOICE }, text);
}

const nameLFRe  = /^\s*([A-Za-z'.\- ]+)\s*,\s*([A-Za-z'.\- ]+)\s*$/; // "Last, First"
const zipRe     = /^\d{5}$/;
const ynRe      = /^(y|yes|n|no)$/i;

const isValidZip = s => zipRe.test((s||'').trim());
const ynToBool   = s => /^y/i.test(s||'');

/* ---------- Translate to English for clinic calls ---------- */
async function translateToEnglish(text, sourceLang = 'auto') {
  if (!text) return '';
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system',
          content: 'You are a professional medical translator. Translate to concise ENGLISH only. Return only the translation.' },
        { role: 'user', content: `[${sourceLang}] ${text}` }
      ]
    });
    return (resp.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('translateToEnglish error:', e.message);
    return text;
  }
}

/* ---------- Maps ---------- */
function inferSpecialty(symptoms = '') {
  const s = (symptoms||'').toLowerCase();
  if (/skin|rash|acne|mole|dermat/i.test(s)) return 'dermatologist';
  if (/tooth|gum|dent/i.test(s)) return 'dentist';
  if (/eye|vision|ophthalm/i.test(s)) return 'ophthalmologist';
  if (/throat|ear|nose|sinus|ent/i.test(s)) return 'otolaryngologist';
  if (/chest pain|shortness|palpit/i.test(s)) return 'cardiologist';
  if (/stomach|abdomen|nausea|gi|diarrhea|vomit/i.test(s)) return 'gastroenterologist';
  if (/bone|joint|fracture|ortho/i.test(s)) return 'orthopedic';
  if (/flu|fever|cough|urgent|injury|stitches|sprain/i.test(s)) return 'urgent care';
  return 'clinic';
}

async function findClinics(zip, specialty = 'clinic') {
  try {
    const geoResp = await mapsClient.geocode({ params: { address: zip, key: GOOGLE_MAPS_API_KEY }});
    if (!geoResp.data.results.length) return [];
    const { lat, lng } = geoResp.data.results[0].geometry.location;

    const placesResp = await mapsClient.placesNearby({
      params: {
        location: { lat, lng },
        radius: 10000,
        keyword: specialty,
        type: 'doctor',
        key: GOOGLE_MAPS_API_KEY
      }
    });

    return placesResp.data.results.slice(0, 6).map(p => ({
      name: p.name,
      address: p.vicinity || p.formatted_address || '',
      rating: p.rating || null,
      location: p.geometry?.location,
      phone: null // (MVP) requires Place Details
    }));
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

/* ---------- AI utterances to receptionist (fallback) ---------- */
function buildSystemPrompt(userReq) {
  return `
You are a polite, concise patient concierge calling a clinic to book an appointment.
Goal: secure the earliest suitable slot matching the patient’s preferences.
Rules:
- Do NOT diagnose or offer medical advice.
- Confirm patient name, callback number, and time.
- If receptionist says “come anytime / walk in”, politely ask for the best recommended time window and note any required documents.
- Always confirm: "Please confirm the date/time and any preparation."
Patient:
Name: ${userReq.name || 'John Doe'}
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
  return resp.choices[0].message.content.trim();
}

/* ---------- Call helpers ---------- */
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

  sessions.set(call.sid, {
    userRequest: { name, reason, preferredTimes, clinicName, callback, clinicPhone: to },
    transcript: [],
    status: 'in_progress',
    confirmed: null,
    turns: 0,
    startedAt: Date.now(),
    onHoldSince: null
  });

  // remember for retries
  lastCallByKey.set(callback || to, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}

/* ---------- Voice endpoints ---------- */
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const session = sessions.get(callSid);

  const firstLine =
    `Hi, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. ` +
    `I'm calling to book an appointment for ${session.userRequest.name}. ` +
    `${session.userRequest.reason ? 'Reason: ' + session.userRequest.reason + '. ' : ''}` +
    `Do you have availability ${session.userRequest.preferredTimes?.[0] || 'this week'}?`;

  session.transcript.push({ from: 'ai', text: firstLine });
  speak(twiml, firstLine);

  const gather = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto' });
  speak(gather, 'I can wait for your available times.');

  res.type('text/xml').send(twiml.toString());
});

app.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim().toLowerCase();
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const s = sessions.get(callSid);
  if (!s) { speak(twiml,'Context lost—ending here.'); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  // total cap
  if (Date.now() - s.startedAt > MAX_CALL_MS) {
    speak(twiml, "I'll follow up by text. Thank you!");
    twiml.hangup(); return res.type('text/xml').send(twiml.toString());
  }

  if (speech) s.transcript.push({ from:'rx', text:speech });

  // hold logic
  if (/\b(please hold|hold on|one moment|just a moment|put you on hold)\b/i.test(speech)) {
    if (!s.onHoldSince) s.onHoldSince = Date.now();
    if (Date.now() - s.onHoldSince > MAX_HOLD_MS) {
      speak(twiml, "I’ll follow up later. Thank you!"); twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }
    speak(twiml, "Sure, I can hold."); twiml.pause({ length: 15 });
    const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    speak(g, "I’m still here."); return res.type('text/xml').send(twiml.toString());
  } else if (s.onHoldSince) s.onHoldSince = null;

  // intent quick paths
  let intent = 'other';
  if (/\b(yes|works|okay|ok|sure|confirmed)\b/i.test(speech)) intent = 'yes';
  else if (/\b(no|unavailable|not available|can’t|cant)\b/i.test(speech)) intent = 'no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next|am|pm|morning|afternoon|evening)\b/.test(speech)
        || /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(speech)) intent = 'time';
  else if (/\b(walk ?in|come any time|anytime|any time)\b/.test(speech)) intent = 'walkin';

  if (intent === 'walkin') {
    s.confirmed = { time: 'Walk-in / earliest available today' };
    const confirm = `Great—I'll note walk-in availability for patient ${s.userRequest.name}. Please confirm.`;
    speak(twiml, confirm); twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'time') {
    const parsed = chrono.parseDate(req.body.SpeechResult, new Date());
    const clean = parsed
      ? parsed.toLocaleString('en-US',{weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true})
      : req.body.SpeechResult;
    s.confirmed = { time: clean };
    const confirm = `Great, I have ${clean} for ${s.userRequest.name}. Can you confirm?`;
    speak(twiml, confirm); twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'yes' && s.confirmed?.time) {
    speak(twiml, `Perfect—thank you. Have a great day.`); s.status='confirmed'; twiml.hangup();
    try {
      await client.messages.create({
        to: s.userRequest.callback,
        from: TWILIO_CALLER_ID,
        body: `✅ Confirmed: ${s.confirmed.time} at ${s.userRequest.clinicName}.`
      });
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  if (intent === 'no') {
    const retry = 'No problem—do you have another time window, morning or afternoon works as well?';
    speak(twiml, retry);
    twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  let reply; try { reply = await nextAIUtterance(callSid); } catch { reply = 'Could you share a day and time that works?'; }
  speak(twiml, reply);
  const g = twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
  speak(g, "I'm listening."); return res.type('text/xml').send(twiml.toString());
});

app.post('/status', async (req, res) => res.sendStatus(200));

/* ---------- Web chat TRIAGE ---------- */
/**
 * Body: { from: string, text: string, lang?: 'en'|'es'|'pt'|'fr' }
 */
app.post('/chat', async (req, res) => {
  const { from, text, lang } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });

  let s = smsSessions.get(from) || {
    state: 'start',
    lang: lang || 'en',
    // collected:
    patientName: '',
    symptoms: '',
    zip: '',
    insuranceY: false,
    dateStr: '',
    timeStr: '',
    windowText: '',
    useOwnClinic: false,
    clinics: [],
    chosenClinic: null,
    callback: '' // optional: fill with a mobile later if you want SMS follow-ups
  };

  // persist language if user changes it
  if (lang) s.lang = lang;

  const LINES = []; // lines to show user (in s.lang language)
  const say = (m) => LINES.push(m);

  // Simple translator to patient language for UI prompts
  async function t(msg) {
    if ((s.lang||'en') === 'en') return msg;
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role:'system', content:`Translate to ${s.lang}. Return only the translation.` },
          { role:'user', content: msg }
        ]
      });
      return (r.choices?.[0]?.message?.content || msg).trim();
    } catch { return msg; }
  }

  function looksLikeASAP(str){ return /\b(asap|as soon as possible|soonest|earliest)\b/i.test(str||''); }

  // state machine
  if (s.state === 'start' || /^new$/i.test(text)) {
    s.state = 'name';
    say(await t(`Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}. What is the patient's full name? (First Last)`));
  }
  else if (s.state === 'name') {
    s.patientName = text.trim();
    s.state = 'symptoms';
    say(await t('What is the reason for the visit? (brief)'));
  }
  else if (s.state === 'symptoms') {
    s.symptoms = text.trim();
    s.state = 'zip';
    say(await t('What ZIP code should I search near? (5 digits)'));
  }
  else if (s.state === 'zip') {
    if (!isValidZip(text)) { say(await t('Please enter a 5-digit ZIP (e.g., 30309).')); }
    else { s.zip = text.trim(); s.state = 'ins'; say(await t('Do you have insurance? (Y/N)')); }
  }
  else if (s.state === 'ins') {
    if (!ynRe.test(text)) { say(await t('Please reply Y or N for insurance.')); }
    else { s.insuranceY = ynToBool(text); s.state = 'clinic_pref'; say(await t('Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?')); }
  }
  else if (s.state === 'clinic_pref') {
    s.useOwnClinic = /my clinic/i.test(text);
    s.state = 'date';
    say(await t('What date works best? (MM/DD/YYYY). You can also say "ASAP".'));
  }
  else if (s.state === 'date') {
    if (looksLikeASAP(text)) {
      s.dateStr = ''; s.timeStr = ''; s.windowText = 'ASAP';
      s.state = 'find';
    } else {
      const m = text.trim().match(/^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/);
      if (!m) { say(await t('Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.')); }
      else { s.dateStr = `${m[1]}/${m[2]}/${m[3]}`; s.state = 'time'; say(await t('Preferred time? (e.g., 10:30 AM). You can also say ASAP.')); }
    }
  }
  else if (s.state === 'time') {
    if (looksLikeASAP(text)) { s.timeStr = ''; s.windowText = 'ASAP'; s.state = 'find'; }
    else {
      const m = text.trim().match(/^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i);
      if (!m) { say(await t('Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.')); }
      else { s.timeStr = `${m[1]}:${m[2]} ${m[3].toUpperCase()}`; s.windowText = `${s.dateStr}, ${s.timeStr}`; s.state = 'find'; }
    }
  }

  if (s.state === 'find') {
    // Fetch clinics (own clinic UX can be added later via saved preferences)
    const specialty = inferSpecialty(s.symptoms);
    const clinics = await findClinics(s.zip, specialty);
    s.clinics = clinics;

    if (!clinics.length) {
      say(await t(`I couldn’t find clinics nearby. Please check the ZIP or try a broader area.`));
      s.state = 'zip';
    } else {
      // pick the best candidate and explain
      const best = clinics[0];
      s.chosenClinic = { name: best.name, phone: best.phone, address: best.address, rating: best.rating };

      const reason =
        s.useOwnClinic ? 'your usual clinic preference'
        : (specialty !== 'clinic' ? `your symptoms indicating ${specialty}` : 'distance and availability');

      say(await t(`Based on ${reason}, I suggest **${best.name}**${best.address?` — ${best.address}`:''}${best.rating?` (rating ${best.rating}/5)`:''}.`));
      say(await t(`Book for ${s.windowText}? Reply YES to call now, or type NEXT to see another option.`));
      s.state = 'confirm_choice';
    }
  }
  else if (s.state === 'confirm_choice') {
    if (/^next\b/i.test(text)) {
      const list = s.clinics || [];
      const idx = list.findIndex(c => c.name === s.chosenClinic?.name);
      const nxt = list[idx + 1];
      if (!nxt) { say(await t('No more options. Type YES to proceed or RESET to start again.')); }
      else {
        s.chosenClinic = { name: nxt.name, phone: nxt.phone, address: nxt.address, rating: nxt.rating };
        say(await t(`Option: **${nxt.name}**${nxt.address?` — ${nxt.address}`:''}${nxt.rating?` (rating ${nxt.rating}/5)`:''}.`));
        say(await t(`Book for ${s.windowText}? Reply YES to call, or NEXT for another.`));
      }
    } else if (/^yes\b/i.test(text)) {
      if (!s?.chosenClinic?.phone) {
        say(await t('This clinic did not list a phone number via Maps. Reply NEXT for another option.'));
      } else {
        // translate name/reason to English for the call
        const nameEn   = await translateToEnglish(s.patientName, s.lang || 'auto');
        const reasonEn = await translateToEnglish(s.symptoms,   s.lang || 'auto');

        await startClinicCall({
          to: s.chosenClinic.phone,
          name: nameEn,
          reason: reasonEn,
          preferredTimes: [s.windowText],
          clinicName: s.chosenClinic.name,
          callback: '' // optional: set to user’s mobile if you want SMS status
        });

        s.state = 'calling';
        say(await t(`Calling ${s.chosenClinic.name} now to book for ${s.windowText}. I’ll confirm here.`));
      }
    } else if (/^reset|restart|new$/i.test(text)) {
      s = { state:'start', lang:s.lang }; say(await t('Reset. Type NEW to begin.'));
    } else {
      say(await t('Please reply YES to book, NEXT for another option, or RESET to start over.'));
    }
  }

  smsSessions.set(from, s);
  return res.json({ ok:true, lines: LINES });
});

/* ---------- Health ---------- */
app.get('/healthz', (req,res)=>res.json({ ok:true }));

/* ---------- Start ---------- */
app.listen(PORT, ()=> console.log(`Clarity concierge listening on ${PORT}`));
