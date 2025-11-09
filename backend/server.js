// -------------------- Env & Imports --------------------
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';
import { DateTime } from 'luxon';

// -------------------- ENV --------------------
const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  BRAND_NAME = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant',
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY,
  // keep-alive
  KEEP_ALIVE = 'true',
  KEEP_ALIVE_MS = '300000', // 5 min
  // rate limiting
  CHAT_MAX_TOKENS_PER_5M = '12', // max 12 messages per 5 min per user
  CHAT_WINDOW_MS = '300000'
} = process.env;

// Basic required env hard-stop
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
}
requireEnv('PUBLIC_BASE_URL');
requireEnv('TWILIO_ACCOUNT_SID');
requireEnv('TWILIO_AUTH_TOKEN');
requireEnv('TWILIO_CALLER_ID');
requireEnv('OPENAI_API_KEY');
requireEnv('GOOGLE_MAPS_API_KEY');

// -------------------- Clients --------------------
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const twilio = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const maps = new GoogleMapsClient({});

// -------------------- Constants & Stores --------------------
const TTS_VOICE = 'Polly.Joanna-Neural';
const MAX_CALL_MS = 3 * 60 * 1000;
const MAX_HOLD_MS = 90 * 1000;

const sessions = new Map();       // voice sessions (CallSid -> state)
const chatSessions = new Map();   // chat sessions (deviceId -> state)
const smsSessions = new Map();    // sms sessions (from -> state)
const lastCallByPatient = new Map();
const pendingRetries = new Map();

// anti-spam tokens (deviceId/IP -> bucket)
const tokenBuckets = new Map();   // { tokens, refilledAt }

// -------------------- Utilities --------------------
const toBool = (s) => /^y(es)?$/i.test(String(s||'').trim());
const safeStr = (s) => (s ?? '').toString().trim();
const num = (s, d=0) => Number.isFinite(Number(s)) ? Number(s) : d;

function bucketKey(req) {
  const id = safeStr(req.body.from) || safeStr(req.headers['x-client-id']) || req.ip;
  return id || 'anon';
}
function refillBucket(key) {
  const now = Date.now();
  const windowMs = num(CHAT_WINDOW_MS, 300000);
  const max = num(CHAT_MAX_TOKENS_PER_5M, 12);
  const b = tokenBuckets.get(key) || { tokens: max, refilledAt: now };
  if (now - b.refilledAt >= windowMs) {
    b.tokens = max;
    b.refilledAt = now;
  }
  tokenBuckets.set(key, b);
  return b;
}
function consumeToken(req) {
  const key = bucketKey(req);
  const b = refillBucket(key);
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  tokenBuckets.set(key, b);
  return true;
}

function fmtTime(dt) {
  return DateTime.fromJSDate(dt).toFormat("EEE, MMM d 'at' h:mm a");
}

