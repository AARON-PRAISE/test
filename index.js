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

if (!OPENAI_API_KEY || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !IMAGE_WORKER_URL) {
  throw new Error("Missing ENV variables");
}

// ---------------- USER REFERENCE ----------------
const userRef = (userId) => `/users/${userId}`;

// ---------------- FIRESTORE CONVERTER ----------------
function toFirestore(v) {
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestore) } };
  }

  if (v && typeof v === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(v).map(([k, val]) => [k, toFirestore(val)])
        ),
      },
    };
  }

  if (typeof v === 'number') return { doubleValue: v };
  return { stringValue: String(v ?? '') };
}

// ---------------- CREATE DOC ----------------
async function createDoc(collection, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, toFirestore(v)])
      ),
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));

  return json.name.split('/').pop();
}

// ---------------- UPDATE DOC ----------------
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
        Object.entries(data).map(([k, v]) => [k, toFirestore(v)])
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

Return JSON with:
1. weekly_meal_plan
2. shopping_list

shopping_list must be:
[
  {
    "Name": "",
    "Cost": 0,
    "Description": ""
  }
]

Rules:
- Use ONLY available ingredients
- Compute missing ingredients
- Provide estimated costs
      `.trim(),
    },
    {
      role: 'user',
      content: JSON.stringify(input),
    },
  ];
}

// ---------------- ACCESS TOKEN (simplified kept same) ----------------
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: process.env.FIREBASE_JWT || '',
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Token failed");
  return data.access_token;
}

// ---------------- MAIN PROCESS ----------------
async function process(payload) {
  try {
    const token = await getAccessToken();

    // 1. Create timetable
    const timetableId = await createDoc("Timetable", {
      userId: payload.userId,
      user: userRef(payload.userId),
      status: "creating",
      created_at: new Date().toISOString(),
    }, token);

    console.log("Timetable:", timetableId);

    // 2. OpenAI
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: buildMessages(payload),
      }),
    });

    const raw = await res.text();
    const json = JSON.parse(raw);

    const data = JSON.parse(json.choices[0].message.content);

    const plan = data.weekly_meal_plan;
    const shopping = data.shopping_list || [];

    // 3. Save timetable
    await updateDoc(`Timetable/${timetableId}`, {
      status: "completed",
      plan,
    }, token);

    // 4. Create ShoppingList document
    let totalCost = 0;

    const formattedDetails = shopping.map(item => {
      totalCost += Number(item.Cost || 0);

      return {
        Name: item.Name,
        Cost: Number(item.Cost || 0),
        Description: item.Description
      };
    });

    await createDoc("ShoppingList", {
      userID: userRef(payload.userId),
      Detail: formattedDetails,
      TotalCost: totalCost
    }, token);

    // 5. Trigger image worker
    await fetch(IMAGE_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timetableId,
        promptsByDay: plan.promptsByDay || {}
      }),
    });

    console.log("DONE");
  } catch (e) {
    console.error("ERROR:", e.message);
  }
}

// ---------------- ROUTE ----------------
app.post('/generate-timetable', (req, res) => {
  res.json({ status: "processing" });
  process(req.body);
});

// ---------------- START ----------------
app.listen(PORT, () => console.log("Running"));
