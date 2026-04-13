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

// ---------------- FIRESTORE USER REF ----------------
function buildUserRef(userId) {
  return {
    referenceValue: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}`
  };
}

// ---------------- JWT / FIREBASE AUTH ----------------
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

  function base64url(obj) {
    return btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  const headerB64 = base64url({ alg: 'RS256', typ: 'JWT' });
  const payloadB64 = base64url({
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
    scope: 'https://www.googleapis.com/auth/datastore',
  });

  const signingInput = `${headerB64}.${payloadB64}`;

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
  if (!data.access_token) throw new Error('Failed to get Firebase access token');
  return data.access_token;
}

// ---------------- FIRESTORE HELPERS ----------------
function toFirestoreValue(val) {
  if (typeof val === 'number') return { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (val !== null && typeof val === 'object')
    return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFirestoreValue(v)])) } };
  return { stringValue: String(val ?? '') };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const key in obj) fields[key] = toFirestoreValue(obj[key]);
  return fields;
}

async function firestoreCreate(collection, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });

  const result = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(result));

  return result.name.split('/').pop();
}

// ---------------- SHOPPING LIST ----------------
async function createShoppingItem(item, userId, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/ShoppingList`;

  const body = {
    fields: {
      Name: { stringValue: item.name || '' },
      Cost: { integerValue: String(item.cost || 0) },
      Description: { stringValue: item.description || '' },
      userID: buildUserRef(userId),
      TotalCost: { integerValue: String(item.cost || 0) }
    }
  };

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// ---------------- OPENAI ----------------
function buildMessages(input) {
  return [
    {
      role: 'system',
      content: `
You are a Nigerian meal planner.

Generate:
1. 7-day meal plan (breakfast, lunch, dinner)
2. missing_ingredients based on available ingredients

Return JSON ONLY:
{
  "weekly_meal_plan": {...},
  "missing_ingredients": [
    {
      "name": "",
      "cost": 0,
      "description": ""
    }
  ]
}
      `.trim(),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

// ---------------- MAIN LOGIC ----------------
async function processInBackground(payload) {
  try {
    const token = await getAccessToken();

    // 1️⃣ CREATE TIMETABLE (FIXED USER FIELD)
    const timetableId = await firestoreCreate(
      'Timetable',
      {
        user: buildUserRef(payload.userId),
        status: 'creating',
        created_at: new Date().toISOString()
      },
      token
    );

    console.log('📄 Timetable created:', timetableId);

    // 2️⃣ OPENAI CALL
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: buildMessages(payload),
        max_tokens: 7000,
      }),
    });

    const raw = await res.text();
    const parsed = JSON.parse(JSON.parse(raw).choices[0].message.content);

    const week = parsed.weekly_meal_plan;
    const missing = parsed.missing_ingredients || [];

    console.log('✅ OpenAI processed');

    // 3️⃣ SAVE TIMETABLE
    await firestoreCreate(`Timetable/${timetableId}`, {
      status: 'completed',
      updated_at: new Date().toISOString()
    }, token);

    console.log('✅ Timetable saved');

    // 4️⃣ CREATE SHOPPING LIST ITEMS
    console.log('🛒 Creating shopping list...');

    for (const item of missing) {
      await createShoppingItem(item, payload.userId, token);
    }

    console.log('✅ Shopping list created');

    // 5️⃣ TRIGGER IMAGE WORKER
    await fetch(IMAGE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timetableId,
        promptsByDay: parsed.promptsByDay || {}
      }),
    });

    console.log('🖼️ Image worker triggered');

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// ---------------- ROUTE ----------------
app.post('/generate-timetable', (req, res) => {
  if (!req.body?.userId) return res.status(400).json({ error: 'userId required' });

  res.json({ status: 'processing' });
  processInBackground(req.body);
});

// ---------------- START ----------------
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