function distanceMeters(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371e3;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const x = Math.sin(Δφ/2) ** 2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// -------------------- Triage helpers --------------------
const LANG_MAP = {
  // language code -> label
  en: 'English', es: 'Español', fr: 'Français', pt: 'Português'
};
function normalizeLang(value) {
  const v = String(value || 'en').toLowerCase();
  if (LANG_MAP[v]) return v;
  // accept i18n like en-US -> en
  const base = v.split('-')[0];
  return LANG_MAP[base] ? base : 'en';
}

function triageLevel(symptomsRaw) {
  const s = (symptomsRaw || '').toLowerCase();
  // emergency flags (very conservative)
  if (/(chest pain|severe shortness|unconscious|stroke|numb side|slurred speech|seizure|anaphylaxis|suicid|overdose|uncontrolled bleeding)/i.test(s)) {
    return { level: 'emergency', note: 'Potential emergency indicators detected. Recommend calling local emergency services.' };
  }
  // urgent flags
  if (/(high fever|fracture|severe|rapid worsening|eye injury|deep cut|pregnant.*pain|possible appendicitis)/i.test(s)) {
    return { level: 'urgent', note: 'Symptoms suggest urgent evaluation at urgent care or same-day clinic.' };
  }
  // common self-care-ish cues
  if (/(mild cold|sniffles|minor sore throat|mild headache|seasonal allergies|minor rash)/i.test(s)) {
    return { level: 'self_care', note: 'These may improve with rest, fluids, and OTC care. If symptoms worsen or persist, seek a clinic.' };
  }
  // default
  return { level: 'clinic', note: 'A standard clinic visit is appropriate based on described symptoms.' };
}

function detectASAP(text) {
  return /\b(asap|as soon as possible|earliest|first available|soonest|today|right away)\b/i.test(text || '');
}

function inferSpecialty(symptoms = '') {
  const s = (symptoms || '').toLowerCase();
  if (/skin|rash|acne|mole|dermat/i.test(s)) return 'dermatologist';
  if (/tooth|gum|dent/i.test(s)) return 'dentist';
  if (/eye|vision|ophthalm/i.test(s)) return 'ophthalmologist';
  if (/throat|ear|nose|sinus|ent/i.test(s)) return 'otolaryngologist';
  if (/chest pain|shortness|palpit/i.test(s)) return 'cardiologist';
  if (/stomach|abdomen|nausea|gi|diarrhea/i.test(s)) return 'gastroenterologist';
  if (/bone|joint|fracture|ortho|sprain/i.test(s)) return 'orthopedic';
  if (/flu|fever|cough|urgent|injury|stitches/i.test(s)) return 'urgent care';
  return 'primary care';
}

async function geocodeZip(zip) {
  const resp = await maps.geocode({ params: { address: zip, key: GOOGLE_MAPS_API_KEY } });
  const r = resp.data.results?.[0];
  if (!r) return null;
  return r.geometry.location; // {lat,lng}
}

async function findClinics(zip, specialty = 'primary care') {
  const center = await geocodeZip(zip);
  if (!center) return [];
  const places = await maps.placesNearby({
    params: {
      key: GOOGLE_MAPS_API_KEY,
      location: center,
      radius: 10000, // 10 km
      keyword: specialty,
      type: 'doctor'
    }
  });
  const results = (places.data.results || []).slice(0, 8).map(p => ({
    placeId: p.place_id,
    name: p.name,
    address: p.vicinity || p.formatted_address || '',
    rating: p.rating || null,
    location: p.geometry?.location
  }));

  // compute distances and reasoning
  for (const r of results) {
    r.distanceM = r.location ? Math.round(distanceMeters(center, r.location)) : null;
  }

  // Choose labels
  const byDistance = [...results].filter(r => r.distanceM != null).sort((a,b)=>a.distanceM-b.distanceM);
  const byRating = [...results].filter(r => r.rating != null).sort((a,b)=>b.rating-a.rating);

  const closestId = byDistance[0]?.placeId;
  const bestId = byRating[0]?.placeId;

  return results.map(r => {
    let tag = 'balanced pick';
    if (r.placeId === closestId) tag = 'closest';
    if (r.placeId === bestId) tag = (tag === 'closest') ? 'closest & best rated' : 'best rated';
    return { ...r, tag };
  });
}

// -------------------- OpenAI helpers --------------------
function sysPrompt(lang, user) {
  const langName = LANG_MAP[lang] || 'English';
  const triageText = {
    en: `You are a friendly clinic-booking assistant. Do NOT give medical advice or diagnoses. Collect: full name, symptoms, ZIP (5 digits), insurance Y/N, preferred date and time. If user says ASAP, record ASAP. Confirm summary before searching.`,
    es: `Eres un asistente amable para reservar citas médicas. No des consejos médicos ni diagnósticos. Reúne: nombre completo, síntomas, código postal (5 dígitos), seguro S/N, fecha y hora preferidas. Si el usuario dice ASAP o “lo antes posible”, regístralo. Confirma el resumen antes de buscar.`,
    fr: `Assistant amical de prise de rendez-vous. Pas de conseils médicaux ni de diagnostics. Recueille : nom complet, symptômes, code postal (5 chiffres), assurance O/N, date et heure préférées. Si la personne dit « ASAP », note-le. Confirme le récapitulatif avant la recherche.`,
    pt: `Assistente amigável para marcar consultas. Não forneça conselhos médicos/diagnósticos. Reúna: nome completo, sintomas, CEP (5 dígitos), seguro S/N, data e hora preferidas. Se o usuário disser ASAP, registre. Confirme o resumo antes de pesquisar.`
  }[lang] || triageTextEn;

  return [
    { role: 'system', content: `${triageText} Speak in ${langName}.` },
    ...(user?.history || [])
  ];
}

async function llmReply(lang, history) {
  const messages = sysPrompt(lang, { history });
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages
  });
  return resp.choices?.[0]?.message?.content?.trim() || '';
}

