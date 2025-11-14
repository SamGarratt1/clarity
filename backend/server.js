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
  TTS_VOICE = 'Polly.Matthew-Neural'
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

/* ---------- Translation Dictionary (No API calls needed) ---------- */
const translations = {
  es: { // Spanish
    'Welcome to Clarity Health Concierge — AI appointment assistant. What is the patient\'s full name? (First Last)': 'Bienvenido a Clarity Health Concierge — asistente de citas con IA. ¿Cuál es el nombre completo del paciente? (Nombre Apellido)',
    'What is the reason for the visit? (brief)': '¿Cuál es el motivo de la visita? (breve)',
    'What ZIP code should I search near? (5 digits)': '¿Qué código postal debo buscar cerca? (5 dígitos)',
    'Please enter a 5-digit ZIP (e.g., 30309).': 'Por favor ingrese un código postal de 5 dígitos (ej: 30309).',
    'Do you have insurance? (Y/N)': '¿Tiene seguro? (S/N)',
    'Please reply Y or N for insurance.': 'Por favor responda S o N para el seguro.',
    'Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?': '¿Quiere su clínica habitual (escriba "Mi clínica") o buscar cerca (escriba "Cerca")?',
    'What date works best? (MM/DD/YYYY). You can also say "ASAP".': '¿Qué fecha funciona mejor? (MM/DD/AAAA). También puede decir "LO ANTES POSIBLE".',
    'Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.': 'Por favor use MM/DD/AAAA (ej: 10/25/2025), o diga LO ANTES POSIBLE.',
    'Preferred time? (e.g., 10:30 AM). You can also say ASAP.': '¿Hora preferida? (ej: 10:30 AM). También puede decir LO ANTES POSIBLE.',
    'Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.': 'Use HH:MM AM/PM (ej: 10:30 AM), o diga LO ANTES POSIBLE.',
    'I couldn\'t find clinics nearby. Please check the ZIP or try a broader area.': 'No pude encontrar clínicas cerca. Por favor verifique el código postal o pruebe un área más amplia.',
    'I found': 'Encontré',
    'clinic': 'clínica',
    'clinics': 'clínicas',
    'near you. Here are the top options:': 'cerca de usted. Aquí están las mejores opciones:',
    'Option': 'Opción',
    'Pros:': 'Pros:',
    'Cons:': 'Contras:',
    'High rating': 'Calificación alta',
    'Good rating': 'Buena calificación',
    'Closest option': 'Opción más cercana',
    'Lower rating': 'Calificación más baja',
    'Phone number not available': 'Número de teléfono no disponible',
    'Which option would you like? Reply **1**, **2**, or **3** to select, or type **NEXT** to see more options.': '¿Qué opción le gustaría? Responda **1**, **2** o **3** para seleccionar, o escriba **SIGUIENTE** para ver más opciones.',
    'Great! You selected': '¡Excelente! Seleccionó',
    'Book for': 'Reservar para',
    '? Reply **YES** to call now, or **CANCEL** to choose a different option.': '? Responda **SÍ** para llamar ahora, o **CANCELAR** para elegir una opción diferente.',
    'Please select option 1, 2, or 3.': 'Por favor seleccione la opción 1, 2 o 3.',
    'No more options. Please select from options 1, 2, or 3, or type RESET to start again.': 'No hay más opciones. Por favor seleccione de las opciones 1, 2 o 3, o escriba REINICIAR para comenzar de nuevo.',
    'Here are more options:': 'Aquí hay más opciones:',
    'Reply with the option number': 'Responda con el número de opción',
    'to select.': 'para seleccionar.',
    'This clinic did not list a phone number via Maps. Reply NEXT for another option.': 'Esta clínica no listó un número de teléfono en Maps. Responda SIGUIENTE para otra opción.',
    'Calling': 'Llamando a',
    'now to book for': 'ahora para reservar para',
    '. I\'ll confirm here.': '. Confirmaré aquí.',
    'Cancelled. Please select option **1**, **2**, or **3** to choose a clinic.': 'Cancelado. Por favor seleccione la opción **1**, **2** o **3** para elegir una clínica.',
    'Reset. Type NEW to begin.': 'Reiniciado. Escriba NUEVO para comenzar.',
    'Please reply **YES** to book, **CANCEL** to choose a different option, or **RESET** to start over.': 'Por favor responda **SÍ** para reservar, **CANCELAR** para elegir una opción diferente, o **REINICIAR** para comenzar de nuevo.',
    'Please reply with option number (**1**, **2**, or **3**) to select, **NEXT** for more options, or **RESET** to start over.': 'Por favor responda con el número de opción (**1**, **2** o **3**) para seleccionar, **SIGUIENTE** para más opciones, o **REINICIAR** para comenzar de nuevo.',
    'Noted. I\'ll use your usual clinic when we get to that step.': 'Anotado. Usaré su clínica habitual cuando lleguemos a ese paso.',
    'Noted. I\'ll search for nearby clinics when we get to that step.': 'Anotado. Buscaré clínicas cercanas cuando lleguemos a ese paso.',
    'Based on': 'Basado en',
    'your usual clinic preference': 'su preferencia de clínica habitual',
    'your symptoms indicating': 'sus síntomas indicando',
    'distance and availability': 'distancia y disponibilidad',
    'I suggest': 'sugiero',
    'rating': 'calificación',
    'Book for': 'Reservar para',
    '? Reply YES to call now, or type NEXT to see another option.': '? Responda SÍ para llamar ahora, o escriba SIGUIENTE para ver otra opción.',
    'No more options. Type YES to proceed or RESET to start again.': 'No hay más opciones. Escriba SÍ para proceder o REINICIAR para comenzar de nuevo.',
    'Option:': 'Opción:',
    'Book for': 'Reservar para',
    '? Reply YES to call, or NEXT for another.': '? Responda SÍ para llamar, o SIGUIENTE para otra.',
    'Please select an option first. Reply **1**, **2**, or **3** to choose a clinic.': 'Por favor seleccione una opción primero. Responda **1**, **2** o **3** para elegir una clínica.',
    'Please reply YES to book, NEXT for another option, or RESET to start over.': 'Por favor responda SÍ para reservar, SIGUIENTE para otra opción, o REINICIAR para comenzar de nuevo.'
  },
  fr: { // French
    'Welcome to Clarity Health Concierge — AI appointment assistant. What is the patient\'s full name? (First Last)': 'Bienvenue chez Clarity Health Concierge — assistant de rendez-vous IA. Quel est le nom complet du patient ? (Prénom Nom)',
    'What is the reason for the visit? (brief)': 'Quelle est la raison de la visite ? (bref)',
    'What ZIP code should I search near? (5 digits)': 'Quel code postal dois-je rechercher à proximité ? (5 chiffres)',
    'Please enter a 5-digit ZIP (e.g., 30309).': 'Veuillez entrer un code postal à 5 chiffres (ex: 30309).',
    'Do you have insurance? (Y/N)': 'Avez-vous une assurance ? (O/N)',
    'Please reply Y or N for insurance.': 'Veuillez répondre O ou N pour l\'assurance.',
    'Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?': 'Voulez-vous votre clinique habituelle (tapez "Ma clinique") ou rechercher à proximité (tapez "Proche") ?',
    'What date works best? (MM/DD/YYYY). You can also say "ASAP".': 'Quelle date convient le mieux ? (MM/JJ/AAAA). Vous pouvez aussi dire "AU PLUS TÔT".',
    'Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.': 'Veuillez utiliser MM/JJ/AAAA (ex: 10/25/2025), ou dites AU PLUS TÔT.',
    'Preferred time? (e.g., 10:30 AM). You can also say ASAP.': 'Heure préférée ? (ex: 10:30 AM). Vous pouvez aussi dire AU PLUS TÔT.',
    'Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.': 'Utilisez HH:MM AM/PM (ex: 10:30 AM), ou dites AU PLUS TÔT.',
    'I couldn\'t find clinics nearby. Please check the ZIP or try a broader area.': 'Je n\'ai pas pu trouver de cliniques à proximité. Veuillez vérifier le code postal ou essayer une zone plus large.',
    'I found': 'J\'ai trouvé',
    'clinic': 'clinique',
    'clinics': 'cliniques',
    'near you. Here are the top options:': 'près de vous. Voici les meilleures options :',
    'Option': 'Option',
    'Pros:': 'Avantages :',
    'Cons:': 'Inconvénients :',
    'High rating': 'Note élevée',
    'Good rating': 'Bonne note',
    'Closest option': 'Option la plus proche',
    'Lower rating': 'Note plus basse',
    'Phone number not available': 'Numéro de téléphone non disponible',
    'Which option would you like? Reply **1**, **2**, or **3** to select, or type **NEXT** to see more options.': 'Quelle option souhaitez-vous ? Répondez **1**, **2** ou **3** pour sélectionner, ou tapez **SUIVANT** pour voir plus d\'options.',
    'Great! You selected': 'Excellent ! Vous avez sélectionné',
    'Book for': 'Réserver pour',
    '? Reply **YES** to call now, or **CANCEL** to choose a different option.': '? Répondez **OUI** pour appeler maintenant, ou **ANNULER** pour choisir une autre option.',
    'Please select option 1, 2, or 3.': 'Veuillez sélectionner l\'option 1, 2 ou 3.',
    'No more options. Please select from options 1, 2, or 3, or type RESET to start again.': 'Plus d\'options. Veuillez sélectionner parmi les options 1, 2 ou 3, ou tapez RÉINITIALISER pour recommencer.',
    'Here are more options:': 'Voici plus d\'options :',
    'Reply with the option number': 'Répondez avec le numéro d\'option',
    'to select.': 'pour sélectionner.',
    'This clinic did not list a phone number via Maps. Reply NEXT for another option.': 'Cette clinique n\'a pas listé de numéro de téléphone via Maps. Répondez SUIVANT pour une autre option.',
    'Calling': 'Appel de',
    'now to book for': 'maintenant pour réserver pour',
    '. I\'ll confirm here.': '. Je confirmerai ici.',
    'Cancelled. Please select option **1**, **2**, or **3** to choose a clinic.': 'Annulé. Veuillez sélectionner l\'option **1**, **2** ou **3** pour choisir une clinique.',
    'Reset. Type NEW to begin.': 'Réinitialisé. Tapez NOUVEAU pour commencer.',
    'Please reply **YES** to book, **CANCEL** to choose a different option, or **RESET** to start over.': 'Veuillez répondre **OUI** pour réserver, **ANNULER** pour choisir une autre option, ou **RÉINITIALISER** pour recommencer.',
    'Please reply with option number (**1**, **2**, or **3**) to select, **NEXT** for more options, or **RESET** to start over.': 'Veuillez répondre avec le numéro d\'option (**1**, **2** ou **3**) pour sélectionner, **SUIVANT** pour plus d\'options, ou **RÉINITIALISER** pour recommencer.',
    'Noted. I\'ll use your usual clinic when we get to that step.': 'Noté. J\'utiliserai votre clinique habituelle lorsque nous arriverons à cette étape.',
    'Noted. I\'ll search for nearby clinics when we get to that step.': 'Noté. Je rechercherai des cliniques à proximité lorsque nous arriverons à cette étape.'
  },
  pt: { // Portuguese
    'Welcome to Clarity Health Concierge — AI appointment assistant. What is the patient\'s full name? (First Last)': 'Bem-vindo ao Clarity Health Concierge — assistente de agendamento com IA. Qual é o nome completo do paciente? (Nome Sobrenome)',
    'What is the reason for the visit? (brief)': 'Qual é o motivo da visita? (breve)',
    'What ZIP code should I search near? (5 digits)': 'Qual código postal devo procurar perto? (5 dígitos)',
    'Please enter a 5-digit ZIP (e.g., 30309).': 'Por favor, insira um código postal de 5 dígitos (ex: 30309).',
    'Do you have insurance? (Y/N)': 'Você tem seguro? (S/N)',
    'Please reply Y or N for insurance.': 'Por favor, responda S ou N para seguro.',
    'Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?': 'Você quer sua clínica usual (digite "Minha clínica") ou procurar perto (digite "Perto")?',
    'What date works best? (MM/DD/YYYY). You can also say "ASAP".': 'Qual data funciona melhor? (MM/DD/AAAA). Você também pode dizer "O MAIS RÁPIDO POSSÍVEL".',
    'Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.': 'Por favor, use MM/DD/AAAA (ex: 10/25/2025), ou diga O MAIS RÁPIDO POSSÍVEL.',
    'Preferred time? (e.g., 10:30 AM). You can also say ASAP.': 'Horário preferido? (ex: 10:30 AM). Você também pode dizer O MAIS RÁPIDO POSSÍVEL.',
    'Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.': 'Use HH:MM AM/PM (ex: 10:30 AM), ou diga O MAIS RÁPIDO POSSÍVEL.',
    'I couldn\'t find clinics nearby. Please check the ZIP or try a broader area.': 'Não consegui encontrar clínicas próximas. Por favor, verifique o código postal ou tente uma área mais ampla.',
    'I found': 'Encontrei',
    'clinic': 'clínica',
    'clinics': 'clínicas',
    'near you. Here are the top options:': 'perto de você. Aqui estão as melhores opções:',
    'Option': 'Opção',
    'Pros:': 'Prós:',
    'Cons:': 'Contras:',
    'High rating': 'Avaliação alta',
    'Good rating': 'Boa avaliação',
    'Closest option': 'Opção mais próxima',
    'Lower rating': 'Avaliação mais baixa',
    'Phone number not available': 'Número de telefone não disponível',
    'Which option would you like? Reply **1**, **2**, or **3** to select, or type **NEXT** to see more options.': 'Qual opção você gostaria? Responda **1**, **2** ou **3** para selecionar, ou digite **PRÓXIMO** para ver mais opções.',
    'Great! You selected': 'Ótimo! Você selecionou',
    'Book for': 'Agendar para',
    '? Reply **YES** to call now, or **CANCEL** to choose a different option.': '? Responda **SIM** para ligar agora, ou **CANCELAR** para escolher uma opção diferente.',
    'Please select option 1, 2, or 3.': 'Por favor, selecione a opção 1, 2 ou 3.',
    'No more options. Please select from options 1, 2, or 3, or type RESET to start again.': 'Sem mais opções. Por favor, selecione das opções 1, 2 ou 3, ou digite REINICIAR para começar novamente.',
    'Here are more options:': 'Aqui estão mais opções:',
    'Reply with the option number': 'Responda com o número da opção',
    'to select.': 'para selecionar.',
    'This clinic did not list a phone number via Maps. Reply NEXT for another option.': 'Esta clínica não listou um número de telefone via Maps. Responda PRÓXIMO para outra opção.',
    'Calling': 'Ligando para',
    'now to book for': 'agora para agendar para',
    '. I\'ll confirm here.': '. Vou confirmar aqui.',
    'Cancelled. Please select option **1**, **2**, or **3** to choose a clinic.': 'Cancelado. Por favor, selecione a opção **1**, **2** ou **3** para escolher uma clínica.',
    'Reset. Type NEW to begin.': 'Reiniciado. Digite NOVO para começar.',
    'Please reply **YES** to book, **CANCEL** to choose a different option, or **RESET** to start over.': 'Por favor, responda **SIM** para agendar, **CANCELAR** para escolher uma opção diferente, ou **REINICIAR** para começar de novo.',
    'Please reply with option number (**1**, **2**, or **3**) to select, **NEXT** for more options, or **RESET** to start over.': 'Por favor, responda com o número da opção (**1**, **2** ou **3**) para selecionar, **PRÓXIMO** para mais opções, ou **REINICIAR** para começar de novo.',
    'Noted. I\'ll use your usual clinic when we get to that step.': 'Anotado. Vou usar sua clínica usual quando chegarmos a essa etapa.',
    'Noted. I\'ll search for nearby clinics when we get to that step.': 'Anotado. Vou procurar clínicas próximas quando chegarmos a essa etapa.'
  }
  // Arabic and Hindi can be added later if needed
};

