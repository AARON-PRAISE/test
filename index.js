const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------- ENV ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID?.replace(/\\n/g, '').replace(/[\r\n]/g, '').trim();
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL?.replace(/\\n/g, '').replace(/[\r\n]/g, '').trim();
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;
const IMAGE_WORKER_URL = process.env.IMAGE_WORKER_URL;

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID missing');
if (!FIREBASE_CLIENT_EMAIL) throw new Error('FIREBASE_CLIENT_EMAIL missing');
if (!FIREBASE_PRIVATE_KEY) throw new Error('FIREBASE_PRIVATE_KEY missing');
if (!IMAGE_WORKER_URL) throw new Error('IMAGE_WORKER_URL missing');

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
  if (val && typeof val === 'object' && val.__type === 'reference') {
    return {
      referenceValue: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${val.path}`,
    };
  }
  if (typeof val === 'number') return { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val))
    return { arrayValue: { values: val.map((v) => toFirestoreValue(v)) } };
  if (val !== null && typeof val === 'object')
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(val).map(([k, v]) => [k, toFirestoreValue(v)])
        ),
      },
    };
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
  if (!res.ok) throw new Error(`Firestore create failed: ${JSON.stringify(result)}`);
  return result.name.split('/').pop();
}

async function firestoreUpdate(docPath, data, token) {
  const fieldPaths = Object.keys(data).join('&updateMask.fieldPaths=');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}?updateMask.fieldPaths=${fieldPaths}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore update failed: ${await res.text()}`);
}

// ---------------- FIRESTORE QUERY ----------------
async function firestoreQueryTimetablesByUser(userId, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: 'Timetable' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'userId' },
          op: 'EQUAL',
          value: { stringValue: userId },
        },
      },
      select: {
        fields: [{ fieldPath: '__name__' }],
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const results = await res.json();
  if (!res.ok) throw new Error(`Firestore query failed: ${JSON.stringify(results)}`);

  return results
    .filter((r) => r.document?.name)
    .map((r) => r.document.name.split('/').pop());
}

// ---------------- HELPERS ----------------
function exactly12(arr) {
  const out = Array.isArray(arr) ? arr.map(String) : [];
  while (out.length < 12) out.push('');
  return out.slice(0, 12);
}

function ensureArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim());
  return [];
}

