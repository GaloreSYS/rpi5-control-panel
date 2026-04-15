const express = require('express');
const app  = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

// ─── In-memory state ────────────────────────────────────────────────────────
let queue          = [];   // [{ userId, scannedAt }]
let activeUser     = null; // userId currently playing
let pendingCommand = null; // next command waiting for RPi to pick up
let commandIdSeq   = 0;

function nextId() { return ++commandIdSeq; }

// ─── Helper: push a command for the RPi ──────────────────────────────────────
function pushCommand(type, extra = {}) {
  pendingCommand = { id: nextId(), type, ...extra };
}

// ─── 1. User scans QR code ────────────────────────────────────────────────
// Called by the quiz web-app when a user scans in
// POST /api/scan   body: { userId }
app.post('/api/scan', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Already in queue or playing?
  if (activeUser === userId || queue.find(u => u.userId === userId)) {
    const pos = activeUser === userId ? 0 :
                queue.findIndex(u => u.userId === userId) + 1;
    return res.json({ status: 'already_queued', queuePos: pos });
  }

  queue.push({ userId, scannedAt: Date.now() });
  const pos = queue.length; // 1-based position

  if (!activeUser) {
    // Nobody playing — go straight to active
    activeUser = userId;
    queue.shift();
    pushCommand('play', { userId });
    return res.json({ status: 'your_turn', queuePos: 1 });
  }

  // Someone else is playing — show queue position
  pushCommand('scan', { userId, queuePos: pos });
  res.json({ status: 'queued', queuePos: pos });
});

// ─── 2. Quiz finished — submit score ──────────────────────────────────────
// POST /api/score   body: { userId, score }
app.post('/api/score', (req, res) => {
  const { userId, score } = req.body;
  if (!userId || score === undefined)
    return res.status(400).json({ error: 'userId and score required' });

  if (activeUser !== userId)
    return res.status(409).json({ error: 'Not the active user' });

  const s = Math.max(0, Math.min(6, parseInt(score)));
  pushCommand('score', { userId, score: s });
  res.json({ status: 'ok', score: s });
});

// ─── 3. RPi polls for next command ────────────────────────────────────────
app.get('/api/rpi/next-command', (req, res) => {
  if (pendingCommand) {
    res.json({ command: pendingCommand });
  } else {
    res.json({ command: null });
  }
});

// ─── 4. RPi confirms command was processed ────────────────────────────────
// POST /api/rpi/complete   body: { commandId }
app.post('/api/rpi/complete', (req, res) => {
  const { commandId } = req.body;
  if (pendingCommand && pendingCommand.id === commandId) {
    pendingCommand = null;
  }
  res.json({ ok: true });
});

// ─── 5. RPi notifies that a turn ended (timeout or locks done) ────────────
// POST /api/rpi/turn-done   body: { userId }
app.post('/api/rpi/turn-done', (req, res) => {
  const { userId } = req.body;
  if (activeUser === userId) activeUser = null;

  if (queue.length > 0) {
    const next = queue.shift();
    activeUser = next.userId;
    pushCommand('play', { userId: next.userId });
  }
  res.json({ ok: true, next: activeUser });
});

// ─── 6. Queue status (for debugging / web display) ───────────────────────
app.get('/api/status', (req, res) => {
  res.json({ activeUser, queue: queue.map(u => u.userId) });
});

// ─── Start ───────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Lock server running at http://localhost:${port}`);
});