// Simple translation function using dictionary
function translateText(msg, lang) {
  if (!lang || lang === 'en' || !translations[lang]) return msg;
  if (!msg || msg.trim().length === 0) return msg;
  
  // Direct lookup first
  if (translations[lang][msg]) {
    return translations[lang][msg];
  }
  
  // Handle dynamic messages with variables
  // Translate parts and reconstruct
  let translated = msg;
  
  // Translate common phrases within the message
  const commonPhrases = [
    { en: 'I found', es: 'Encontré', fr: 'J\'ai trouvé', pt: 'Encontrei' },
    { en: 'clinic', es: 'clínica', fr: 'clinique', pt: 'clínica' },
    { en: 'clinics', es: 'clínicas', fr: 'cliniques', pt: 'clínicas' },
    { en: 'near you. Here are the top options:', es: 'cerca de usted. Aquí están las mejores opciones:', fr: 'près de vous. Voici les meilleures options :', pt: 'perto de você. Aqui estão as melhores opções:' },
    { en: 'Option', es: 'Opción', fr: 'Option', pt: 'Opção' },
    { en: 'Pros:', es: 'Pros:', fr: 'Avantages :', pt: 'Prós:' },
    { en: 'Cons:', es: 'Contras:', fr: 'Inconvénients :', pt: 'Contras:' },
    { en: 'High rating', es: 'Calificación alta', fr: 'Note élevée', pt: 'Avaliação alta' },
    { en: 'Good rating', es: 'Buena calificación', fr: 'Bonne note', pt: 'Boa avaliação' },
    { en: 'Closest option', es: 'Opción más cercana', fr: 'Option la plus proche', pt: 'Opção mais próxima' },
    { en: 'Lower rating', es: 'Calificación más baja', fr: 'Note plus basse', pt: 'Avaliação mais baixa' },
    { en: 'Phone number not available', es: 'Número de teléfono no disponible', fr: 'Numéro de téléphone non disponible', pt: 'Número de telefone não disponível' },
    { en: 'Great! You selected', es: '¡Excelente! Seleccionó', fr: 'Excellent ! Vous avez sélectionné', pt: 'Ótimo! Você selecionou' },
    { en: 'Book for', es: 'Reservar para', fr: 'Réserver pour', pt: 'Agendar para' },
    { en: 'Calling', es: 'Llamando a', fr: 'Appel de', pt: 'Ligando para' },
    { en: 'now to book for', es: 'ahora para reservar para', fr: 'maintenant pour réserver pour', pt: 'agora para agendar para' },
    { en: '. I\'ll confirm here.', es: '. Confirmaré aquí.', fr: '. Je confirmerai ici.', pt: '. Vou confirmar aqui.' },
    { en: 'Based on', es: 'Basado en', fr: 'Basé sur', pt: 'Com base em' },
    { en: 'I suggest', es: 'sugiero', fr: 'je suggère', pt: 'sugiro' },
    { en: 'rating', es: 'calificación', fr: 'note', pt: 'avaliação' }
  ];
  
  // Replace common phrases
  for (const phrase of commonPhrases) {
    const regex = new RegExp(phrase.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (translations[lang][phrase.en]) {
      translated = translated.replace(regex, translations[lang][phrase.en]);
    } else if (phrase[lang]) {
      translated = translated.replace(regex, phrase[lang]);
    }
  }
  
  // Try pattern matching for complex messages
  const patterns = [
    { 
      pattern: /^I found (\d+) clinic(s?) near you\. Here are the top options:$/, 
      es: (m) => `Encontré ${m[1]} clínica${m[2] ? 's' : ''} cerca de usted. Aquí están las mejores opciones:`,
      fr: (m) => `J'ai trouvé ${m[1]} clinique${m[2] ? 's' : ''} près de vous. Voici les meilleures options :`,
      pt: (m) => `Encontrei ${m[1]} clínica${m[2] ? 's' : ''} perto de você. Aqui estão as melhores opções:`
    },
    { 
      pattern: /^\*\*Option (\d+): (.+)\*\*$/, 
      es: (m) => `**Opción ${m[1]}: ${m[2]}**`,
      fr: (m) => `**Option ${m[1]} : ${m[2]}**`,
      pt: (m) => `**Opção ${m[1]}: ${m[2]}**`
    },
    { 
      pattern: /^Great! You selected \*\*Option (\d+): (.+)\*\*\.$/, 
      es: (m) => `¡Excelente! Seleccionó **Opción ${m[1]}: ${m[2]}**.`,
      fr: (m) => `Excellent ! Vous avez sélectionné **Option ${m[1]} : ${m[2]}**.`,
      pt: (m) => `Ótimo! Você selecionou **Opção ${m[1]}: ${m[2]}**.`
    },
    { 
      pattern: /^Book for (.+)\? Reply \*\*YES\*\* to call now, or \*\*CANCEL\*\* to choose a different option\.$/, 
      es: (m) => `Reservar para ${m[1]}? Responda **SÍ** para llamar ahora, o **CANCELAR** para elegir una opción diferente.`,
      fr: (m) => `Réserver pour ${m[1]} ? Répondez **OUI** pour appeler maintenant, ou **ANNULER** pour choisir une autre option.`,
      pt: (m) => `Agendar para ${m[1]}? Responda **SIM** para ligar agora, ou **CANCELAR** para escolher uma opção diferente.`
    },
    { 
      pattern: /^Book for (.+)\? Reply YES to call now, or type NEXT to see another option\.$/, 
      es: (m) => `Reservar para ${m[1]}? Responda SÍ para llamar ahora, o escriba SIGUIENTE para ver otra opción.`,
      fr: (m) => `Réserver pour ${m[1]} ? Répondez OUI pour appeler maintenant, ou tapez SUIVANT pour voir une autre option.`,
      pt: (m) => `Agendar para ${m[1]}? Responda SIM para ligar agora, ou digite PRÓXIMO para ver outra opção.`
    },
    { 
      pattern: /^Calling (.+) now to book for (.+)\. I'll confirm here\.$/, 
      es: (m) => `Llamando a ${m[1]} ahora para reservar para ${m[2]}. Confirmaré aquí.`,
      fr: (m) => `Appel de ${m[1]} maintenant pour réserver pour ${m[2]}. Je confirmerai ici.`,
      pt: (m) => `Ligando para ${m[1]} agora para agendar para ${m[2]}. Vou confirmar aqui.`
    },
    { 
      pattern: /^Based on (.+), I suggest \*\*(.+)\*\*(.+)?\.$/, 
      es: (m) => `Basado en ${m[1]}, sugiero **${m[2]}**${m[3] || ''}.`,
      fr: (m) => `Basé sur ${m[1]}, je suggère **${m[2]}**${m[3] || ''}.`,
      pt: (m) => `Com base em ${m[1]}, sugiro **${m[2]}**${m[3] || ''}.`
    },
    {
      pattern: /^Reply with the option number \((\d+)-(\d+)\) to select\.$/,
      es: (m) => `Responda con el número de opción (${m[1]}-${m[2]}) para seleccionar.`,
      fr: (m) => `Répondez avec le numéro d'option (${m[1]}-${m[2]}) pour sélectionner.`,
      pt: (m) => `Responda com o número da opção (${m[1]}-${m[2]}) para selecionar.`
    }
  ];
  
  for (const { pattern, [lang]: translator } of patterns) {
    const match = msg.match(pattern);
    if (match && translator) {
      return translator(match);
    }
  }
  
  // If translation was partially done, return it; otherwise return original
  return translated !== msg ? translated : msg;
}

/* ---------- Translate to English for clinic calls (still needs API for user input) ---------- */
async function translateToEnglish(text, sourceLang = 'auto') {
  if (!text || sourceLang === 'en' || sourceLang === 'auto') return text;
  // For now, return as-is since we don't have API. Can be improved later.
  // The clinic calls will work in English, user just needs to provide English input
  return text;
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

  // persist language if user changes it (only if supported)
  if (validLang) s.lang = validLang;
  
  // Ensure existing sessions don't have unsupported languages
  if (s.lang && !supportedLangs.includes(s.lang)) {
    s.lang = 'en';
  }

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
      say(t(`Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}. What is the patient's full name? (First Last)`));
  }
  else if (s.state === 'name') {
    s.patientName = text.trim();
    s.state = 'symptoms';
    say(t('What is the reason for the visit? (brief)'));
  }
  else if (s.state === 'symptoms') {
    s.symptoms = text.trim();
    s.state = 'zip';
    say(t('What ZIP code should I search near? (5 digits)'));
  }
  else if (s.state === 'zip') {
    if (!isValidZip(text)) { say(t('Please enter a 5-digit ZIP (e.g., 30309).')); }
    else { s.zip = text.trim(); s.state = 'ins'; say(t('Do you have insurance? (Y/N)')); }
  }
  else if (s.state === 'ins') {
    if (!ynRe.test(text)) { say(t('Please reply Y or N for insurance.')); }
    else { s.insuranceY = ynToBool(text); s.state = 'clinic_pref'; say(t('Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?')); }
  }
  else if (s.state === 'clinic_pref') {
    s.useOwnClinic = /my clinic/i.test(text);
    s.state = 'date';
    say(t('What date works best? (MM/DD/YYYY). You can also say "ASAP".'));
  }
  else if (s.state === 'date') {
    if (looksLikeASAP(text)) {
      s.dateStr = ''; s.timeStr = ''; s.windowText = 'ASAP';
      s.state = 'find';
    } else {
      const m = text.trim().match(/^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/);
      if (!m) { say(t('Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.')); }
      else { s.dateStr = `${m[1]}/${m[2]}/${m[3]}`; s.state = 'time'; say(t('Preferred time? (e.g., 10:30 AM). You can also say ASAP.')); }
    }
  }
  else if (s.state === 'time') {
    if (looksLikeASAP(text)) { s.timeStr = ''; s.windowText = 'ASAP'; s.state = 'find'; }
    else {
      const m = text.trim().match(/^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i);
      if (!m) { say(t('Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.')); }
      else { s.timeStr = `${m[1]}:${m[2]} ${m[3].toUpperCase()}`; s.windowText = `${s.dateStr}, ${s.timeStr}`; s.state = 'find'; }
    }
  }

  if (s.state === 'find') {
    // Fetch clinics (own clinic UX can be added later via saved preferences)
    const specialty = inferSpecialty(s.symptoms);
    const clinics = await findClinics(s.zip, specialty);
    s.clinics = clinics;

    if (!clinics.length) {
      say(t(`I couldn’t find clinics nearby. Please check the ZIP or try a broader area.`));
      s.state = 'zip';
    } else {
      // pick the best candidate and explain
      const best = clinics[0];
      s.chosenClinic = { name: best.name, phone: best.phone, address: best.address, rating: best.rating };

      const reason =
        s.useOwnClinic ? 'your usual clinic preference'
        : (specialty !== 'clinic' ? `your symptoms indicating ${specialty}` : 'distance and availability');

      say(t(`Based on ${reason}, I suggest **${best.name}**${best.address?` — ${best.address}`:''}${best.rating?` (rating ${best.rating}/5)`:''}.`));
      say(t(`Book for ${s.windowText}? Reply YES to call now, or type NEXT to see another option.`));
      s.state = 'confirm_choice';
    }
  }
  else if (s.state === 'confirm_choice') {
    if (/^next\b/i.test(text)) {
      const list = s.clinics || [];
      const idx = list.findIndex(c => c.name === s.chosenClinic?.name);
      const nxt = list[idx + 1];
      if (!nxt) { say(t('No more options. Type YES to proceed or RESET to start again.')); }
      else {
        s.chosenClinic = { name: nxt.name, phone: nxt.phone, address: nxt.address, rating: nxt.rating };
        say(t(`Option: **${nxt.name}**${nxt.address?` — ${nxt.address}`:''}${nxt.rating?` (rating ${nxt.rating}/5)`:''}.`));
        say(t(`Book for ${s.windowText}? Reply YES to call, or NEXT for another.`));
      }
      } else if (/^yes\b/i.test(text)) {
        if (s.state !== 'final_confirm') {
          // If they said YES but haven't selected an option yet, show options again
          say(t('Please select an option first. Reply **1**, **2**, or **3** to choose a clinic.'));
        } else if (!s?.chosenClinic?.phone) {
          say(t('This clinic did not list a phone number via Maps. Please select a different option (1, 2, or 3).'));
          s.state = 'confirm_choice';
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
        say(t(`Calling ${s.chosenClinic.name} now to book for ${s.windowText}. I’ll confirm here.`));
      }
    } else if (/^reset|restart|new$/i.test(text)) {
      s = { state:'start', lang:s.lang }; say(t('Reset. Type NEW to begin.'));
    } else {
      say(t('Please reply YES to book, NEXT for another option, or RESET to start over.'));
    }
  }

  smsSessions.set(from, s);
  return res.json({ ok:true, lines: LINES });
});

