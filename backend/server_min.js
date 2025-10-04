// server_min.js
import express from 'express';
const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, msg: 'hello from Render minimal' });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('Minimal server is alive');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('MINIMAL listening on :' + PORT);
});
