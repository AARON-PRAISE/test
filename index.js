const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

// ---------------- FIRESTORE REFERENCE ----------------
function userRef(userId) {
  return `/users/${userId}`;
}

// ---------------- JWT ----------------
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
  if (!data.access_token) throw new Error('Failed Firebase token');
  return data.access_token;
}

// ---------------- FIRESTORE ----------------
function toFirestore(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestore) } };
  if (typeof v === 'object' && v !== null) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(v).map(([k, val]) => [k, toFirestore(val)])
        ),
      },
    };
  }
  return { stringValue: String(v ?? '') };
}

async function createDoc(collection, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: Object.fromEntries(
      Object.entries(data).map(([k,v]) => [k, toFirestore(v)])
    )}),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));

  return json.name.split('/').pop();
}

async function updateDoc(path, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: Object.fromEntries(
        Object.entries(data).map(([k,v]) => [k, toFirestore(v)])
      ),
    }),
  });

  if (!res.ok) throw new Error(await res.text());
}

// ---------------- OPENAI ----------------
function buildMessages(input) {
  return [
    {
      role: 'system',
      content: `
You are a Nigerian meal planner.
Return 7-day meal plan.
Include ingredients_used and missing_ingredients based on available ingredients.
      `,
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

// ---------------- MAIN ----------------
async function process(payload) {
  try {
    const token = await getAccessToken();

    // 1. Create timetable
    const timetableId = await createDoc('Timetable', {
      userId: payload.userId,              // string
      user: userRef(payload.userId),       // reference
      status: 'creating',
      created_at: new Date().toISOString(),
    }, token);

    console.log("Timetable ID:", timetableId);

    // 2. OpenAI
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: buildMessages(payload),
      }),
    });

    const raw = await res.text();
    const json = JSON.parse(raw);

    const plan = JSON.parse(json.choices[0].message.content);

    // 3. Update timetable
    await updateDoc(`Timetable/${timetableId}`, {
      status: 'completed',
      plan,
    }, token);

    // 4. Trigger image worker
    await fetch(IMAGE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timetableId,
        promptsByDay: plan.promptsByDay || {}
      }),
    });

  } catch (e) {
    console.error("ERROR:", e.message);
  }
}

// ---------------- ROUTE ----------------
app.post('/generate-timetable', (req, res) => {
  res.json({ status: 'processing' });
  process(req.body);
});

app.listen(PORT, () => console.log("Server running"));