// -------------------- Keep Alive --------------------
if (KEEP_ALIVE === 'true') {
  const ms = num(KEEP_ALIVE_MS, 300000);
  setInterval(() => {
    fetch(`${PUBLIC_BASE_URL}/healthz`).catch(()=>{});
  }, ms);
}

// -------------------- Health --------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: BRAND_NAME, at: new Date().toISOString() });
});

// -------------------- Chat API --------------------
// POST /chat
// { from, text, lang?, intent? }
// Maintains a small server-side session and returns: { reply, state }
app.post('/chat', async (req, res) => {
  try {
    // Basic anti-spam
    if (!consumeToken(req)) {
      return res.status(429).json({ ok: false, reply: 'Too many messages — please wait a minute and try again.' });
    }

    const from = safeStr(req.body.from) || uuidv4();
    const text = safeStr(req.body.text);
    const lang = normalizeLang(req.body.lang || 'en');

    if (!text) return res.json({ ok: true, reply: '' });

    // init session
    const s = chatSessions.get(from) || {
      lang,
      createdAt: Date.now(),
      stage: 'intro',
      patient: { fullName: '', zip: '', insuranceY: null, dateStr: '', timeStr: '', asap: false, symptoms: '', usualClinics: [] },
      history: [],
      clinics: [],
      chosen: null
    };
    s.lang = lang;
    s.history.push({ role: 'user', content: text });

    // stage machine
    const send = (reply) => {
      s.history.push({ role: 'assistant', content: reply });
      chatSessions.set(from, s);
      return res.json({ ok: true, reply, state: { stage: s.stage, patient: s.patient, clinics: s.clinics, chosen: s.chosen } });
    };

    // Language-specific small snippets
    const prompts = {
      askName: { en: 'What is the patient’s full name? (First Last)', es: '¿Cuál es el nombre completo del paciente? (Nombre Apellido)', fr: 'Quel est le nom complet du patient ? (Prénom Nom)', pt: 'Qual é o nome completo do paciente? (Nome Sobrenome)'},
      askSymptoms: { en: 'What’s the reason for the visit? (brief)', es: '¿Cuál es el motivo de la visita? (breve)', fr: 'Quelle est la raison de la visite ? (bref)', pt: 'Qual é o motivo da consulta? (breve)'},
      askZip: { en: 'What ZIP code should I search near? (5 digits)', es: '¿Qué código postal debo buscar cerca? (5 dígitos)', fr: 'Quel code postal dois-je utiliser pour la recherche ? (5 chiffres)', pt: 'Qual CEP devo procurar por perto? (5 dígitos)'},
      askIns: { en: 'Do you have insurance? (Y/N)', es: '¿Tiene seguro médico? (S/N)', fr: 'Avez-vous une assurance ? (O/N)', pt: 'Você tem plano de saúde? (S/N)'},
      askDate: { en: 'What date works best? (MM/DD/YYYY). You can also say ASAP.', es: '¿Qué fecha funciona mejor? (MM/DD/AAAA). También puede decir ASAP.', fr: 'Quelle date vous convient le mieux ? (MM/JJ/AAAA). Vous pouvez aussi dire ASAP.', pt: 'Qual data funciona melhor? (MM/DD/AAAA). Você também pode dizer ASAP.'},
      askTime: { en: 'Preferred time? (e.g., 10:30 AM). You can also say ASAP.', es: '¿Hora preferida? (p. ej., 10:30 AM). También puede decir ASAP.', fr: 'Heure préférée ? (ex. 10:30). Vous pouvez aussi dire ASAP.', pt: 'Horário preferido? (ex.: 10:30 AM). Você também pode dizer ASAP.'},
      confirm: { en: (p) => `Confirm: ${p.fullName} — “${p.symptoms}” near ${p.zip}${p.asap ? ' ASAP' : ` on ${p.dateStr} at ${p.timeStr}`}. Reply YES to continue or NO to edit.`, 
                 es: (p) => `Confirmar: ${p.fullName} — “${p.symptoms}” cerca de ${p.zip}${p.asap ? ' ASAP' : ` el ${p.dateStr} a las ${p.timeStr}`}. Responda SÍ para continuar o NO para editar.`,
                 fr: (p) => `Confirmer : ${p.fullName} — “${p.symptoms}” près de ${p.zip}${p.asap ? ' ASAP' : ` le ${p.dateStr} à ${p.timeStr}`}. Répondez OUI pour continuer ou NON pour modifier.`,
                 pt: (p) => `Confirmar: ${p.fullName} — “${p.symptoms}” perto de ${p.zip}${p.asap ? ' ASAP' : ` em ${p.dateStr} às ${p.timeStr}`}. Responda SIM para continuar ou NÃO para editar.`}
    };

    // Field capture in order
    if (s.stage === 'intro') {
      s.stage = 'name';
      return send(prompts.askName[lang]);
    }

    if (s.stage === 'name') {
      s.patient.fullName = text;
      s.stage = 'symptoms';
      return send(prompts.askSymptoms[lang]);
    }

    if (s.stage === 'symptoms') {
      s.patient.symptoms = text;
      const tri = triageLevel(text);
      s.patient.triage = tri;
      s.stage = 'zip';
      const triNote = tri.level === 'self_care'
        ? { en: 'FYI: These may improve with rest/OTC care. If symptoms worsen or persist, seek a clinic.', es: 'Aviso: Estos pueden mejorar con descanso/cuidado OTC. Si empeoran o persisten, busque una clínica.', fr: 'À savoir : Cela peut s’améliorer avec du repos/OTC. Si cela s’aggrave ou persiste, consultez.', pt: 'Obs.: Pode melhorar com repouso/cuidados OTC. Se piorar ou persistir, procure uma clínica.' }[lang]
        : tri.level === 'emergency'
          ? { en: 'Potential emergency indicators — consider contacting local emergency services.', es: 'Posibles señales de emergencia — considere contactar servicios de emergencia.', fr: 'Signes potentiels d’urgence — envisagez de contacter les urgences.', pt: 'Possíveis sinais de emergência — considere contatar serviços de emergência.' }[lang]
          : '';
      const reply = triNote ? `${triNote}\n\n${prompts.askZip[lang]}` : prompts.askZip[lang];
      return send(reply);
    }

    if (s.stage === 'zip') {
      s.patient.zip = text.match(/\d{5}/)?.[0] || '';
      if (!s.patient.zip) return send(prompts.askZip[lang]);
      s.stage = 'insurance';
      return send(prompts.askIns[lang]);
    }

    if (s.stage === 'insurance') {
      s.patient.insuranceY = toBool(text);
      s.stage = 'date';
      return send(prompts.askDate[lang]);
    }

    if (s.stage === 'date') {
      // ASAP?
      if (detectASAP(text)) {
        s.patient.asap = true;
        s.patient.dateStr = '';
        s.stage = 'time';
        return send(prompts.askTime[lang]);
      }
      const parsed = chrono.parseDate(text, new Date());
      if (!parsed) return send(prompts.askDate[lang]);
      s.patient.dateStr = DateTime.fromJSDate(parsed).toFormat('MM/dd/yyyy');
      s.stage = 'time';
      return send(prompts.askTime[lang]);
    }

    if (s.stage === 'time') {
      if (detectASAP(text)) {
        s.patient.asap = true;
        s.patient.timeStr = '';
      } else {
        const parsed = chrono.parseDate(text, new Date());
        if (!parsed) return send(prompts.askTime[lang]);
        s.patient.timeStr = DateTime.fromJSDate(parsed).toFormat('h:mm a');
      }
      s.stage = 'confirm';
      return send(prompts.confirm[lang](s.patient));
    }

    if (s.stage === 'confirm') {
      if (/^(y|yes|si|sí|oui|sim)$/i.test(text)) {
        // search clinics
        const specialty = inferSpecialty(s.patient.symptoms);
        const clinics = await findClinics(s.patient.zip, specialty);

        s.clinics = clinics.map(c => ({
          name: c.name,
          address: c.address,
          rating: c.rating,
          distanceM: c.distanceM,
          tag: c.tag
        }));

        if (!s.clinics.length) {
          s.stage = 'confirm';
          return send({ en: 'No clinics found nearby. Try a different ZIP.', es: 'No se encontraron clínicas cercanas. Pruebe con otro código postal.', fr: 'Aucune clinique trouvée à proximité. Essayez un autre code postal.', pt: 'Nenhuma clínica encontrada por perto. Tente outro CEP.' }[lang]);
        }

        // reasoning message
        const bestLines = s.clinics.slice(0, 4).map((c, i) => {
          const d = c.distanceM != null ? `${Math.round(c.distanceM/1609)} mi` : '—';
          const r = c.rating != null ? `${c.rating.toFixed(1)}★` : '—';
          return `${i+1}. ${c.name} — ${c.address} [${d}, ${r}] (${c.tag})`;
        }).join('\n');

        s.stage = 'choose';
        const chooseMsg = {
          en: `Based on your symptoms I looked for ${specialty}. Here are good options:\n${bestLines}\n\nReply 1-4 to pick, or type NEXT for more.`,
          es: `Según sus síntomas busqué ${specialty}. Opciones:\n${bestLines}\n\nResponda 1-4 para elegir, o escriba NEXT para más.`,
          fr: `Selon vos symptômes, j’ai cherché ${specialty}. Options :\n${bestLines}\n\nRépondez 1-4 pour choisir, ou tapez NEXT pour plus.`,
          pt: `Com base nos seus sintomas procurei ${specialty}. Opções:\n${bestLines}\n\nResponda 1-4 para escolher, ou digite NEXT para mais.`
        }[lang];

        return send(chooseMsg);
      } else {
        // simple edit loop: restart at name
        s.stage = 'name';
        return send(prompts.askName[lang]);
      }
    }

    if (s.stage === 'choose') {
      if (/^next$/i.test(text)) {
        // nothing fancy here—already returned top 4; in a fuller build we would paginate
        return send({ en: 'More results not implemented yet. Please reply 1-4.', es: 'Más resultados no implementados aún. Responda 1-4.', fr: 'Plus de résultats non implémentés. Répondez 1-4.', pt: 'Mais resultados ainda não implementados. Responda 1-4.' }[lang]);
      }
      const pick = Number(text);
      if (!Number.isInteger(pick) || pick < 1 || pick > Math.min(4, s.clinics.length)) {
        return send({ en: 'Please reply 1-4 to choose.', es: 'Responda 1-4 para elegir.', fr: 'Répondez 1-4 pour choisir.', pt: 'Responda 1-4 para escolher.' }[lang]);
      }
      s.chosen = s.clinics[pick - 1];

      // If you want to call the clinic now via Twilio, you’d plug it here once you store phone numbers via Place Details API.
      const msg = {
        en: `Great — I’ll try ${s.chosen.name}. I’ll book ${s.patient.asap ? 'the earliest available time' : `${s.patient.dateStr} at ${s.patient.timeStr}`}. I’ll text you the result.`,
        es: `Perfecto — Intentaré con ${s.chosen.name}. Reservaré ${s.patient.asap ? 'la hora más próxima disponible' : `${s.patient.dateStr} a las ${s.patient.timeStr}`}. Le avisaré por mensaje.`,
        fr: `Parfait — Je vais tenter ${s.chosen.name}. Je réserverai ${s.patient.asap ? 'le premier créneau disponible' : `${s.patient.dateStr} à ${s.patient.timeStr}`}. Je vous informe par message.`,
        pt: `Perfeito — Vou tentar ${s.chosen.name}. Vou marcar ${s.patient.asap ? 'o primeiro horário disponível' : `${s.patient.dateStr} às ${s.patient.timeStr}`}. Avisarei por SMS.`
      }[lang];

      s.stage = 'done';
      return send(msg);
    }

    // done fallback -> continue chit-chat via LLM in the selected language
    const llm = await llmReply(lang, s.history.slice(-8)); // keep short
    return send(llm || { en: 'All set.', es: 'Listo.', fr: 'C’est bon.', pt: 'Tudo certo.' }[lang]);

  } catch (err) {
    console.error('[CHAT]', err);
    return res.status(500).json({ ok: false, reply: 'Server error.' });
  }
});

