import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import twilioPkg from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';

/* ----------------- ENV ----------------- */
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
  TTS_VOICE = 'Polly.Joanna-Neural',
  KEEPALIVE_URL // optional
} = process.env;

/* ----------------- CLIENTS ----------------- */
const app = express();
const client = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const mapsClient = new GoogleMapsClient({});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(
  cors({
    origin: [/\.vercel\.app$/i, 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: false
  })
);

/* ----------------- HEALTH / KEEP-ALIVE ----------------- */
app.get('/healthz', (_req, res) => res.json({ ok: true, brand: BRAND_NAME, ts: Date.now() }));
if (KEEPALIVE_URL) {
  setInterval(() => {
    // Node 18+ has global fetch
    fetch(KEEPALIVE_URL).catch(() => {});
  }, 4 * 60 * 1000);
}

/* ----------------- SMALL UTILITIES ----------------- */
const nameLFRe = /^\s*([A-Za-zÀ-ÿ'.\- ]+)\s*,\s*([A-Za-zÀ-ÿ'.\- ]+)\s*$/;
const nameStdRe = /^\s*([A-Za-zÀ-ÿ'.\- ]+)\s+([A-Za-zÀ-ÿ'.\- ]+)\s*$/;
const zipRe = /^\d{5}$/;
const ynRe = /^(y|yes|n|no|s|si|sí|oui|non|sim|nao|não)$/i;
const timeRe = /^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i;
const dateRe = /^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/;

const isValidZip = s => zipRe.test((s || '').trim());
const isValidYN = s => ynRe.test((s || '').trim());
const ynToBool = s => /^(y|yes|s|si|sí|oui|sim)$/i.test(s || '');
const isValidTime = s => timeRe.test((s || '').trim());
const isValidDate = s => dateRe.test((s || '').trim());

const parseNameFirstLast = s => {
  const m = (s || '').match(nameStdRe);
  if (!m) return null;
  return { first: m[1].trim(), last: m[2].trim(), full: `${m[1].trim()} ${m[2].trim()}` };
};
const parseNameLastFirst = s => {
  const m = (s || '').match(nameLFRe);
  if (!m) return null;
  return { last: m[1].trim(), first: m[2].trim(), full: `${m[2].trim()} ${m[1].trim()}` };
};
const cleanUSPhone = s => {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
};
function milesBetween(a, b) {
  if (!a || !b) return null;
  const toRad = d => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ----------------- LANG (EN, ES, PT, FR) ----------------- */
const SUPPORTED = ['en', 'es', 'pt', 'fr'];
const L = {
  en: {
    start_name: "Great, let's get you booked.\nWhat’s your full name? (First Last)",
    ask_symptoms: 'Thanks, {first}. What brings you in (symptoms)?',
    ask_zip: 'What ZIP code should I search near?',
    ask_ins: 'Do you have insurance? (Y/N)',
    ask_preferred:
      'What’s your preferred date and time? (MM/DD/YYYY, HH:MM AM/PM)\nYou can also say “tomorrow morning” or “ASAP”.',
    bad_zip: 'Please share a 5-digit US ZIP code.',
    bad_ins: 'Please reply Y or N for insurance.',
    bad_dt:
      'I couldn’t read that date/time. Try 10/25/2025, 10:30 AM — or say “tomorrow morning” or “ASAP”.',
    cant_find: 'I couldn’t find clinics nearby. What ZIP should I search near?',
    list_intro:
      'I found nearby options. Pick one or reply NEXT to see more.\nPreferred: {date} {time}',
    confirm_menu:
      'Reply YES to proceed, NEXT for another, a number 1–6 to pick, or NO to change the time.',
    selected: 'Selected: {name}. Reply YES to proceed, NEXT for another, or NO to change time.',
    selected_explain: 'Based on your symptoms, I recommend {name} because {why}.',
    next_card: 'Next: {name}{address}. YES to use, NEXT again, or pick 1–6.',
    need_phone:
      'Great — to place the call and text your confirmation, what’s the best phone for updates? (e.g., 555-123-4567)',
    bad_phone: 'I couldn’t read that. Share a US number like 555-123-4567.',
    calling:
      'Calling {clinic} now to book {when}. I’ll text you at {phone} with the result.',
    no_phone_on_clinic:
      'Heads up — {clinic} has no public phone number. Choose another clinic (1–6) or type NEXT.',
    help:
      'I’ll ask your name, symptoms, ZIP, insurance (Y/N), and preferred date & time. Then I’ll show nearby clinics with reasons and call to book.\nType HOME to restart.',
    home_reset: 'Okay, starting fresh.',
    asap_ack:
      'Got it — I’ll look for the earliest available appointment. Pick one or reply NEXT.',
    couldnt_place_call:
      'Couldn’t place the call just now ({err}). Type YES to retry or HOME to restart.'
  },
  es: {
    start_name: 'Genial, vamos a reservar.\n¿Cuál es tu nombre completo? (Nombre Apellido)',
    ask_symptoms: 'Gracias, {first}. ¿Qué te ocurre (síntomas)?',
    ask_zip: '¿Cuál es el código postal donde debo buscar?',
    ask_ins: '¿Tienes seguro médico? (S/N)',
    ask_preferred:
      '¿Cuál es tu fecha y hora preferidas? (MM/DD/AAAA, HH:MM AM/PM)\nTambién puedes decir “mañana por la mañana” o “LO ANTES POSIBLE”.',
    bad_zip: 'Comparte un código postal de 5 dígitos en EE. UU.',
    bad_ins: 'Responde S o N para el seguro.',
    bad_dt:
      'No pude leer la fecha/hora. Intenta: 10/25/2025, 10:30 AM — o di “mañana por la mañana” o “LO ANTES POSIBLE”.',
    cant_find: 'No encontré clínicas cercanas. ¿Qué código postal debo usar?',
    list_intro:
      'Encontré opciones cercanas. Elige una o responde NEXT para ver más.\nPreferencia: {date} {time}',
    confirm_menu:
      'Responde YES para continuar, NEXT para otra, un número 1–6 para elegir, o NO para cambiar la hora.',
    selected:
      'Seleccionado: {name}. Responde YES para continuar, NEXT para otra, o NO para cambiar hora.',
    selected_explain: 'Según tus síntomas, recomiendo {name} porque {why}.',
    next_card:
      'Siguiente: {name}{address}. Escribe YES para usarla, NEXT otra vez, o elige del 1 al 6.',
    need_phone:
      'Perfecto. Para llamar y enviarte la confirmación por SMS, ¿cuál es tu número? (ej., 555-123-4567)',
    bad_phone: 'No pude leerlo. Comparte un número de EE. UU., por ejemplo 555-123-4567.',
    calling:
      'Llamando a {clinic} para reservar {when}. Te enviaré SMS al {phone} con el resultado.',
    no_phone_on_clinic:
      'Ojo — {clinic} no tiene teléfono público. Elige otra (1–6) o escribe NEXT.',
    help:
      'Pediré nombre, síntomas, código postal, seguro (S/N) y fecha/hora. Luego mostraré clínicas y llamaré para reservar.\nEscribe HOME para reiniciar.',
    home_reset: 'Listo, comenzamos de nuevo.',
    asap_ack:
      'Perfecto, buscaré la cita más próxima disponible. Elige una o responde NEXT.',
    couldnt_place_call:
      'No pude realizar la llamada ahora ({err}). Escribe YES para reintentar o HOME para reiniciar.'
  },
  pt: {
    start_name:
      'Ótimo, vamos agendar.\nQual é o seu nome completo? (Nome Sobrenome)',
    ask_symptoms: 'Obrigado, {first}. Quais são os seus sintomas?',
    ask_zip: 'Qual CEP devo usar para a busca?',
    ask_ins: 'Você tem convênio/seguro? (S/N)',
    ask_preferred:
      'Qual data e hora prefere? (MM/DD/AAAA, HH:MM AM/PM)\nVocê também pode dizer “amanhã de manhã” ou “O QUANTO ANTES”.',
    bad_zip: 'Informe um CEP dos EUA com 5 dígitos.',
    bad_ins: 'Responda S ou N para o seguro.',
    bad_dt:
      'Não consegui ler a data/hora. Tente 10/25/2025, 10:30 AM — ou diga “amanhã de manhã” ou “O QUANTO ANTES”.',
    cant_find: 'Não encontrei clínicas próximas. Qual CEP devo usar?',
    list_intro:
      'Encontrei opções próximas. Escolha uma ou responda NEXT para ver mais.\nPreferência: {date} {time}',
    confirm_menu:
      'Responda YES para continuar, NEXT para outra, um número 1–6 para escolher, ou NO para alterar o horário.',
    selected:
      'Selecionada: {name}. Responda YES para continuar, NEXT para outra, ou NO para alterar.',
    selected_explain: 'Pelos seus sintomas, recomendo {name} porque {why}.',
    next_card:
      'Próxima: {name}{address}. Digite YES para usar, NEXT novamente, ou escolha 1–6.',
    need_phone:
      'Perfeito — para ligar e confirmar por SMS, qual é o seu telefone? (ex.: 555-123-4567)',
    bad_phone: 'Não consegui ler. Compartilhe um número dos EUA, como 555-123-4567.',
    calling:
      'Ligando para {clinic} para agendar {when}. Avisarei por SMS em {phone}.',
    no_phone_on_clinic:
      'Atenção — {clinic} não possui telefone público. Escolha outra (1–6) ou digite NEXT.',
    help:
      'Vou pedir nome, sintomas, CEP, seguro (S/N) e data/hora preferidas. Depois mostro clínicas próximas e ligo para agendar.\nDigite HOME para reiniciar.',
    home_reset: 'Certo, começando de novo.',
    asap_ack:
      'Entendido — buscarei o horário mais cedo disponível. Escolha uma ou responda NEXT.',
    couldnt_place_call:
      'Não consegui ligar agora ({err}). Digite YES para tentar novamente ou HOME para reiniciar.'
  },
  fr: {
    start_name:
      'Parfait, procédons à la réservation.\nQuel est votre nom complet ? (Prénom Nom)',
    ask_symptoms: 'Merci, {first}. Quels sont vos symptômes ?',
    ask_zip: 'Quel code postal dois-je utiliser pour la recherche ?',
    ask_ins: 'Avez-vous une assurance ? (O/N)',
    ask_preferred:
      'Quelle date et heure préférez-vous ? (MM/JJ/AAAA, HH:MM AM/PM)\nVous pouvez aussi dire « demain matin » ou « AU PLUS VITE ».',
    bad_zip: 'Indiquez un code postal américain à 5 chiffres.',
    bad_ins: 'Répondez O (oui) ou N (non) pour l’assurance.',
    bad_dt:
      'Je n’ai pas compris la date/heure. Essayez 10/25/2025, 10:30 AM — ou dites « demain matin » ou « AU PLUS VITE ».',
    cant_find: 'Je ne trouve pas de cliniques proches. Quel code postal dois-je utiliser ?',
    list_intro:
      'Voici des options proches. Choisissez-en une ou tapez NEXT pour en voir d’autres.\nPréférence : {date} {time}',
    confirm_menu:
      'Tapez YES pour continuer, NEXT pour une autre, un numéro 1–6 pour choisir, ou NO pour changer l’horaire.',
    selected:
      'Sélectionné : {name}. YES pour continuer, NEXT pour une autre, ou NO pour changer.',
    selected_explain: 'Selon vos symptômes, je recommande {name} car {why}.',
    next_card:
      'Suivante : {name}{address}. YES pour choisir, NEXT encore, ou 1–6.',
    need_phone:
      'Parfait — pour appeler et vous envoyer la confirmation par SMS, quel est votre numéro ? (ex. : 555-123-4567)',
    bad_phone: 'Je n’ai pas compris. Indiquez un numéro américain, ex. 555-123-4567.',
    calling:
      'J’appelle {clinic} pour réserver {when}. Je vous enverrai un SMS au {phone}.',
    no_phone_on_clinic:
      '{clinic} n’a pas de numéro public. Choisissez une autre (1–6) ou tapez NEXT.',
    help:
      'Je demanderai votre nom, symptômes, code postal, assurance (O/N) et date/heure. Ensuite je propose des cliniques et j’appelle pour réserver.\nTapez HOME pour recommencer.',
    home_reset: 'Très bien, on recommence.',
    asap_ack:
      'Compris — je cherche le premier créneau disponible. Choisissez ou tapez NEXT.',
    couldnt_place_call:
      'Impossible d’appeler maintenant ({err}). Tapez YES pour réessayer ou HOME pour recommencer.'
  }
};
function t(lang, key, vars = {}) {
  const pack = L[SUPPORTED.includes(lang) ? lang : 'en'];
  let s = pack[key] || L.en[key] || key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v ?? '');
  return s;
}
function tagLabel(lang, tag) {
  const map = {
    en: { 'closest': 'closest', 'open now': 'open now', 'low cost': 'low cost' },
    es: { 'closest': 'más cerca', 'open now': 'abierto ahora', 'low cost': 'bajo costo' },
    pt: { 'closest': 'mais perto', 'open now': 'aberto agora', 'low cost': 'baixo custo' },
    fr: { 'closest': 'le plus proche', 'open now': 'ouvert', 'low cost': 'à faible coût' }
  };
  const pack = map[SUPPORTED.includes(lang) ? lang : 'en'];
  return pack[tag] || tag;
}
function isASAP(text = '') {
  const s = text.trim().toLowerCase();
  const rx = [
    /(asap|soonest|earliest|first available|next available|as soon as possible)/,
    /(lo antes posible|lo más pronto posible|proxima disponible|próxima disponible|cuanto antes)/,
    /(o quanto antes|o mais cedo|próximo disponível|proximo disponivel)/,
    /(au plus vite|le plus tôt possible|prochain créneau|prochain disponible)/
  ];
  return rx.some(r => r.test(s));
}

/* ----------- TRIAGE ----------- */
function normalizeSymptoms(text = '') {
  let s = text.toLowerCase();
  if (/\bballs?\b/.test(s)) s = s.replace(/\bheart\b/g, 'hurt'); // “my balls heart” fix
  return s;
}
function analyzeSymptoms(text = '', patientName = 'the patient') {
  const s = normalizeSymptoms(text);
  const urology = /\b(testicle|testicular|scrotum|groin|penis|erectile|prostate|balls?)\b/;
  const obgyn = /\b(vagina|pregnan|uter(us|ine)|ovar(y|ian)|cervix|ob[-\s]?gyn|gyneco|gynéc)\b/;
  if (urology.test(s) && !obgyn.test(s))
    return { specialty: 'urologist', reason: `genital/testicular terms → urology for ${patientName}` };
  if (obgyn.test(s) && !urology.test(s))
    return { specialty: 'ob-gyn', reason: 'gynecologic terms → OB/GYN' };
  if (/\b(chest pain|angina|palpit|cardio)\b/.test(s))
    return { specialty: 'cardiologist', reason: 'heart/chest terms detected' };
  if (/\b(throat|ear|nose|sinus|tonsil)\b/.test(s))
    return { specialty: 'otolaryngologist', reason: 'ENT terms detected' };
  if (/\b(skin|rash|eczema|mole|dermat)\b/.test(s))
    return { specialty: 'dermatologist', reason: 'skin terms detected' };
  return { specialty: 'clinic', reason: 'defaulting to primary/urgent care' };
}

/* ----------- Google Places ----------- */
async function findClinics(zip, specialty = 'clinic', needLowCost = false) {
  try {
    const geo = await mapsClient.geocode({ params: { address: zip, key: GOOGLE_MAPS_API_KEY } });
    if (!geo.data.results?.length) return [];
    const origin = geo.data.results[0].geometry.location;

    const nearby = await mapsClient.placesNearby({
      params: { location: origin, radius: 12000, keyword: specialty, type: 'doctor', key: GOOGLE_MAPS_API_KEY }
    });

    const basics = (nearby.data.results || []).slice(0, 10).map(p => ({
      place_id: p.place_id,
      name: p.name,
      address: p.vicinity || p.formatted_address || '',
      rating: p.rating || null,
      loc: p.geometry?.location || null,
      openNow: p.opening_hours?.open_now ?? null
    }));

    const detailed = [];
    for (const b of basics) {
      try {
        const d = await mapsClient.placeDetails({
          params: {
            place_id: b.place_id,
            fields: [
              'name',
              'formatted_phone_number',
              'international_phone_number',
              'formatted_address',
              'website',
              'opening_hours',
              'types'
            ],
            key: GOOGLE_MAPS_API_KEY
          }
        });
        const r = d.data.result || {};
        const phone = r.international_phone_number || r.formatted_phone_number || null;
        const distanceMiles = b.loc ? Math.round((milesBetween(origin, b.loc) || 0) * 10) / 10 : null;
        const types = r.types || [];
        const likelyLowCost =
          needLowCost || /free|community/i.test(b.name) || types.some(t => /health|community|clinic/.test(t));
        const tags = [];
        if (distanceMiles != null && distanceMiles <= 2.0) tags.push('closest');
        if (b.openNow === true || r.opening_hours?.open_now) tags.push('open now');
        if (likelyLowCost) tags.push('low cost');
        detailed.push({
          name: r.name || b.name,
          address: r.formatted_address || b.address || '',
          rating: b.rating,
          phone,
          website: r.website || null,
          distanceMiles,
          openNow: (b.openNow === true) || (r.opening_hours?.open_now === true) || false,
          tags
        });
      } catch {
        const distanceMiles = b.loc ? Math.round((milesBetween(origin, b.loc) || 0) * 10) / 10 : null;
        const tags = [];
        if (distanceMiles != null && distanceMiles <= 2.0) tags.push('closest');
        if (needLowCost) tags.push('low cost');
        detailed.push({
          name: b.name,
          address: b.address,
          rating: b.rating,
          phone: null,
          website: null,
          distanceMiles,
          openNow: b.openNow === true,
          tags
        });
      }
    }
    detailed.sort(
      (a, b) =>
        (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999) || (b.rating ?? 0) - (a.rating ?? 0)
    );
    return detailed.slice(0, 6);
  } catch (e) {
    console.error('Maps API error:', e.message);
    return [];
  }
}

/* ----------- AI voice helpers ----------- */
const MAX_CALL_MS = 3 * 60 * 1000;
const MAX_HOLD_MS = 90 * 1000;
function buildSystemPrompt(userReq) {
  return `You are a polite clinic-booking assistant. Secure an appointment for:
Name: ${userReq.name || 'Patient'}
Reason: ${userReq.reason || 'Visit'}
Preferred: ${JSON.stringify(userReq.preferredTimes || ['This week'])}
Callback: ${userReq.callback || 'N/A'}

Be brief, confirm details, and ask for documents to bring if applicable.`;
}
async function nextAIUtterance(session) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(session.userRequest) },
    ...session.transcript.slice(-3).map(t => ({ role: t.from === 'ai' ? 'assistant' : 'user', content: t.text }))
  ];
  const r = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.3, messages });
  return r.choices[0].message.content.trim();
}
function speak(twiml, text) { twiml.say({ voice: TTS_VOICE }, text); }

