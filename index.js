const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

// ---------------- SAFE PORT ----------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---------------- ENV ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;
const IMAGE_WORKER_URL = process.env.IMAGE_WORKER_URL;

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID missing');
if (!FIREBASE_CLIENT_EMAIL) throw new Error('FIREBASE_CLIENT_EMAIL missing');
if (!FIREBASE_PRIVATE_KEY) throw new Error('FIREBASE_PRIVATE_KEY missing');
if (!IMAGE_WORKER_URL) throw new Error('IMAGE_WORKER_URL missing');

// ---------------- LOGGING HELPERS ----------------
const log = {
  info: (msg) => console.log(`ℹ️ ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.log(`⚠️ ${msg}`),
  error: (msg) => console.log(`❌ ${msg}`),
  step: (msg) => console.log(`➡️ ${msg}`)
};

// ---------------- FIREBASE AUTH (UNCHANGED) ----------------
function str2ab(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '')
    .replace(/[\r\n\s]/g, '');

  const binary = atob(clean);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

async function getAccessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const base64url = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64url({
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
    scope: 'https://www.googleapis.com/auth/datastore',
  });

  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    str2ab(FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${signingInput}.${sigB64}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get Firebase token');
  return data.access_token;
}

// ---------------- FIRESTORE ----------------
function toFirestoreValue(val) {
  if (typeof val === 'number') return { doubleValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (val && typeof val === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(val).map(([k, v]) => [k, toFirestoreValue(v)])
        )
      }
    };
  }
  return { stringValue: String(val ?? '') };
}

function toFirestoreFields(obj) {
  const out = {};
  for (const k in obj) out[k] = toFirestoreValue(obj[k]);
  return out;
}

async function firestoreCreate(collection, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });

  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));

  return json.name.split('/').pop();
}

async function firestoreUpdate(docPath, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });

  if (!res.ok) throw new Error(await res.text());
}

// ---------------- OPENAI ----------------
function buildMessages(payload) {
  return [
    {
      role: 'system',
      content: `
You are a Nigerian meal planner.

Return STRICT JSON only.

Include:
1. weekly_meal_plan (7 days)
2. shopping_list (array)

Each shopping item:
- name
- cost
- description

IMPORTANT:
- No markdown
- No backticks
- Valid JSON only
      `.trim()
    },
    {
      role: 'user',
      content: JSON.stringify(payload)
    }
  ];
}

// ---------------- BACKGROUND PROCESS ----------------
async function process(payload) {
  try {
    log.step('Starting process...');

    const token = await getAccessToken();

    // 1. CREATE TIMETABLE
    log.step('Creating timetable...');
    const timetableId = await firestoreCreate('Timetable', {
      user: `/users/${payload.userId}`,
      status: 'creating',
      created_at: new Date().toISOString()
    }, token);

    log.success(`Timetable created: ${timetableId}`);

    // 2. OPENAI
    log.step('Calling OpenAI...');
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: buildMessages(payload),
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });

    const raw = await aiRes.text();
    const parsed = JSON.parse(raw);
    const content = JSON.parse(parsed.choices[0].message.content);

    log.success('OpenAI response received');

    // 3. SHOPPING LIST
    const shoppingList = content.shopping_list || [];

    log.step(`Creating ${shoppingList.length} shopping items...`);

    for (const item of shoppingList) {
      await firestoreCreate('ShoppingList', {
        userID: payload.userId,
        TotalCost: item.cost || 0,
        Details: {
          Name: item.name || '',
          Cost: item.cost || 0,
          Description: item.description || ''
        }
      }, token);
    }

    log.success('Shopping list saved');

    // 4. SAVE TIMETABLE
    await firestoreUpdate(`Timetable/${timetableId}`, {
      status: 'completed'
    }, token);

    log.success('Timetable updated');

    // 5. CALL IMAGE WORKER
    log.step('Triggering image worker...');

    const imgRes = await fetch(IMAGE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timetableId,
        promptsByDay: content.promptsByDay || {}
      })
    });

    log.success(`Image worker status: ${imgRes.status}`);

    log.step('Process complete');

  } catch (err) {
    log.error(err.message);
  }
}

// ---------------- ROUTE ----------------
app.post('/generate-timetable', (req, res) => {
  if (!req.body?.userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  res.json({ status: 'processing' });
  process(req.body);
});

// ---------------- HEALTH ----------------
app.get('/health', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------- START ----------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
