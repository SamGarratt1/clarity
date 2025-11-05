// server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
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
  PORT = 10000,
  BRAND_NAME = 'Clarity Health Concierge',
  BRAND_SLOGAN = 'AI appointment assistant',
  TTS_VOICE = 'Polly.Matthew-Neural',
  KEEPALIVE_URL // optional: set to https://your-render.onrender.com/healthz
} = process.env;

// ---------- Clients ----------
const client = twilioPkg(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const mapsClient = new GoogleMapsClient({});

// ---------- App ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Allow your Vercel frontend + local dev
app.use(cors({
  origin: [
    /\.vercel\.app$/,
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  credentials: false
}));

// ---------- Health / Keep-alive ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, brand: BRAND_NAME, ts: Date.now() }));
app.get('/ping', (_req, res) => res.type('text/plain').send('pong'));
if (KEEPALIVE_URL) {
  setInterval(() => { fetch(KEEPALIVE_URL).catch(()=>{}); }, 4 * 60 * 1000);
}

// ---------- Limits / Safety ----------
const MAX_CALL_MS = 3 * 60 * 1000;
const MAX_HOLD_MS = 90 * 1000;

const DEFAULT_RETRY_MS = 15 * 60 * 1000;
const SHORT_WAIT_MS    = 5  * 60 * 1000;

// ---- In-memory stores ----
const sessionsVoice       = new Map(); // CallSid -> voice session
const smsSessions         = new Map(); // From -> sms state
const lastCallByPatient   = new Map(); // From -> last call details
const pendingRetries      = new Map(); // From -> timer
const sessionsChat        = new Map(); // userId -> chat session
const userUsualClinics    = new Map(); // userId -> {name, phone, address}
const userPrefs           = new Map(); // userId -> { lang: 'en' }

// ---- Basic validation helpers ----
const nameLFRe  = /^\s*([A-Za-z'.\- ]+)\s*,\s*([A-Za-z'.\- ]+)\s*$/; // "Last, First"
const nameStdRe = /^\s*([A-Za-z'.\- ]+)\s+([A-Za-z'.\- ]+)\s*$/;    // "First Last"
const zipRe     = /^\d{5}$/;
const ynRe      = /^(y|yes|n|no|s|si|sí)$/i;
const timeRe    = /^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i;
const dateRe    = /^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/;

const isValidZip  = s => zipRe.test((s||'').trim());
const isValidYN   = s => ynRe.test((s||'').trim());
const ynToBool    = s => /^[ys]/i.test(s||'');
const isValidTime = s => timeRe.test((s||'').trim());
const isValidDate = s => dateRe.test((s||'').trim());

const parseNameFirstLast = s => { const m=(s||'').match(nameStdRe); if(!m) return null; return { first:m[1].trim(), last:m[2].trim(), full:`${m[1].trim()} ${m[2].trim()}` }; };
const parseNameLastFirst = s => { const m=(s||'').match(nameLFRe);  if(!m) return null; return { last:m[1].trim(), first:m[2].trim(), full:`${m[2].trim()} ${m[1].trim()}` }; };

const cleanUSPhone = s => {
  if (!s) return null;
  const digits = (s.replace(/[^\d]/g, '') || '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
};

// ---- Distance helper (Haversine) ----
function milesBetween(a, b) {
  if (!a || !b) return null;
  const toRad = d => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad((b.lat - a.lat));
  const dLng = toRad((b.lng - a.lng));
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- i18n ----------
const SUPPORTED_LANGS = ['en','es'];
const L = {
  en: {
    start_name: "Great, let's get you booked.\nWhat’s your full name? (First Last)",
    ask_symptoms: "Thanks, {first}. What brings you in (symptoms)?",
    ask_zip: "What ZIP code should I search near?",
    ask_ins: "Do you have insurance? (Y/N)",
    ask_preferred: "What’s your preferred date and time? (MM/DD/YYYY, HH:MM AM/PM)\nYou can also say “tomorrow morning” or “ASAP”.",
    bad_zip: "Please share a 5-digit US ZIP code.",
    bad_ins: "Please reply Y or N for insurance.",
    bad_dt: "I couldn’t read that date/time. Try like: 10/25/2025, 10:30 AM — or say “tomorrow morning” or “ASAP”.",
    cant_find: "I couldn’t find clinics nearby. What ZIP should I search near?",
    list_intro: "I found nearby options. Pick one or reply NEXT to see more.\nPreferred: {date} {time}",
    confirm_menu: "Please reply YES to proceed, NEXT for another clinic, a number 1–6 to pick, or NO to change the time.",
    selected: "Selected: {name}. Reply YES to proceed, NEXT for another, or NO to change time.",
    selected_explain: "Based on your symptoms, I recommend {name} because {why}.",
    next_card: "Next: {name}{address}. YES to use, NEXT again, or pick 1–6.",
    need_phone: "Great — to place the call and text your confirmation, what’s the best phone number for updates? (e.g., 555-123-4567)",
    bad_phone: "I couldn’t read that. Please share a US number like 555-123-4567.",
    calling: "Calling {clinic} now to book {when}. I’ll text you at {phone} with the result.",
    no_phone_on_clinic: "Heads up — {clinic} didn’t list a phone number I can dial. Choose another clinic (1–6) or type NEXT.",
    triage_why: "Why this search: {reason}{spec}",
    help: "I’ll ask your name, symptoms, ZIP, insurance (Y/N), and preferred date & time. Then I’ll show nearby clinics with reasons and call to book.\nType HOME to restart any time.",
    home_reset: "Okay, starting fresh.",
    ambiguous: "To point you to the right specialist, can you clarify in a few words (e.g., 'testicular pain', 'pelvic cramps', 'skin rash')?",
    asap_ack: "Got it — I’ll look for the earliest available appointment.\nPick one or reply NEXT to see more.",
    couldnt_place_call: "Couldn't place the call just now ({err}). Type YES to retry or HOME to restart.",
    walking_anytime_ack: "Thanks! To confirm, walk-in is okay. Is there anything {name} should bring?"
  },
  es: {
    start_name: "Genial, vamos a reservar.\n¿Cuál es tu nombre completo? (Nombre Apellido)",
    ask_symptoms: "Gracias, {first}. ¿Qué te ocurre (síntomas)?",
    ask_zip: "¿Cuál es el código postal donde debo buscar?",
    ask_ins: "¿Tienes seguro médico? (S/N)",
    ask_preferred: "¿Cuál es tu fecha y hora preferidas? (MM/DD/AAAA, HH:MM AM/PM)\nTambién puedes decir “mañana por la mañana” o “LO ANTES POSIBLE”.",
    bad_zip: "Por favor comparte un código postal de 5 dígitos en EE. UU.",
    bad_ins: "Responde S o N para el seguro.",
    bad_dt: "No pude leer la fecha/hora. Intenta: 10/25/2025, 10:30 AM — o di “mañana por la mañana” o “LO ANTES POSIBLE”.",
    cant_find: "No encontré clínicas cercanas. ¿Qué código postal debo usar?",
    list_intro: "Encontré opciones cercanas. Elige una o responde NEXT para ver más.\nPreferencia: {date} {time}",
    confirm_menu: "Responde YES para continuar, NEXT para otra clínica, un número 1–6 para elegir, o NO para cambiar la hora.",
    selected: "Seleccionado: {name}. Responde YES para continuar, NEXT para otra, o NO para cambiar hora.",
    selected_explain: "Según tus síntomas, recomiendo {name} porque {why}.",
    next_card: "Siguiente: {name}{address}. Escribe YES para usarla, NEXT otra vez, o elige del 1 al 6.",
    need_phone: "Perfecto. Para llamar y enviarte la confirmación por SMS, ¿cuál es tu número? (ej., 555-123-4567)",
    bad_phone: "No pude leerlo. Comparte un número de EE. UU., por ejemplo 555-123-4567.",
    calling: "Llamando a {clinic} para reservar {when}. Te enviaré SMS al {phone} con el resultado.",
    no_phone_on_clinic: "Ojo — {clinic} no tiene teléfono público. Elige otra (1–6) o escribe NEXT.",
    triage_why: "Motivo de la búsqueda: {reason}{spec}",
    help: "Te pediré nombre, síntomas, código postal, seguro (S/N) y fecha/hora preferidas. Luego mostraré clínicas cercanas y llamaré para reservar.\nEscribe HOME para reiniciar cuando quieras.",
    home_reset: "Listo, comenzamos de nuevo.",
    ambiguous: "Para dirigirte al especialista correcto, ¿puedes aclarar en pocas palabras (p. ej., 'dolor testicular', 'cólicos pélvicos', 'erupción en la piel')?",
    asap_ack: "Perfecto, buscaré la cita más próxima disponible.\nElige una o responde NEXT para ver más.",
    couldnt_place_call: "No pude realizar la llamada ahora ({err}). Escribe YES para reintentar o HOME para reiniciar.",
    walking_anytime_ack: "¡Gracias! Entonces se permite ir sin cita. ¿Hay algo que {name} deba llevar?"
  }
};
function t(lang, key, vars = {}) {
  const pack = L[SUPPORTED_LANGS.includes(lang) ? lang : 'en'];
  let s = pack[key] || L.en[key] || key;
  for (const [k,v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`,'g'), v ?? '');
  return s;
}
function tagLabel(lang, tag) {
  const map = { en:{'closest':'closest','open now':'open now','low cost':'low cost'}, es:{'closest':'más cerca','open now':'abierto ahora','low cost':'bajo costo'} };
  const pack = map[SUPPORTED_LANGS.includes(lang) ? lang : 'en']; return pack[tag] || tag;
}

// ---------- ASAP (EN/ES) ----------
function isASAP(text=""){
  const s = text.trim().toLowerCase();
  const en=/\b(asap|soonest|earliest|first available|next available|as soon as possible)\b/;
  const es=/\b(lo antes posible|lo mas pronto posible|lo más pronto posible|próxima disponible|proxima disponible|cuanto antes)\b/;
  return en.test(s)||es.test(s);
}

// ---------- Triage ----------
function normalizeSymptoms(text=""){
  let s=text.toLowerCase().trim();
  if (/\bballs?\b/.test(s)) s=s.replace(/\bheart\b/g,'hurt');
  s=s.replace(/\btesicle(s)?\b/g,'testicle$1').replace(/\bsrotum\b/g,'scrotum').replace(/\bpee\s?pain\b/g,'pain urination');
  return s;
}
function analyzeSymptoms(text="", patientName="the patient"){
  const s=normalizeSymptoms(text);
  const urology=/\b(testicle|testicular|scrotum|groin|penis|erectile|prostate|balls?)\b/;
  const obgyn=/\b(vagina|vaginal|pregnan|uter(us|ine)|ovar(y|ian)|cervix|pap|ob[-\s]?gyn|gyna?ec|gyneco)\b/;
  const cardio=/\b(chest pain|angina|shortness of breath|palpit|tachy|arrhythm|heart pain|cardio)\b/;
  const ent=/\b(throat|ear|nose|sinus|tonsil|hearing|tinnitus|ent)\b/;
  const derm=/\b(skin|rash|acne|eczema|psoriasis|mole|lesion|dermat)\b/;
  const dental=/\b(tooth|teeth|gum|cavity|dent(al|ist))\b/;
  const eye=/\b(eye|vision|conjunct|ophthalm)\b/;
  const ortho=/\b(bone|joint|sprain|fracture|knee|hip|shoulder|ortho)\b/;
  const gi=/\b(stomach|abdomen|abdominal|nausea|vomit|diarrhea|constipation|gi|gastro)\b/;
  const urgent=/\b(urgent care|urgent|fever|flu|stitches|laceration|infection|burn|injury)\b/;

  if (urology.test(s)&&!obgyn.test(s)) return { specialty:'urologist', reason:`genital/testicular terms present → urology fits for ${patientName}`, confidence:2 };
  if (obgyn.test(s)&&!urology.test(s)) return { specialty:'ob-gyn', reason:'gynecologic terms present → OB/GYN', confidence:2 };
  if (cardio.test(s)) return { specialty:'cardiologist', reason:'heart/chest terms detected', confidence:1 };
  if (ent.test(s))    return { specialty:'otolaryngologist', reason:'ear/nose/throat terms detected', confidence:1 };
  if (derm.test(s))   return { specialty:'dermatologist', reason:'skin terms detected', confidence:1 };
  if (dental.test(s)) return { specialty:'dentist', reason:'dental terms detected', confidence:1 };
  if (eye.test(s))    return { specialty:'ophthalmologist', reason:'eye/vision terms detected', confidence:1 };
  if (ortho.test(s))  return { specialty:'orthopedic', reason:'bone/joint terms detected', confidence:1 };
  if (gi.test(s))     return { specialty:'gastroenterologist', reason:'GI/abdominal terms detected', confidence:1 };
  if (urgent.test(s)) return { specialty:'urgent care', reason:'acute/urgent terms detected', confidence:1 };
  return { specialty:'clinic', reason:'defaulting to nearby primary/urgent care until clarified', confidence:0 };
}

// ---------- Places (Google) ----------
async function findClinics(zip, specialty='clinic', needLowCost=false){
  try{
    const geo=await mapsClient.geocode({ params:{ address:zip, key:GOOGLE_MAPS_API_KEY }});
    if(!geo.data.results.length) return [];
    const origin=geo.data.results[0].geometry.location; // {lat,lng}

    const nearby=await mapsClient.placesNearby({
      params:{ location:origin, radius:12000, keyword:specialty, type:'doctor', key:GOOGLE_MAPS_API_KEY }
    });
    const basics=(nearby.data.results||[]).slice(0,10).map(p=>({
      place_id:p.place_id, name:p.name,
      address:p.vicinity||p.formatted_address||'',
      rating:p.rating||null, loc:p.geometry?.location||null, openNow:p.opening_hours?.open_now??null
    }));

    const detailed=[];
    for(const b of basics){
      try{
        const d=await mapsClient.placeDetails({
          params:{ place_id:b.place_id, fields:['name','formatted_phone_number','international_phone_number','formatted_address','website','opening_hours','types'], key:GOOGLE_MAPS_API_KEY }
        });
        const r=d.data.result||{};
        const phone=r.international_phone_number||r.formatted_phone_number||null;
        const distanceMiles=b.loc?Math.round((milesBetween(origin,b.loc)||0)*10)/10:null;
        const types=r.types||[];
        const likelyLowCost=needLowCost||/free|community/i.test(b.name)||types.some(t=>/health|community|clinic/.test(t));
        const tags=[];
        if(distanceMiles!=null&&distanceMiles<=2.0) tags.push('closest');
        if(b.openNow===true||r.opening_hours?.open_now) tags.push('open now');
        if(likelyLowCost) tags.push('low cost');
        detailed.push({
          name:r.name||b.name, address:r.formatted_address||b.address||'', rating:b.rating, phone, website:r.website||null,
          distanceMiles, openNow:(b.openNow===true)||(r.opening_hours?.open_now===true)||false, tags
        });
      }catch{
        const distanceMiles=b.loc?Math.round((milesBetween(origin,b.loc)||0)*10)/10:null;
        const tags=[]; if(distanceMiles!=null&&distanceMiles<=2.0) tags.push('closest'); if(needLowCost) tags.push('low cost');
        detailed.push({ name:b.name, address:b.address, rating:b.rating, phone:null, website:null, distanceMiles, openNow:b.openNow===true, tags });
      }
    }
    detailed.sort((a,b)=>((a.distanceMiles??999)-(b.distanceMiles??999))||((b.rating??0)-(a.rating??0)));
    return detailed.slice(0,6);
  }catch(e){
    console.error('Maps API error:', e.message);
    return [];
  }
}

// ---------- OpenAI (voice fallback only) ----------
function buildSystemPrompt(userReq){
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
async function nextAIUtterance(callSid){
  const session=sessionsVoice.get(callSid);
  const lastTurns=(session?.transcript||[]).slice(-3);
  const messages=[
    { role:'system', content:buildSystemPrompt(session.userRequest) },
    ...lastTurns.map(t=>({ role:t.from==='ai'?'assistant':'user', content:t.text }))
  ];
  const resp=await openai.chat.completions.create({ model:'gpt-4o-mini', temperature:0.3, messages });
  return resp.choices[0].message.content.trim();
}

// ---------- Voice call helpers ----------
function speak(twiml,text){ twiml.say({ voice:TTS_VOICE }, text); }

async function startClinicCall({ to, name, reason, preferredTimes, clinicName, callback }){
  if(!to) throw new Error('Required parameter "params[\'to\']" missing.');
  const call=await client.calls.create({
    to, from:TWILIO_CALLER_ID,
    url:`${PUBLIC_BASE_URL}/voice?sid=${uuidv4()}`,
    statusCallback:`${PUBLIC_BASE_URL}/status`,
    statusCallbackEvent:['initiated','ringing','answered','completed'],
    statusCallbackMethod:'POST'
  });
  sessionsVoice.set(call.sid,{
    userRequest:{ name, reason, preferredTimes, clinicName, callback, clinicPhone:to },
    transcript:[], status:'in_progress', confirmed:null, startedAt:Date.now(), onHoldSince:null
  });
  if(callback){ lastCallByPatient.set(callback,{ to,name,reason,preferredTimes,clinicName,callback }); }
  return call.sid;
}
function scheduleRetry(patientNumber, details, delayMs){
  const existing=pendingRetries.get(patientNumber); if(existing) clearTimeout(existing);
  const timeoutId=setTimeout(async()=>{
    pendingRetries.delete(patientNumber);
    try{
      await startClinicCall(details);
      await client.messages.create({ to:details.callback, from:TWILIO_CALLER_ID, body:`Retrying your booking with ${details.clinicName} now. I’ll text the result.` });
    }catch(e){
      console.error('Scheduled retry failed:', e.message);
      try{ await client.messages.create({ to:details.callback, from:TWILIO_CALLER_ID, body:`Couldn’t retry the call just now. Reply RETRY to try again.` }); }catch{}
    }
  }, delayMs);
  pendingRetries.set(patientNumber,timeoutId);
}
function cancelRetry(patientNumber){
  const t=pendingRetries.get(patientNumber); if(t){ clearTimeout(t); pendingRetries.delete(patientNumber); return true; } return false;
}

// ---------- SPAM / ABUSE / COST GUARDS ----------
// Simple rate-limits + message sanity checks (no extra deps)
const ipRate = new Map();     // ip -> {count, windowStart}
const userRate = new Map();   // userId -> {count, windowStart, lastMsgTs, lastText}
const DAY_MS = 24*60*60*1000;

const RL_WINDOW_MS = 60 * 1000;   // 1 min window
const RL_MAX_PER_IP = 60;         // 60 req/min/ip
const RL_MAX_PER_USER = 20;       // 20 chat msgs/min/user
const MIN_SECONDS_BETWEEN_MSG = 1.2;

const MSG_MAX_CHARS = 600;        // hard cap
const MSG_MAX_EMOJI = 30;
const MSG_MAX_URLS  = 3;

let dailyBudget = { // crude token-cost brake by characters (very rough)
  day: new Date().toDateString(),
  chars: 0,
  MAX_CHARS_PER_DAY: 200000 // tweak for your budget; ~200k chars/day
};

const BLOCKLIST = [
  /fuck|bitch|cunt|slur|nazi|hitler|terror/i,
  /bitcoin miner|api key dump|script kiddie/i,
  /free money|casino|xxx|porn/i
];

function withinRate(map, key, max, windowMs){
  const now=Date.now();
  const entry=map.get(key) || { count:0, windowStart:now };
  if(now - entry.windowStart > windowMs){ entry.count=0; entry.windowStart=now; }
  entry.count += 1;
  map.set(key, entry);
  return entry.count <= max;
}
function spamCheck(userId, ip, text){
  // per-IP and per-user rate
  if(!withinRate(ipRate, ip, RL_MAX_PER_IP, RL_WINDOW_MS)) return { ok:false, reason:'Too many requests from IP. Cool down.' };
  if(!withinRate(userRate, userId, RL_MAX_PER_USER, RL_WINDOW_MS)) return { ok:false, reason:'You are sending messages too fast. Cool down.' };

  const now=Date.now();
  const ur=userRate.get(userId) || { lastMsgTs:0, lastText:'' };
  if((now - ur.lastMsgTs) < MIN_SECONDS_BETWEEN_MSG*1000) return { ok:false, reason:'Slow down a bit.' };
  ur.lastMsgTs = now;

  const txt=(text||'').trim();
  if(txt.length===0) return { ok:false, reason:'Empty message.' };
  if(txt.length>MSG_MAX_CHARS) return { ok:false, reason:`Message too long (>${MSG_MAX_CHARS} chars).` };

  const emojiCount=(txt.match(/[\u{1F300}-\u{1FAFF}]/gu)||[]).length;
  if(emojiCount>MSG_MAX_EMOJI) return { ok:false, reason:'Too many emoji.' };

  const urlCount=(txt.match(/https?:\/\/|www\./gi)||[]).length;
  if(urlCount>MSG_MAX_URLS) return { ok:false, reason:'Too many links.' };

  if (txt === ur.lastText) return { ok:false, reason:'Duplicate message.' };
  ur.lastText = txt;

  if (/[A-Z]{24,}/.test(txt)) return { ok:false, reason:'Please avoid excessive ALL CAPS.' };
  if (BLOCKLIST.some(rx=>rx.test(txt))) return { ok:false, reason:'Inappropriate content blocked.' });

  // daily cost brake (rough: count chars we process)
  const today=new Date().toDateString();
  if(dailyBudget.day!==today){ dailyBudget={ day:today, chars:0, MAX_CHARS_PER_DAY: dailyBudget.MAX_CHARS_PER_DAY }; }
  dailyBudget.chars += txt.length;
  if(dailyBudget.chars > dailyBudget.MAX_CHARS_PER_DAY) return { ok:false, reason:'Daily message budget reached. Please try tomorrow.' };

  userRate.set(userId, ur);
  return { ok:true };
}

// ---------- Helpers for i18n tags ----------
function whyForClinic(triage, clinic){
  const bits=[];
  if(triage?.reason) bits.push(triage.reason);
  if(clinic?.tags?.includes('closest')) bits.push('it is among the closest');
  if(clinic?.tags?.includes('open now')) bits.push('it is open now');
  if(clinic?.tags?.includes('low cost')) bits.push('it may be lower cost');
  if (bits.length===0) return 'it matches your search area and specialty';
  return bits.join('; ');
}

// ---------- Web Chat booking helper ----------
async function proceedToBooking(s){
  const when = s.asap ? (s.lang==='es'?'la cita más próxima':'the earliest time') : `${s.dateStr||''} ${s.timeStr||''}`.trim();
  const clinic = s.chosenClinic;
  if(!clinic){ s.state='intake_zip'; return t(s.lang,'cant_find'); }
  if(!clinic.phone){ s.state='confirm_intake'; return t(s.lang,'no_phone_on_clinic',{ clinic:clinic.name }); }

  if(s.userPhone){
    try{
      await startClinicCall({
        to: clinic.phone,
        name: s.patientName||'Patient',
        reason: s.symptoms||'Visit',
        preferredTimes: [when||'This week'],
        clinicName: clinic.name,
        callback: s.userPhone
      });
      s.state='calling';
      return t(s.lang,'calling',{ clinic:clinic.name, when, phone:s.userPhone });
    }catch(e){
      return t(s.lang,'couldnt_place_call',{ err:e.message });
    }
  }
  s.state='await_phone';
  return t(s.lang,'need_phone');
}

// ---------- Language endpoint ----------
app.post('/user/lang', (req,res)=>{
  const { userId, lang } = req.body || {};
  if(!userId||!lang) return res.status(400).json({ ok:false, error:'Missing userId or lang' });
  const picked = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  userPrefs.set(userId, { ...(userPrefs.get(userId)||{}), lang: picked });
  return res.json({ ok:true, lang:picked });
});

// ---------- Manual call (debug) ----------
app.post('/call', async (req,res)=>{
  const userRequest={
    name:req.body.name, reason:req.body.reason, preferredTimes:req.body.preferredTimes||[],
    clinicName:req.body.clinicName||'', callback:req.body.callback||'',
    clinicPhone:req.body.clinicPhone||req.body.to
  };
  try{
    const callSid=await startClinicCall({
      to:userRequest.clinicPhone, name:userRequest.name, reason:userRequest.reason,
      preferredTimes:userRequest.preferredTimes, clinicName:userRequest.clinicName, callback:userRequest.callback
    });
    return res.json({ ok:true, callSid });
  }catch(e){ return res.status(500).json({ ok:false, error:e.message }); }
});

// ---------- Voice ----------
app.post('/voice', async (req,res)=>{
  const callSid=req.body.CallSid;
  const twiml=new twilioPkg.twiml.VoiceResponse();
  const session=sessionsVoice.get(callSid);
  if(!session){ speak(twiml,'I lost the call context. Goodbye.'); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  const nameToSay=session.userRequest?.name||'the patient';
  const firstLine=`Hi, this is ${BRAND_NAME} — ${BRAND_SLOGAN}. I'm calling to book an appointment for ${nameToSay}. `
    + `${session.userRequest.reason ? 'Reason: ' + session.userRequest.reason + '. ' : ''}`
    + `Do you have availability ${session.userRequest.preferredTimes?.[0] || 'this week'}?`;
  session.transcript.push({ from:'ai', text:firstLine });
  speak(twiml, firstLine);
  const gather=twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto' });
  speak(gather, 'I can wait for your available times.');
  res.type('text/xml').send(twiml.toString());
});

app.post('/gather', async (req,res)=>{
  const callSid=req.body.CallSid;
  const speech=(req.body.SpeechResult||'').trim();
  const twiml=new twilioPkg.twiml.VoiceResponse();
  const session=sessionsVoice.get(callSid);
  if(!session){ speak(twiml,'I lost the call context. Goodbye.'); twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  // total call cap
  const elapsedMs=Date.now()-(session.startedAt||Date.now());
  if(elapsedMs>MAX_CALL_MS){
    speak(twiml,"I have to wrap here. We'll follow up by text. Thank you!");
    twiml.hangup();
    try{
      if(session.userRequest.callback){
        await client.messages.create({ to:session.userRequest.callback, from:TWILIO_CALLER_ID,
          body:`Clinic line busy/long. Reply RETRY for another attempt, WAIT 5 / WAIT 15 to schedule, or CANCEL.` });
      }
    }catch{}
    return res.type('text/xml').send(twiml.toString());
  }

  if(speech) session.transcript.push({ from:'rx', text:speech });
  const lower=speech.toLowerCase();

  let intent='other';
  if (/\b(yes|yeah|yep|works|okay|ok|sure|that[’']s fine|perfect|sounds good)\b/i.test(lower)) intent='yes';
  else if (/\b(no|nope|not available|can[’']t|can’t|unavailable)\b/i.test(lower)) intent='no';
  else if (/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next)\b/i.test(lower)
        || /\b\d{1,2}(:\d{2})?\s?(am|pm)?\b/i.test(lower)
        || /\b(morning|afternoon|evening|noon|midday)\b/i.test(lower)) intent='time';

  // hold detection
  if(/\b(please hold|hold on|one moment|just a moment|put you on hold|one sec|minute)\b/i.test(lower)){
    if(!session.onHoldSince) session.onHoldSince=Date.now();
    if(Date.now()-session.onHoldSince>MAX_HOLD_MS){
      speak(twiml,"I’ll follow up later. Thank you!");
      twiml.hangup();
      try{
        const details={ to:session.userRequest.clinicPhone, name:session.userRequest.name, reason:session.userRequest.reason,
                        preferredTimes:session.userRequest.preferredTimes, clinicName:session.userRequest.clinicName, callback:session.userRequest.callback };
        if(session.userRequest.callback){
          await client.messages.create({ to:session.userRequest.callback, from:TWILIO_CALLER_ID,
            body:`Clinic kept us on hold too long. Reply NOW/RETRY to call again, or WAIT 5 / WAIT 15 / CANCEL.` });
          scheduleRetry(session.userRequest.callback, details, DEFAULT_RETRY_MS);
        }
      }catch{}
      return res.type('text/xml').send(twiml.toString());
    }
    speak(twiml,"Sure, I can hold.");
    twiml.pause({ length: 15 });
    const g=twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    speak(g,"I’m still here.");
    return res.type('text/xml').send(twiml.toString());
  }else if(session.onHoldSince){ session.onHoldSince=null; }

  if(intent==='time'){
    const parsedDate=chrono.parseDate(speech,new Date());
    const cleanTime = parsedDate
      ? parsedDate.toLocaleString('en-US',{ weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })
      : speech;
    session.confirmed={ time:cleanTime };
    const confirmLine=`Great, I have you down for ${cleanTime} for patient ${session.userRequest.name}. Can you confirm? Also, is there anything ${session.userRequest.name} needs to bring?`;
    session.transcript.push({ from:'ai', text:confirmLine });
    speak(twiml, confirmLine);
    twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  if(intent==='yes' && session.confirmed?.time){
    const thanks=`Perfect, thank you very much. Please note the patient name ${session.userRequest.name}. Have a great day.`;
    session.status='confirmed'; session.transcript.push({ from:'ai', text:thanks }); speak(twiml, thanks); twiml.hangup();
    try{
      if(session.userRequest.callback){
        await client.messages.create({ to:session.userRequest.callback, from:TWILIO_CALLER_ID,
          body:`✅ Confirmed: ${session.confirmed.time} at ${session.userRequest.clinicName}.` });
      }
    }catch{}
    return res.type('text/xml').send(twiml.toString());
  }

  if(intent==='no'){
    const retry='No problem. Could you share another available time—morning or afternoon works too?';
    session.transcript.push({ from:'ai', text:retry }); speak(twiml, retry);
    twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  if(/\b(come\s+any\s*time|walk[-\s]?in|anytime today|free anytime)\b/i.test(lower)){
    const askDocs=`Thanks! To confirm, walk-in is okay. Is there anything ${session.userRequest.name} should bring?`;
    session.transcript.push({ from:'ai', text:askDocs }); speak(twiml, askDocs);
    twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 });
    return res.type('text/xml').send(twiml.toString());
  }

  // fallback to GPT (rare path; token protected by call cap above)
  let reply; try{ reply=await nextAIUtterance(callSid); }catch{ reply="I didn't catch that. Could you share an available day and time?"; }
  session.transcript.push({ from:'ai', text:reply }); speak(twiml, reply);
  const g=twiml.gather({ input:'speech', action:'/gather', method:'POST', speechTimeout:'auto', timeout:5 }); speak(g,"I'm listening.");
  return res.type('text/xml').send(twiml.toString());
});

app.post('/status', async (req,res)=>{
  const callSid=req.body.CallSid; const callStatus=(req.body.CallStatus||'').toLowerCase();
  const session=sessionsVoice.get(callSid); if(!session) return res.sendStatus(200);
  if(callStatus==='completed' && session.status!=='confirmed'){
    try{
      if(session.userRequest.callback){
        await client.messages.create({ to:session.userRequest.callback, from:TWILIO_CALLER_ID,
          body:`The clinic ended the call before we could confirm. Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.` });
      }
    }catch{}
  }
  if(/(failed|busy|no-answer|canceled)/i.test(callStatus)){
    try{
      if(session.userRequest.callback){
        await client.messages.create({ to:session.userRequest.callback, from:TWILIO_CALLER_ID,
          body:`Call didn’t go through (${callStatus}). Reply RETRY to try again, or WAIT 5 / WAIT 15 / CANCEL.` });
      }
    }catch{}
  }
  return res.sendStatus(200);
});

// ---------- SMS webhook (kept minimal) ----------
app.post('/sms', async (req,res)=>{
  const MessagingResponse=twilioPkg.twiml.MessagingResponse;
  const twiml=new MessagingResponse();

  const from=(req.body.From||'').trim();
  const body=(req.body.Body||'').trim();
  const lower=body.toLowerCase();
  const send=(text)=>{ twiml.message(text); return res.type('text/xml').send(twiml.toString()); };

  if(/\b(stop|end|unsubscribe|quit|cancel)\b/.test(lower)){ cancelRetry(from); return send("You’re opted out and won’t receive more texts. Reply START to opt back in."); }
  if(/\b(start)\b/.test(lower)) return send("You’re opted in. Reply HELP for info.");
  if(/\b(help)\b/.test(lower))  return send(`${BRAND_NAME}: Msg&data rates may apply. Reply STOP to opt out.`);

  if(/\b(retry|now|call\s*again|call\s*back)\b/.test(lower)){
    const details=lastCallByPatient.get(from);
    if(!details||!details.to) return send("I don’t have a clinic on file to call back. Start a new request first.");
    cancelRetry(from);
    try{ await startClinicCall(details); return send(`Calling ${details.clinicName} again now. I’ll text the result.`); }
    catch{ return send(`Couldn’t place the call just now. Reply RETRY again in a moment, or WAIT 5 / WAIT 15.`); }
  }
  return send("Thanks! Please use our website chat to start a request.");
});

// ---------- Web Chat API (with spam guards) ----------
app.post('/app-chat', async (req,res)=>{
  const { userId, message, lang:langFromClient } = req.body || {};
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'ip:unknown';

  if(!userId||!message) return res.status(400).json({ ok:false, error:'Missing userId or message' });

  // Spam / abuse / budget checks
  const check=spamCheck(userId, ip, message);
  if(!check.ok) return res.status(429).json({ ok:false, error:check.reason });

  let lang=(userPrefs.get(userId)||{}).lang || 'en';
  if(langFromClient && SUPPORTED_LANGS.includes(langFromClient)){ lang=langFromClient; userPrefs.set(userId,{ ...(userPrefs.get(userId)||{}), lang }); }

  // Inline language commands
  const langMsg=message.trim().toLowerCase();
  if(/^\s*(language|lang)\s*:\s*(en|english)\s*$/.test(langMsg) || /\benglish\b/.test(langMsg)){ lang='en'; userPrefs.set(userId,{ ...(userPrefs.get(userId)||{}), lang }); return res.json({ ok:true, reply:"Language set to English." }); }
  if(/^\s*(language|idioma|lang)\s*:\s*(es|español|espanol|spanish)\s*$/.test(langMsg) || /\b(español|espanol|spanish)\b/.test(langMsg)){ lang='es'; userPrefs.set(userId,{ ...(userPrefs.get(userId)||{}), lang }); return res.json({ ok:true, reply:"Idioma configurado a Español." }); }

  const say=(text, extra={})=>res.json({ ok:true, reply:text, ...extra });

  let s=sessionsChat.get(userId);
  if(/^\s*home\s*$/i.test(message)){ sessionsChat.delete(userId); return say(t(lang,'home_reset')); }

  if(!s || /^\s*new\s*$/i.test(message)){
    s={ state:'intake_name', source:'web', lang, userPhone:null, patientName:null, symptoms:null, zip:null,
        insuranceY:null, dateStr:null, timeStr:null, asap:false, chosenClinic:null, clinics:[] };
    sessionsChat.set(userId,s);
    return say(t(lang,'start_name'));
  }

  const msg=message.trim();
  if(/^\s*help\s*$/i.test(msg)) return say(t(lang,'help'));

  if(/^\s*mine\s*$/i.test(msg)){
    const usual=userUsualClinics.get(userId);
    if(!usual) return say("I don’t have a usual clinic saved yet. After we book today, I can save it for next time.");
    s.chosenClinic=usual; s.state='confirm_intake';
    const whenStr=s.asap?(s.lang==='es'?'la cita más próxima':'the earliest time'):`${s.dateStr||'soon'} ${s.timeStr||''}`.trim();
    const why=whyForClinic({reason:'you marked it as your usual clinic'}, usual);
    return say(`${t(lang,'selected',{name:usual.name})}\n${t(lang,'selected_explain',{name:usual.name, why})}\nWe’ll try for ${whenStr||'the earliest time'}. Does that look right? (YES/NO)`);
  }

  // STATE MACHINE
  if(s.state==='intake_name'){
    const parsed=parseNameFirstLast(msg)||parseNameLastFirst(msg);
    if(!parsed) return say("Could you share your name as First Last?");
    s.patientName=`${parsed.first} ${parsed.last}`;
    s.state='intake_symptoms';
    return say(t(lang,'ask_symptoms',{ first:parsed.first }));
  }

  if(s.state==='intake_symptoms'){
    s.symptoms=msg; s.state='intake_zip';
    return say(t(lang,'ask_zip'));
  }

  if(s.state==='intake_zip'){
    if(!isValidZip(msg)) return say(t(lang,'bad_zip'));
    s.zip=msg; s.state='intake_insurance';
    return say(t(lang,'ask_ins'));
  }

  if(s.state==='intake_insurance'){
    if(!isValidYN(msg)) return say(t(lang,'bad_ins'));
    s.insuranceY=ynToBool(msg); s.state='intake_preferred';
    return say(t(lang,'ask_preferred'));
  }

  if(s.state==='intake_preferred'){
    // ASAP path (EN/ES)
    if(isASAP(msg)){
      s.asap=true; s.dateStr=null; s.timeStr=null;
      const triage=analyzeSymptoms(s.symptoms, s.patientName);
      const specialty=s.insuranceY ? triage.specialty : 'free clinic';
      const list=await findClinics(s.zip, specialty, !s.insuranceY);
      s.clinics=list;
      if(!list.length){ s.state='intake_zip'; return say(t(lang,'cant_find')); }
      s.chosenClinic=list[0]; s.state='confirm_intake';
      const why=whyForClinic(triage, s.chosenClinic);
      return say(t(lang,'asap_ack'),
        { triage:{ specialty, reason:triage.reason, confidence:triage.confidence },
          clinics:list.map((c,i)=>({ id:i, name:c.name, address:c.address, phone:c.phone, rating:c.rating,
            distanceMiles:c.distanceMiles, openNow:c.openNow, tags:c.tags.map(tag=>tagLabel(lang,tag)) })),
          note:`${t(lang,'selected_explain',{ name:s.chosenClinic.name, why })}` });
    }

    // Concrete date/time
    let d='', tstr='';
    if(/,/.test(msg) && isValidDate(msg.split(',')[0]) && isValidTime((msg.split(',')[1]||'').trim())){
      d=msg.split(',')[0].trim(); tstr=(msg.split(',')[1]||'').trim();
    }else{
      const parsed=chrono.parseDate(msg);
      if(parsed){ d=parsed.toLocaleDateString('en-US'); tstr=parsed.toLocaleTimeString('en-US',{ hour:'numeric', minute:'2-digit', hour12:true }); }
    }
    if(!d||!tstr) return say(t(lang,'bad_dt'));

    s.asap=false; s.dateStr=d; s.timeStr=tstr;

    const triage=analyzeSymptoms(s.symptoms, s.patientName);
    const specialty=s.insuranceY ? triage.specialty : 'free clinic';
    const list=await findClinics(s.zip, specialty, !s.insuranceY);
    s.clinics=list;
    if(!list.length){ s.state='intake_zip'; return say(t(lang,'cant_find')); }

    s.chosenClinic=list[0]; s.state='confirm_intake';
    const why=whyForClinic(triage, s.chosenClinic);
    return say(
      `${t(lang,'list_intro',{ date:s.dateStr, time:s.timeStr })}\n${t(lang,'selected_explain',{ name:s.chosenClinic.name, why })}`,
      { triage:{ specialty, reason:triage.reason, confidence:triage.confidence },
        clinics:list.map((c,i)=>({ id:i, name:c.name, address:c.address, phone:c.phone, rating:c.rating,
          distanceMiles:c.distanceMiles, openNow:c.openNow, tags:c.tags.map(tag=>tagLabel(lang,tag)) })) }
    );
  }

  if(s.state==='confirm_intake'){
    const m=msg.match(/^\s*([1-6])\s*$/);
    if(m&&s.clinics?.length){
      const idx=parseInt(m[1],10)-1;
      if(s.clinics[idx]){
        s.chosenClinic=s.clinics[idx];
        const triage=analyzeSymptoms(s.symptoms, s.patientName);
        const why=whyForClinic(triage, s.chosenClinic);
        return say(`${t(lang,'selected',{name:s.chosenClinic.name})}\n${t(lang,'selected_explain',{ name:s.chosenClinic.name, why })}`);
      }
    }
    if(/^yes\b/i.test(msg)){
      if(s.source==='web' && !s.userPhone){ s.state='await_phone'; return say(t(lang,'need_phone')); }
      const reply=await proceedToBooking(s); return say(reply);
    }
    if(/^next\b/i.test(msg)){
      const list=s.clinics||[]; const idx=list.findIndex(c=>c.name===s.chosenClinic?.name);
      const next=list[idx+1]; if(!next) return say(t(lang,'confirm_menu'));
      s.chosenClinic=next;
      const triage=analyzeSymptoms(s.symptoms, s.patientName);
      const why=whyForClinic(triage, s.chosenClinic);
      return say(`${t(lang,'next_card',{ name:next.name, address: next.address ? ' — '+next.address : '' })}\n${t(lang,'selected_explain',{ name:next.name, why })}`);
    }
    if(/^no\b/i.test(msg)){ s.state='intake_preferred'; return say(t(lang,'ask_preferred')); }
    return say(t(lang,'confirm_menu'));
  }

  if(s.state==='await_phone'){
    const p=cleanUSPhone(msg); if(!p) return say(t(lang,'bad_phone'));
    s.userPhone=p; const reply=await proceedToBooking(s); return say(reply);
  }

  if(s.state==='calling') return say("I’m on it. I’ll text you with the result. Type HOME to start over.");

  return say("I didn’t understand that. Type HOME to start over, or HELP for help.");
});

// ---------- Start ----------
app.listen(PORT, ()=>{ console.log(`${BRAND_NAME} concierge listening on ${PORT}`); });