// ---------------- OPENAI PROMPT ----------------
function buildMessages(input) {
  const availableIngredients = input.availableIngredients || [];

  return [
    {
      role: 'system',
      content: `
You are a professional Nigerian meal planner. Generate a COMPLETE 7-day meal plan.

The user has these ingredients already available: ${JSON.stringify(availableIngredients)}

For EACH day (Sunday–Saturday) and EACH meal (breakfast, lunch, dinner), generate:
- name
- description
- ingredients_used: string array of ALL ingredients needed for this meal
- additional_ingredients_to_buy: array of OBJECTS for ingredients NOT found in the available list above.
    Each object MUST have exactly these fields:
    { "name": string, "cost": integer (in Naira), "description": string }
    IMPORTANT: Only include ingredients the user does NOT already have. If the user has all ingredients, return an empty array [].
- instructions: string array of 9 to 12 steps
- equipment: string array
- estimated_cost: integer in Naira
- image_prompts:
    - food
    - step_1
    - step_5
    - step_9 (only if step 9 exists)

Rules:
- Nigerian meals only
- Photorealistic food images
- Append "low quality" to ALL image prompts
- Return ONLY valid JSON with no extra text, no markdown, no code fences
- DO NOT omit any day or any meal
- additional_ingredients_to_buy MUST be an array of objects, NEVER an array of strings

Required JSON structure:
{
  "weekly_meal_plan": {
    "sunday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "monday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "tuesday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "wednesday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "thursday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "friday": { "breakfast": {}, "lunch": {}, "dinner": {} },
    "saturday": { "breakfast": {}, "lunch": {}, "dinner": {} }
  }
}
      `.trim(),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

// ---------------- VALIDATION ----------------
function validateWeek(week) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of days) {
    if (!week[day]) throw new Error(`Missing day: ${day}`);
    for (const meal of ['breakfast', 'lunch', 'dinner']) {
      if (!week[day][meal]) throw new Error(`Missing ${meal} on ${day}`);
    }
  }
}

// ---------------- DAY BUILDER ----------------
function buildDay(day, imagePromptMap, dayName) {
  const out = {};
  for (const type of ['breakfast', 'lunch', 'dinner']) {
    const m = day[type];
    const P = type.charAt(0).toUpperCase() + type.slice(1);

    const missingIngredients = Array.isArray(m.additional_ingredients_to_buy)
      ? m.additional_ingredients_to_buy.map((i) =>
          typeof i === 'object' ? String(i.name || '') : String(i)
        )
      : [];

    out[`${P}Name`] = m.name ?? '';
    out[`${P}Description`] = m.description ?? '';
    out[`${P}Ingredients`] = ensureArray(m.ingredients_used);
    out[`MissingIngredients${P}`] = missingIngredients;
    out[`${P}Instructions`] = exactly12(m.instructions);
    out[`${P}Equipment`] = ensureArray(m.equipment);
    out[`${type}cost`] = Number(m.estimated_cost) || 0;
    out[`${P}Image`] = '';
    out[`${P}InstructionImages`] = [];

    if (m.image_prompts) {
      if (!imagePromptMap[dayName]) imagePromptMap[dayName] = {};
      imagePromptMap[dayName][P] = [
        { key: `${P}Meal`, prompt: m.image_prompts.food },
        { key: `${P}Step1`, prompt: m.image_prompts.step_1 },
        { key: `${P}Step5`, prompt: m.image_prompts.step_5 },
        ...(m.image_prompts.step_9
          ? [{ key: `${P}Step9`, prompt: m.image_prompts.step_9 }]
          : []),
      ];
      console.log(`🔍 Prompts for ${dayName} ${P}:`, JSON.stringify(imagePromptMap[dayName][P]));
    }
  }
  return out;
}

// ---------------- SHOPPING LIST BUILDER ----------------
function buildShoppingList(week) {
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const mealTypes = ['breakfast', 'lunch', 'dinner'];
  const seen = new Map();

  for (const day of dayKeys) {
    for (const meal of mealTypes) {
      const m = week[day][meal];
      const items = Array.isArray(m.additional_ingredients_to_buy)
        ? m.additional_ingredients_to_buy
        : [];

      for (const item of items) {
        if (typeof item !== 'object' || !item.name) continue;
        const key = String(item.name).toLowerCase().trim();
        if (!key) continue;
        if (!seen.has(key)) {
          seen.set(key, {
            Name: String(item.name || ''),
            Cost: Number(item.cost) || 0,
            Description: String(item.description || ''),
          });
        }
      }
    }
  }

  const items = Array.from(seen.values());
  const totalCost = items.reduce((sum, i) => sum + i.Cost, 0);
  return { totalCost, items };
}

// ---------------- BACKGROUND JOB ----------------
async function processInBackground(payload) {
  try {
    const token = await getAccessToken();

    // 1️⃣ Create new Timetable doc — Recent: true, status: 'creating'
    const timetableId = await firestoreCreate(
      'Timetable',
      {
        userId: payload.userId,
        user: { __type: 'reference', path: `users/${payload.userId}` },
        status: 'creating',  // ✅ image worker will set this to 'completed'
        Recent: true,
        created_at: new Date().toISOString(),
      },
      token
    );
    console.log('📄 Timetable doc created with ID:', timetableId);

    // 2️⃣ Set all OTHER Timetable docs for this user to Recent: false
    console.log('🔍 Querying existing Timetable docs for user:', payload.userId);
    const allDocIds = await firestoreQueryTimetablesByUser(payload.userId, token);
    const otherDocIds = allDocIds.filter((id) => id !== timetableId);

    console.log(`📋 Found ${otherDocIds.length} previous Timetable(s) — setting Recent: false`);
    await Promise.all(
      otherDocIds.map((docId) =>
        firestoreUpdate(`Timetable/${docId}`, { Recent: false }, token)
      )
    );
    console.log('✅ All previous Timetables marked as Recent: false');

    // 3️⃣ Call OpenAI
    console.log('🤖 Calling OpenAI for weekly meal plan...');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: buildMessages(payload),
        max_tokens: 16000,
      }),
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`OpenAI error: ${raw}`);
    console.log('✅ OpenAI returned a response');

    const openAIResult = JSON.parse(raw);
    const content = openAIResult.choices[0].message.content;

    let jsonStr = content.replace(/```json|```/g, '').trim();
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    const week = parsed.weekly_meal_plan;

    // 4️⃣ Validate week
    validateWeek(week);
    console.log('📅 Weekly meal plan validated');

    // 5️⃣ Build timetable data + extract image prompts
    const promptsByDay = {};
    const timetableData = {
      Sunday: buildDay(week.sunday, promptsByDay, 'Sunday'),
      Monday: buildDay(week.monday, promptsByDay, 'Monday'),
      Tuesday: buildDay(week.tuesday, promptsByDay, 'Tuesday'),
      Wednesday: buildDay(week.wednesday, promptsByDay, 'Wednesday'),
      Thursday: buildDay(week.thursday, promptsByDay, 'Thursday'),
      Friday: buildDay(week.friday, promptsByDay, 'Friday'),
      Saturday: buildDay(week.saturday, promptsByDay, 'Saturday'),
      // ✅ status intentionally NOT set here — image worker sets it to 'completed'
      updated_at: new Date().toISOString(),
    };
    console.log('🛠️ Timetable data built. Prompts extracted for image generation');

    // 6️⃣ Save meal plan to Firestore
    await firestoreUpdate(`Timetable/${timetableId}`, timetableData, token);
    console.log('✅ Meal plan saved to Firestore:', timetableId);

    // 7️⃣ Build and save ShoppingList
    console.log('🛒 Building ShoppingList from missing ingredients across all 21 meals...');
    const { totalCost, items } = buildShoppingList(week);

    const shoppingListData = {
      TotalCost: totalCost,
      userID: { __type: 'reference', path: `users/${payload.userId}` },
      Detail: items,
    };

    const shoppingListId = await firestoreCreate('ShoppingList', shoppingListData, token);
    console.log('✅ ShoppingList saved to Firestore:', shoppingListId);
    console.log(`   → ${items.length} unique items, Total Cost: ₦${totalCost}`);

    // 8️⃣ Call image worker — passes timetableId and all prompts
    console.log('🖼️ Triggering image generation via WaveSpeed worker...');
    try {
      const waveRes = await fetch(IMAGE_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timetableId, promptsByDay }),
      });
      console.log(`📡 WaveSpeed worker called. Status: ${waveRes.status}`);
      const waveText = await waveRes.text();
      console.log('📥 WaveSpeed response body:', waveText);
    } catch (err) {
      console.error('❌ Failed to call WaveSpeed worker:', err.message);
    }

    console.log('🚀 processInBackground complete');
  } catch (err) {
    console.error('❌ Meal planner failed:', err.message);
  }
}

// ---------------- ROUTE ----------------
app.post('/generate-timetable', (req, res) => {
  if (!req.body?.userId) return res.status(400).json({ error: 'userId required' });
  res.json({ success: true, status: 'processing' });
  processInBackground(req.body);
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------- START ----------------
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🍽️ Meal planner worker running on port ${PORT}`)
);