// -------------------- Twilio Voice (unchanged core) --------------------
async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  const call = await twilio.calls.create({
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
    startedAt: Date.now(),
    onHoldSince: null
  });

  lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}

app.post('/call', async (req, res) => {
  try {
    const params = {
      to: req.body.to || req.body.clinicPhone,
      name: req.body.name,
      reason: req.body.reason,
      preferredTimes: Array.isArray(req.body.preferredTimes) ? req.body.preferredTimes : [],
      clinicName: req.body.clinicName || '',
      callback: req.body.callback || ''
    };
    if (!params.to) throw new Error('Required parameter "params[\'to\']" missing.');
    const callSid = await startClinicCall(params);
    return res.json({ ok: true, callSid });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/voice', async (req, res) => {
  const { twiml } = twilioPkg;
  const vr = new twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid);
  if (!session) {
    vr.say({ voice: TTS_VOICE }, 'Context missing. Goodbye.');
    vr.hangup();
    return res.type('text/xml').send(vr.toString());
  }
  const firstLine = `Hi, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. I’m calling to book an appointment for ${session.userRequest.name}. ${session.userRequest.reason ? 'Reason: ' + session.userRequest.reason + '. ' : ''} Do you have availability ${session.userRequest.preferredTimes[0] || 'this week'}?`;
  session.transcript.push({ from: 'ai', text: firstLine });
  vr.say({ voice: TTS_VOICE }, firstLine);
  const g = vr.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto' });
  g.say({ voice: TTS_VOICE }, 'I can wait for your available times.');
  return res.type('text/xml').send(vr.toString());
});

