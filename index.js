const express = require('express');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// TEMP test route
app.post('/test', (req, res) => {
  console.log('Body:', req.body);
  res.json({ received: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Server running on port', PORT);
});