/* ----------- VOICE SESSIONS ----------- */
const sessionsVoice = new Map(); // CallSid -> session
const lastCallByPatient = new Map();
const pendingRetries = new Map();

async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }) {
  if (!to) throw new Error('Required parameter "params[\'to\']" missing.');
  const call = await client.calls.create({
    to,
    from: TWILIO_CALLER_ID,
    url: `${PUBLIC_BASE_URL}/voice`,
    statusCallback: `${PUBLIC_BASE_URL}/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
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
  if (callback) lastCallByPatient.set(callback, { to, name, reason, preferredTimes, clinicName, callback });
  return call.sid;
}
function scheduleRetry(patientNumber, details, delayMs) {
  const existing = pendingRetries.get(patientNumber);
  if (existing) clearTimeout(existing);
  const id = setTimeout(async () => {
    pendingRetries.delete(patientNumber);
    try {
      await startClinicCall(details);
      await client.messages.create({
        to: details.callback,
        from: TWILIO_CALLER_ID,
        body: `Retrying your booking with ${details.clinicName} now.`
      });
    } catch (e) {
      try {
        await client.messages.create({
          to: details.callback,
          from: TWILIO_CALLER_ID,
          body: `Couldn’t retry: ${e.message}. Reply RETRY to try again.`
        });
      } catch {}
    }
  }, delayMs);
  pendingRetries.set(patientNumber, id);
}
function cancelRetry(patientNumber) {
  const t = pendingRetries.get(patientNumber);
  if (t) { clearTimeout(t); pendingRetries.delete(patientNumber); return true; }
  return false;
}

/* ----------- SIMPLE ANTI-SPAM (web chat) ----------- */
const sessionsChat = new Map(); // userId -> state
const userPrefs = new Map();    // userId -> { lang }

const ipRate = new Map();
const userRate = new Map();
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX_PER_IP = 60;
const RL_MAX_PER_USER = 20;
const MIN_SECONDS_BETWEEN_MSG = 1.2;
const MSG_MAX_CHARS = 600;
const BLOCKLIST = [/terror|porn|casino|api key dump/i];

function withinRate(map, key, max, windowMs) {
  const now = Date.now();
  const e = map.get(key) || { count: 0, start: now };
  if (now - e.start > windowMs) { e.count = 0; e.start = now; }
  e.count += 1; map.set(key, e);
  return e.count <= max;
}
function spamCheck(userId, ip, text) {
  if (!withinRate(ipRate, ip, RL_MAX_PER_IP, RL_WINDOW_MS)) return { ok: false, reason: 'Too many requests from IP.' };
  if (!withinRate(userRate, userId, RL_MAX_PER_USER, RL_WINDOW_MS)) return { ok: false, reason: 'Slow down a bit.' };
  const last = userRate.get(userId) || {};
  if (Date.now() - (last.lastTs || 0) < MIN_SECONDS_BETWEEN_MSG * 1000) return { ok: false, reason: 'Slow down a bit.' };
  if ((text || '').length > MSG_MAX_CHARS) return { ok: false, reason: 'Message too long.' };
  if (BLOCKLIST.some(rx => rx.test(text))) return { ok: false, reason: 'Content blocked.' };
  userRate.set(userId, { ...last, lastTs: Date.now() });
  return { ok: true };
}

/* ----------- WHY STRING ----------- */
function whyForClinic(triage, clinic) {
  const bits = [];
  if (triage?.reason) bits.push(triage.reason);
  if (clinic?.tags?.includes('closest')) bits.push('it is among the closest');
  if (clinic?.tags?.includes('open now')) bits.push('it is open now');
  if (clinic?.tags?.includes('low cost')) bits.push('it may be lower cost');
  return bits.length ? bits.join('; ') : 'it matches your search area and specialty';
}

/* ----------- LANGUAGE SET ENDPOINT ----------- */
app.post('/user/lang', (req, res) => {
  const { userId, lang } = req.body || {};
  if (!userId || !lang) return res.status(400).json({ ok: false, error: 'Missing userId or lang' });
  const picked = SUPPORTED.includes(lang) ? lang : 'en';
  userPrefs.set(userId, { ...(userPrefs.get(userId) || {}), lang: picked });
  return res.json({ ok: true, lang: picked });
});

/* ----------- DEBUG CALL ENDPOINT ----------- */
app.post('/call', async (req, res) => {
  try {
    const to = req.body.clinicPhone || req.body.to;
    const callSid = await startClinicCall({
      to,
      name: req.body.name,
      reason: req.body.reason,
      preferredTimes: req.body.preferredTimes || [],
      clinicName: req.body.clinicName || '',
      callback: req.body.callback || ''
    });
    res.json({ ok: true, callSid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------- VOICE HANDLERS ----------- */
app.post('/voice', async (req, res) => {
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const s = sessionsVoice.get(callSid);
  if (!s) { speak(twiml, 'Context lost. Goodbye.'); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  const name = s.userRequest?.name || 'the patient';
  const line =
    `Hi, this is ${BRAND_NAME}. I’m calling to book for ${name}. ` +
    `${s.userRequest.reason ? `Reason: ${s.userRequest.reason}. ` : ''}` +
    `Do you have availability ${s.userRequest.preferredTimes?.[0] || 'this week'}?`;
  s.transcript.push({ from: 'ai', text: line });
  speak(twiml, line);
  const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto' });
  speak(g, 'I can wait for your available times.');
  res.type('text/xml').send(twiml.toString());
});
app.post('/gather', async (req, res) => {
  const twiml = new twilioPkg.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const s = sessionsVoice.get(callSid);
  if (!s) { speak(twiml, 'Context lost. Goodbye.'); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  if (Date.now() - (s.startedAt || Date.now()) > MAX_CALL_MS) {
    speak(twiml, 'I’ll follow up by text. Thank you!');
    twiml.hangup();
    try {
      if (s.userRequest.callback) {
        await client.messages.create({
          to: s.userRequest.callback, from: TWILIO_CALLER_ID,
          body: 'Line was long. Reply RETRY to try again, or WAIT 5 / WAIT 15.'
        });
      }
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }

  if (speech) s.transcript.push({ from: 'rx', text: speech });
  const lower = speech.toLowerCase();

  if (/\b(please hold|hold on|one moment|put you on hold)\b/i.test(lower)) {
    if (!s.onHoldSince) s.onHoldSince = Date.now();
    if (Date.now() - s.onHoldSince > MAX_HOLD_MS) {
      speak(twiml, 'I’ll follow up later. Thank you!');
      twiml.hangup();
      try {
        if (s.userRequest.callback) {
          await client.messages.create({
            to: s.userRequest.callback, from: TWILIO_CALLER_ID,
            body: 'Hold too long. Reply RETRY to try again, or WAIT 5 / WAIT 15.'
          });
          scheduleRetry(s.userRequest.callback, { ...s.userRequest }, 15 * 60 * 1000);
        }
      } catch {}
      return res.type('text/xml').send(twiml.toString());
    }
    speak(twiml, 'Sure, I can hold.');
    twiml.pause({ length: 15 });
    const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    speak(g, 'I’m still here.');
    return res.type('text/xml').send(twiml.toString());
  } else if (s.onHoldSince) {
    s.onHoldSince = null;
  }

  const saidYes = /\b(yes|yeah|yep|ok|okay|works|sure|confirmed)\b/i.test(lower);
  const saidNo = /\b(no|nope|can’t|cant|unavailable)\b/i.test(lower);
  const mentionedTime =
    /\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow)\b/i.test(lower) ||
    /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/i.test(lower) ||
    /\b(morning|afternoon|evening|noon)\b/i.test(lower);

  if (mentionedTime) {
    const parsed = chrono.parseDate(speech, new Date());
    const clean = parsed
      ? parsed.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : speech;
    s.confirmed = { time: clean };
    const line = `Great. Please confirm ${clean} for ${s.userRequest.name}. Anything the patient should bring?`;
    s.transcript.push({ from: 'ai', text: line });
    speak(twiml, line);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(twiml.toString());
  }
  if (saidYes && s.confirmed?.time) {
    speak(twiml, 'Perfect, thank you. Have a great day.');
    twiml.hangup();
    try {
      if (s.userRequest.callback) {
        await client.messages.create({
          to: s.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: `✅ Confirmed: ${s.confirmed.time} at ${s.userRequest.clinicName}.`
        });
      }
    } catch {}
    return res.type('text/xml').send(twiml.toString());
  }
  if (saidNo) {
    const line = 'No problem. What other day/time works?';
    s.transcript.push({ from: 'ai', text: line });
    speak(twiml, line);
    twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
    return res.type('text/xml').send(twiml.toString());
  }

  let reply = 'Could you share an available day and time?';
  try { reply = await nextAIUtterance(s); } catch {}
  s.transcript.push({ from: 'ai', text: reply });
  speak(twiml, reply);
  const g = twiml.gather({ input: 'speech', action: '/gather', method: 'POST', speechTimeout: 'auto', timeout: 5 });
  speak(g, 'I’m listening.');
  return res.type('text/xml').send(twiml.toString());
});
app.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const status = (req.body.CallStatus || '').toLowerCase();
  const s = sessionsVoice.get(callSid);
  if (!s) return res.sendStatus(200);
  if (status === 'completed' && s.status !== 'confirmed') {
    try {
      if (s.userRequest.callback) {
        await client.messages.create({
          to: s.userRequest.callback,
          from: TWILIO_CALLER_ID,
          body: 'Call ended before confirmation. Reply RETRY to try again.'
        });
      }
    } catch {}
  }
  return res.sendStatus(200);
});

/* ----------- SMS (minimal) ----------- */
app.post('/sms', async (req, res) => {
  const MessagingResponse = twilioPkg.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim().toLowerCase();
  const send = msg => { twiml.message(msg); return res.type('text/xml').send(twiml.toString()); };

  if (/\b(stop|end|unsubscribe|quit|cancel)\b/.test(body)) { cancelRetry(from); return send('You’re opted out. Reply START to opt in.'); }
  if (/\b(start)\b/.test(body)) return send('You’re opted in. Reply HELP for info.');
  if (/\b(help)\b/.test(body)) return send(`${BRAND_NAME}: Msg&data rates apply. Reply STOP to opt out.`);

  if (/\b(retry|now)\b/.test(body)) {
    const details = lastCallByPatient.get(from);
    if (!details?.to) return send('No clinic on file. Start a new request on the website.');
    cancelRetry(from);
    try { await startClinicCall(details); return send(`Calling ${details.clinicName} again now.`); }
    catch { return send('Couldn’t place the call now. Try RETRY again later.'); }
  }
  return send('Thanks! Please use our website chat to start a request.');
});

/* ----------- WEB CHAT API ----------- */
app.post('/app-chat', async (req, res) => {
  const { userId, message, lang: clientLang } = req.body || {};
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'ip:unknown';
  if (!userId || !message) return res.status(400).json({ ok: false, error: 'Missing userId or message' });

  const guard = spamCheck(userId, ip, message);
  if (!guard.ok) return res.status(429).json({ ok: false, error: guard.reason });

  let lang = (userPrefs.get(userId) || {}).lang || 'en';
  if (clientLang && SUPPORTED.includes(clientLang)) {
    lang = clientLang;
    userPrefs.set(userId, { ...(userPrefs.get(userId) || {}), lang });
  }

  const say = (text, extra = {}) => res.json({ ok: true, reply: text, ...extra });

  let s = sessionsChat.get(userId);
  if (/^\s*home\s*$/i.test(message)) { sessionsChat.delete(userId); return say(t(lang, 'home_reset')); }
  if (!s || /^\s*new\s*$/i.test(message)) {
    s = {
      state: 'intake_name',
      lang,
      userPhone: null,
      patientName: null,
      symptoms: null,
      zip: null,
      insuranceY: null,
      dateStr: null,
      timeStr: null,
      asap: false,
      chosenClinic: null,
      clinics: []
    };
    sessionsChat.set(userId, s);
    return say(t(lang, 'start_name'));
  }
  if (/^\s*help\s*$/i.test(message)) return say(t(lang, 'help'));

  if (s.state === 'intake_name') {
    const parsed = parseNameFirstLast(message) || parseNameLastFirst(message);
    if (!parsed) return say("Please share as First Last.");
    s.patientName = `${parsed.first} ${parsed.last}`;
    s.state = 'intake_symptoms';
    return say(t(lang, 'ask_symptoms', { first: parsed.first }));
  }

  if (s.state === 'intake_symptoms') {
    s.symptoms = message.trim();
    s.state = 'intake_zip';
    return say(t(lang, 'ask_zip'));
  }

  if (s.state === 'intake_zip') {
    if (!isValidZip(message)) return say(t(lang, 'bad_zip'));
    s.zip = message.trim();
    s.state = 'intake_insurance';
    return say(t(lang, 'ask_ins'));
  }

  if (s.state === 'intake_insurance') {
    if (!isValidYN(message)) return say(t(lang, 'bad_ins'));
    s.insuranceY = ynToBool(message);
    s.state = 'intake_preferred';
    return say(t(lang, 'ask_preferred'));
  }

  if (s.state === 'intake_preferred') {
    if (isASAP(message)) {
      s.asap = true; s.dateStr = null; s.timeStr = null;
      const triage = analyzeSymptoms(s.symptoms, s.patientName);
      const specialty = s.insuranceY ? triage.specialty : 'free clinic';
      const list = await findClinics(s.zip, specialty, !s.insuranceY);
      s.clinics = list;
      if (!list.length) { s.state = 'intake_zip'; return say(t(lang, 'cant_find')); }
      s.chosenClinic = list[0]; s.state = 'confirm_intake';
      const why = whyForClinic(triage, s.chosenClinic);
      return say(t(lang, 'asap_ack'), {
        triage: { specialty, reason: triage.reason },
        clinics: list.map((c, i) => ({
          id: i + 1,
          name: c.name,
          address: c.address,
          phone: c.phone,
          rating: c.rating,
          distanceMiles: c.distanceMiles,
          openNow: c.openNow,
          tags: c.tags.map(tag => tagLabel(lang, tag))
        })),
        note: t(lang, 'selected_explain', { name: s.chosenClinic.name, why })
      });
    }
    let d = '', tm = '';
    if (/,/.test(message) && isValidDate(message.split(',')[0]) && isValidTime((message.split(',')[1] || '').trim())) {
      d = message.split(',')[0].trim();
      tm = (message.split(',')[1] || '').trim();
    } else {
      const parsed = chrono.parseDate(message);
      if (parsed) {
        d = parsed.toLocaleDateString('en-US');
        tm = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      }
    }
    if (!d || !tm) return say(t(lang, 'bad_dt'));
    s.asap = false; s.dateStr = d; s.timeStr = tm;

    const triage = analyzeSymptoms(s.symptoms, s.patientName);
    const specialty = s.insuranceY ? triage.specialty : 'free clinic';
    const list = await findClinics(s.zip, specialty, !s.insuranceY);
    s.clinics = list;
    if (!list.length) { s.state = 'intake_zip'; return say(t(lang, 'cant_find')); }
    s.chosenClinic = list[0]; s.state = 'confirm_intake';
    const why = whyForClinic(triage, s.chosenClinic);
    return say(
      t(lang, 'list_intro', { date: s.dateStr, time: s.timeStr }) +
        `\n` + t(lang, 'selected_explain', { name: s.chosenClinic.name, why }),
      {
        triage: { specialty, reason: triage.reason },
        clinics: list.map((c, i) => ({
          id: i + 1,
          name: c.name,
          address: c.address,
          phone: c.phone,
          rating: c.rating,
          distanceMiles: c.distanceMiles,
          openNow: c.openNow,
          tags: c.tags.map(tag => tagLabel(lang, tag))
        }))
      }
    );
  }

  if (s.state === 'confirm_intake') {
    const pick = message.match(/^\s*([1-6])\s*$/);
    if (pick && s.clinics[pick[1] - 1]) {
      s.chosenClinic = s.clinics[pick[1] - 1];
      const triage = analyzeSymptoms(s.symptoms, s.patientName);
      const why = whyForClinic(triage, s.chosenClinic);
      return say(t(lang, 'selected', { name: s.chosenClinic.name }) + `\n` + t(lang, 'selected_explain', { name: s.chosenClinic.name, why }));
    }
    if (/^yes\b/i.test(message)) {
      if (!s.userPhone) { s.state = 'await_phone'; return say(t(lang, 'need_phone')); }
      const when = s.asap ? 'the earliest time' : `${s.dateStr} ${s.timeStr}`;
      if (!s.chosenClinic?.phone) return say(t(lang, 'no_phone_on_clinic', { clinic: s.chosenClinic?.name || 'Clinic' }));
      try {
        await startClinicCall({
          to: s.chosenClinic.phone,
          name: s.patientName || 'Patient',
          reason: s.symptoms || 'Visit',
          preferredTimes: [when],
          clinicName: s.chosenClinic.name,
          callback: s.userPhone
        });
        s.state = 'calling';
        return say(t(lang, 'calling', { clinic: s.chosenClinic.name, when, phone: s.userPhone }));
      } catch (e) {
        return say(t(lang, 'couldnt_place_call', { err: e.message }));
      }
    }
    if (/^next\b/i.test(message)) {
      const list = s.clinics || [];
      const idx = list.findIndex(c => c.name === s.chosenClinic?.name);
      const next = list[idx + 1];
      if (!next) return say(t(lang, 'confirm_menu'));
      s.chosenClinic = next;
      const triage = analyzeSymptoms(s.symptoms, s.patientName);
      const why = whyForClinic(triage, s.chosenClinic);
      return say(t(lang, 'next_card', { name: next.name, address: next.address ? ' — ' + next.address : '' }) + `\n` + t(lang, 'selected_explain', { name: next.name, why }));
    }
    if (/^no\b/i.test(message)) { s.state = 'intake_preferred'; return say(t(lang, 'ask_preferred')); }
    return say(t(lang, 'confirm_menu'));
  }

  if (s.state === 'await_phone') {
    const p = cleanUSPhone(message);
    if (!p) return say(t(lang, 'bad_phone'));
    s.userPhone = p;
    const when = s.asap ? 'the earliest time' : `${s.dateStr} ${s.timeStr}`;
    if (!s.chosenClinic?.phone) return say(t(lang, 'no_phone_on_clinic', { clinic: s.chosenClinic?.name || 'Clinic' }));
    try {
      await startClinicCall({
        to: s.chosenClinic.phone,
        name: s.patientName || 'Patient',
        reason: s.symptoms || 'Visit',
        preferredTimes: [when],
        clinicName: s.chosenClinic.name,
        callback: s.userPhone
      });
      s.state = 'calling';
      return say(t(lang, 'calling', { clinic: s.chosenClinic.name, when, phone: s.userPhone }));
    } catch (e) {
      return say(t(lang, 'couldnt_place_call', { err: e.message }));
    }
  }

  if (s.state === 'calling') return say('Working on it. I’ll text you the result. Type HOME to restart.');
  return say('I didn’t understand that. Type HOME to restart.');
});

/* ----------- START SERVER ----------- */
app.listen(PORT, () => console.log(`${BRAND_NAME} listening on ${PORT}`));