app.post('/gather', async (req, res) => {
  const { twiml } = twilioPkg;
  const vr = new twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = safeStr(req.body.SpeechResult);
  const session = sessions.get(callSid);
  if (!session) {
    vr.say({ voice: TTS_VOICE }, 'Context missing. Goodbye.');
    vr.hangup();
    return res.type('text/xml').send(vr.toString());
  }

  const elapsed = Date.now() - session.startedAt;
  if (elapsed > MAX_CALL_MS) {
    vr.say({ voice: TTS_VOICE }, 'I need to wrap up here and will follow up by text. Thank you.');
    vr.hangup();
    try { await twilio.messages.create({
      to: session.userRequest.callback, from: TWILIO_CALLER_ID,
      body: 'Clinic line was long. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.'
    }); } catch {}
    return res.type('text/xml').send(vr.toString());
  }

  if (speech) session.transcript.push({ from: 'rx', text: speech });
  const lower = speech.toLowerCase();

  // hold detection
  if (/\b(please hold|hold on|one moment|just a moment|put you on hold)\b/i.test(lower)) {
    if (!session.onHoldSince) session.onHoldSince = Date.now();
    if (Date.now() - session.onHoldSince > MAX_HOLD_MS) {
      vr.say({ voice: TTS_VOICE }, 'I’ll follow up later. Thank you.');
      vr.hangup();
      try {
        await twilio.messages.create({
          to: session.userRequest.callback, from: TWILIO_CALLER_ID,
          body: 'Clinic kept us on hold too long. Reply NOW/RETRY to call again, or WAIT 5 / WAIT 15 / CANCEL.'
        });
      } catch {}
      return res.type('text/xml').send(vr.toString());
    }
    vr.say({ voice: TTS_VOICE }, 'Sure, I can hold.');
    vr.pause({ length: 15 });
    const g = vr.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    g.say({ voice: TTS_VOICE }, 'I’m still here.');
    return res.type('text/xml').send(vr.toString());
  } else if (session.onHoldSince) {
    session.onHoldSince = null;
  }

  // time intent / confirmation
  let intent = 'other';
  if (/\b(yes|yeah|works|ok|sure|confirmed)\b/i.test(lower)) intent = 'yes';
  else if (/\b(no|cannot|unavailable)\b/i.test(lower)) intent = 'no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next|am|pm|\d{1,2}(:\d{2})?)\b/i.test(lower)) intent = 'time';

  if (intent === 'time') {
    const parsed = chrono.parseDate(speech, new Date());
    const clean = parsed
      ? parsed.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : speech;
    session.confirmed = { time: clean };
    const line = `Great, I have ${clean} for patient ${session.userRequest.name}. Please confirm.`;
    session.transcript.push({ from: 'ai', text: line });
    vr.say({ voice: TTS_VOICE }, line);
    vr.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(vr.toString());
  }

  if (intent === 'yes' && session.confirmed?.time) {
    const thanks = `Perfect, thank you. Please note the patient name ${session.userRequest.name}. Have a great day.`;
    session.status = 'confirmed';
    session.transcript.push({ from: 'ai', text: thanks });
    vr.say({ voice: TTS_VOICE }, thanks);
    vr.hangup();
    try {
      await twilio.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `✅ Confirmed: ${session.confirmed.time} at ${session.userRequest.clinicName}.`
      });
    } catch {}
    return res.type('text/xml').send(vr.toString());
  }

  if (intent === 'no') {
    const retry = 'No problem. Do you have another available time—morning or afternoon works too?';
    session.transcript.push({ from: 'ai', text: retry });
    vr.say({ voice: TTS_VOICE }, retry);
    vr.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(vr.toString());
  }

  // polite repeat
  session.transcript.push({ from: 'ai', text: "I didn't catch that. Could you share an available day and time?" });
  vr.say({ voice: TTS_VOICE }, "I didn't catch that. Could you share an available day and time?");
  const g2 = vr.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
  g2.say({ voice: TTS_VOICE }, 'I’m listening.');
  return res.type('text/xml').send(vr.toString());
});

app.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const status = (req.body.CallStatus || '').toLowerCase();
  const session = sessions.get(callSid);
  if (!session) return res.sendStatus(200);

  if (status === 'completed' && session.status !== 'confirmed') {
    try {
      await twilio.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: 'The clinic ended the call before we could confirm. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.'
      });
    } catch {}
  }
  if (/(failed|busy|no-answer|canceled)/i.test(status)) {
    try {
      await twilio.messages.create({
        to: session.userRequest.callback, from: TWILIO_CALLER_ID,
        body: `Call didn’t go through (${status}). Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.`
      });
    } catch {}
  }
  return res.sendStatus(200);
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`${BRAND_NAME} listening on ${PORT}`);
});