/* ---------- Web chat endpoint (for web UI) ---------- */
/**
 * Body: { message: string, source: string, lang?: 'en'|'es'|'pt'|'fr' }
 * Returns: { reply: string }
 */
app.post('/chat/web', async (req, res) => {
  const { message, source, lang, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  // Validate and sanitize language - only allow supported languages
  const supportedLangs = ['en', 'es', 'fr', 'pt'];
  const validLang = (lang && supportedLangs.includes(lang)) ? lang : 'en';

  // Use sessionId from client if provided, otherwise use IP-based session
  // This allows better session persistence across page refreshes
  const from = sessionId ? `web-${sessionId}` : `web-${req.ip || req.headers['x-forwarded-for'] || 'default'}`;
  const text = message.trim();

  // Reuse the same chat logic
  let s = smsSessions.get(from) || {
    state: 'start',
    lang: validLang,
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
    callback: ''
  };

  // Always update language if provided (for language selector)
  // This ensures language changes are immediately applied to existing sessions
  // Only update if the language is supported
  if (validLang && validLang !== s.lang) {
    console.log(`Language changed from ${s.lang} to ${validLang} for session ${from}`);
    s.lang = validLang;
    // Save immediately so language persists
    smsSessions.set(from, s);
  }
  
  // Ensure existing sessions don't have unsupported languages
  if (s.lang && !supportedLangs.includes(s.lang)) {
    console.log(`Fixing unsupported language ${s.lang} to 'en' for session ${from}`);
    s.lang = 'en';
    smsSessions.set(from, s);
  }
  
  // Log current language for debugging
  console.log(`Current session language: ${s.lang || 'en'} (requested: ${lang || 'none'}, validated: ${validLang})`);

  const LINES = [];
  const say = (m) => LINES.push(m);

  // Simple synchronous translation using dictionary (no API calls)
  function t(msg) {
    if (!msg || msg.trim().length === 0) return msg;
    const currentLang = s.lang || 'en';
    return translateText(msg, currentLang);
  }

  function looksLikeASAP(str){ return /\b(asap|as soon as possible|soonest|earliest)\b/i.test(str||''); }

  // Handle language change messages silently
  if (/^\[Language changed to (\w+)\]$/i.test(text)) {
    const langMatch = text.match(/^\[Language changed to (\w+)\]$/i);
    if (langMatch && langMatch[1]) {
      s.lang = langMatch[1];
      smsSessions.set(from, s);
      return res.json({ reply: '' }); // Silent response for language change
    }
  }
  
  // Ensure language is always up to date from the request (double-check after language change message)
  // Only update if the language is supported
  if (validLang && validLang !== s.lang) {
    s.lang = validLang;
    smsSessions.set(from, s); // Save immediately
  }
  
  // Handle quick actions
  if (/^use my usual clinic/i.test(text)) {
    s.useOwnClinic = true;
    if (s.state === 'clinic_pref') {
      s.state = 'date';
      say(t('What date works best? (MM/DD/YYYY). You can also say "ASAP".'));
    } else {
      say(t('Noted. I\'ll use your usual clinic when we get to that step.'));
    }
  } else if (/^show nearby clinics|nearby/i.test(text)) {
    s.useOwnClinic = false;
    if (s.state === 'clinic_pref') {
      s.state = 'date';
      say(t('What date works best? (MM/DD/YYYY). You can also say "ASAP".'));
    } else {
      say(t('Noted. I\'ll search for nearby clinics when we get to that step.'));
    }
  } else {
    // state machine (same as /chat)
    if (s.state === 'start' || /^new$/i.test(text)) {
      console.log(`[NEW] Starting new conversation. Current language: ${s.lang || 'en'}, Request lang: ${lang || 'none'}`);
      s.state = 'name';
      const welcomeMsg = `Welcome to ${BRAND_NAME} — ${BRAND_SLOGAN}. What is the patient's full name? (First Last)`;
      console.log(`[NEW] Welcome message (before translation): "${welcomeMsg}"`);
      const translatedWelcome = t(welcomeMsg);
      console.log(`[NEW] Welcome message (after translation): "${translatedWelcome}"`);
      say(translatedWelcome);
    }
    else if (s.state === 'name') {
      s.patientName = text.trim();
      s.state = 'symptoms';
      say(t('What is the reason for the visit? (brief)'));
    }
    else if (s.state === 'symptoms') {
      s.symptoms = text.trim();
      s.state = 'zip';
      say(t('What ZIP code should I search near? (5 digits)'));
    }
    else if (s.state === 'zip') {
      if (!isValidZip(text)) { say(t('Please enter a 5-digit ZIP (e.g., 30309).')); }
      else { s.zip = text.trim(); s.state = 'ins'; say(t('Do you have insurance? (Y/N)')); }
    }
    else if (s.state === 'ins') {
      if (!ynRe.test(text)) { say(t('Please reply Y or N for insurance.')); }
      else { s.insuranceY = ynToBool(text); s.state = 'clinic_pref'; say(t('Do you want your usual clinic (type "My clinic") or search nearby (type "Nearby")?')); }
    }
    else if (s.state === 'clinic_pref') {
      s.useOwnClinic = /my clinic/i.test(text);
      s.state = 'date';
      say(t('What date works best? (MM/DD/YYYY). You can also say "ASAP".'));
    }
    else if (s.state === 'date') {
      if (looksLikeASAP(text)) {
        s.dateStr = ''; s.timeStr = ''; s.windowText = 'ASAP';
        s.state = 'find';
      } else {
        const m = text.trim().match(/^\s*(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\s*$/);
        if (!m) { say(t('Please use MM/DD/YYYY (e.g., 10/25/2025), or say ASAP.')); }
        else { s.dateStr = `${m[1]}/${m[2]}/${m[3]}`; s.state = 'time'; say(t('Preferred time? (e.g., 10:30 AM). You can also say ASAP.')); }
      }
    }
    else if (s.state === 'time') {
      if (looksLikeASAP(text)) { s.timeStr = ''; s.windowText = 'ASAP'; s.state = 'find'; }
      else {
        const m = text.trim().match(/^\s*(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)\s*$/i);
        if (!m) { say(t('Use HH:MM AM/PM (e.g., 10:30 AM), or say ASAP.')); }
        else { s.timeStr = `${m[1]}:${m[2]} ${m[3].toUpperCase()}`; s.windowText = `${s.dateStr}, ${s.timeStr}`; s.state = 'find'; }
      }
    }

    if (s.state === 'find') {
      const specialty = inferSpecialty(s.symptoms);
      const clinics = await findClinics(s.zip, specialty);
      s.clinics = clinics;

      if (!clinics.length) {
        say(t(`I couldn't find clinics nearby. Please check the ZIP or try a broader area.`));
        s.state = 'zip';
      } else {
        // Show top 3 clinics with pros/cons
        const topClinics = clinics.slice(0, 3);
        s.chosenClinic = { name: topClinics[0].name, phone: topClinics[0].phone, address: topClinics[0].address, rating: topClinics[0].rating };

        say(t(`I found ${clinics.length} clinic${clinics.length > 1 ? 's' : ''} near you. Here are the top options:`));
        say(t('')); // Empty line for spacing

        for (let i = 0; i < topClinics.length; i++) {
          const clinic = topClinics[i];
          const pros = [];
          const cons = [];

          // Pros
          if (clinic.rating && clinic.rating >= 4.5) pros.push(`⭐ High rating (${clinic.rating}/5)`);
          else if (clinic.rating && clinic.rating >= 4.0) pros.push(`⭐ Good rating (${clinic.rating}/5)`);
          if (i === 0) pros.push('📍 Closest option');
          if (clinic.address) pros.push(`📍 ${clinic.address}`);

          // Cons
          if (clinic.rating && clinic.rating < 4.0) cons.push(`⚠️ Lower rating (${clinic.rating}/5)`);
          if (!clinic.phone) cons.push('⚠️ Phone number not available');

          const clinicNum = i + 1;
          say(t(`**Option ${clinicNum}: ${clinic.name}**`));
          
          if (pros.length > 0) {
            say(t(`✅ Pros: ${pros.join(', ')}`));
          }
          if (cons.length > 0) {
            say(t(`❌ Cons: ${cons.join(', ')}`));
          }
          
          say(t('')); // Empty line between options
        }

        say(t(`Which option would you like? Reply **1**, **2**, or **3** to select, or type **NEXT** to see more options.`));
        s.state = 'confirm_choice';
      }
    }
    else if (s.state === 'confirm_choice') {
      // Handle numeric selection (1, 2, 3)
      const numMatch = text.trim().match(/^(\d+)$/);
      if (numMatch) {
        const selectedNum = parseInt(numMatch[1]);
        const topClinics = (s.clinics || []).slice(0, 3);
        if (selectedNum >= 1 && selectedNum <= topClinics.length) {
          const selected = topClinics[selectedNum - 1];
          s.chosenClinic = { name: selected.name, phone: selected.phone, address: selected.address, rating: selected.rating };
          say(t(`Great! You selected **Option ${selectedNum}: ${selected.name}**.`));
          say(t(`Book for ${s.windowText}? Reply **YES** to call now, or **CANCEL** to choose a different option.`));
          s.state = 'final_confirm';
        } else {
          say(t(`Please select option 1, 2, or 3.`));
        }
      }
      else if (/^next\b/i.test(text)) {
        const list = s.clinics || [];
        const shownCount = Math.min(3, list.length);
        const remaining = list.slice(shownCount);
        if (remaining.length === 0) { 
          say(t('No more options. Please select from options 1, 2, or 3, or type RESET to start again.')); 
        } else {
          say(t(`Here are more options:`));
          say(t(''));
          for (let i = 0; i < Math.min(3, remaining.length); i++) {
            const clinic = remaining[i];
            const optionNum = shownCount + i + 1;
            const pros = [];
            const ratingText = t('rating');
            if (clinic.rating && clinic.rating >= 4.0) pros.push(`⭐ ${ratingText}: ${clinic.rating}/5`);
            if (clinic.address) pros.push(`📍 ${clinic.address}`);
            say(t(`**Option ${optionNum}: ${clinic.name}**${pros.length > 0 ? ` — ${pros.join(', ')}` : ''}`));
          }
          say(t(`Reply with the option number (${shownCount + 1}-${shownCount + Math.min(3, remaining.length)}) to select.`));
        }
      } else if (/^yes\b/i.test(text) && s.state === 'final_confirm') {
        if (!s?.chosenClinic?.phone) {
          say(t('This clinic did not list a phone number via Maps. Reply NEXT for another option.'));
        } else {
          const nameEn   = await translateToEnglish(s.patientName, s.lang || 'auto');
          const reasonEn = await translateToEnglish(s.symptoms,   s.lang || 'auto');

          await startClinicCall({
            to: s.chosenClinic.phone,
            name: nameEn,
            reason: reasonEn,
            preferredTimes: [s.windowText],
            clinicName: s.chosenClinic.name,
            callback: ''
          });

          s.state = 'calling';
          say(t(`Calling ${s.chosenClinic.name} now to book for ${s.windowText}. I'll confirm here.`));
        }
      } else if (/^cancel\b/i.test(text) && s.state === 'final_confirm') {
        s.state = 'confirm_choice';
        say(t('Cancelled. Please select option **1**, **2**, or **3** to choose a clinic.'));
      } else if (/^reset|restart|new$/i.test(text)) {
        // Preserve language when resetting (but ensure it's supported)
        const preservedLang = (s.lang && supportedLangs.includes(s.lang)) ? s.lang : 'en';
        console.log(`[RESET] Resetting state, preserving language: ${preservedLang}`);
        s = { 
          state:'start', 
          lang: preservedLang,
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
          callback: ''
        };
        say(t('Reset. Type NEW to begin.'));
      } else {
        if (s.state === 'final_confirm') {
          say(t('Please reply **YES** to book, **CANCEL** to choose a different option, or **RESET** to start over.'));
        } else {
          say(t('Please reply with option number (**1**, **2**, or **3**) to select, **NEXT** for more options, or **RESET** to start over.'));
        }
      }
    }
  }

  smsSessions.set(from, s);
  
  // Combine all lines into a single reply for web UI
  const reply = LINES.join('\n\n');
  return res.json({ reply });
});

/* ---------- Health ---------- */
app.get('/healthz', (req,res)=>res.json({ ok:true }));

/* ---------- Start ---------- */
app.listen(PORT, ()=> console.log(`Clarity concierge listening on ${PORT}`));
