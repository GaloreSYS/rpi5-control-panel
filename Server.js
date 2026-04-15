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

// Track users who have FINISHED their turn — they cannot re-join
const finishedUsers = new Set();

function nextId() { return ++commandIdSeq; }

// ─── Helper: push a command for the RPi ──────────────────────────────────────
function pushCommand(type, extra = {}) {
  pendingCommand = { id: nextId(), type, ...extra, ts: Date.now() };
  console.log(`[CMD] Pushed: ${JSON.stringify(pendingCommand)}`);
}

// ─── Helper: advance to the next queued user ─────────────────────────────────
function advanceQueue() {
  if (queue.length > 0) {
    const next = queue.shift();
    activeUser = next.userId;
    pushCommand('play', { userId: activeUser });
    console.log(`[QUEUE] Advanced to: ${activeUser}, remaining: ${queue.length}`);
  } else {
    activeUser = null;
    pushCommand('idle', {});
    console.log('[QUEUE] Queue empty — going idle');
  }
}

// ─── 1. User scans / joins ───────────────────────────────────────────────────
// POST /api/scan   body: { userId }
app.post('/api/scan', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Finished users cannot rejoin in same session
  if (finishedUsers.has(userId)) {
    return res.status(403).json({ error: 'already_played', message: 'You have already played this session.' });
  }

  // Already active?
  if (activeUser === userId) {
    return res.json({ status: 'your_turn', queuePos: 0 });
  }

  // Already in queue?
  const existingIdx = queue.findIndex(u => u.userId === userId);
  if (existingIdx !== -1) {
    return res.json({ status: 'queued', queuePos: existingIdx + 1 });
  }

  // Add to queue
  queue.push({ userId, scannedAt: Date.now() });
  const pos = queue.length; // 1-based

  if (!activeUser) {
    // Nobody playing — promote immediately
    activeUser = userId;
    queue.pop();  // remove from queue since they're now active
    pushCommand('play', { userId });
    console.log(`[SCAN] ${userId} → active immediately`);
    return res.json({ status: 'your_turn', queuePos: 0 });
  }

  // Someone else is playing
  pushCommand('scan', { userId, queuePos: pos });
  console.log(`[SCAN] ${userId} → queued at position ${pos}`);
  res.json({ status: 'queued', queuePos: pos });
});

// ─── 2. Quiz finished — submit score ──────────────────────────────────────────
// POST /api/score   body: { userId, score }
app.post('/api/score', (req, res) => {
  const { userId, score } = req.body;
  if (!userId || score === undefined)
    return res.status(400).json({ error: 'userId and score required' });

  // Allow score even if activeUser changed (race condition tolerance)
  if (activeUser !== null && activeUser !== userId) {
    console.warn(`[SCORE] Warning: score from ${userId} but activeUser is ${activeUser}`);
    return res.status(409).json({ error: 'not_active_user' });
  }

  const s = Math.max(0, Math.min(6, parseInt(score)));
  pushCommand('score', { userId, score: s });

  // Mark user as finished — they cannot re-queue
  finishedUsers.add(userId);

  console.log(`[SCORE] ${userId} scored ${s}`);
  res.json({ status: 'ok', score: s });
});

// ─── 3. RPi polls for next command ────────────────────────────────────────────
app.get('/api/rpi/next-command', (req, res) => {
  res.json({ command: pendingCommand || null });
});

// ─── 4. RPi confirms command was processed ────────────────────────────────────
// POST /api/rpi/complete   body: { commandId }
app.post('/api/rpi/complete', (req, res) => {
  const { commandId } = req.body;
  if (pendingCommand && pendingCommand.id === commandId) {
    console.log(`[RPi] Completed commandId=${commandId} type=${pendingCommand.type}`);
    pendingCommand = null;
  }
  res.json({ ok: true });
});

// ─── 5. RPi notifies that a turn ended (timeout or locks done) ────────────────
// POST /api/rpi/turn-done   body: { userId }
app.post('/api/rpi/turn-done', (req, res) => {
  const { userId } = req.body;
  console.log(`[RPi] Turn done for: ${userId}, activeUser: ${activeUser}`);

  if (activeUser === userId || activeUser === null) {
    activeUser = null;
    finishedUsers.add(userId);
    advanceQueue();
  }

  res.json({ ok: true, next: activeUser });
});

// ─── 6. Queue status (for polling by web clients) ─────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    activeUser,
    queue: queue.map(u => u.userId),
    queueLength: queue.length
  });
});

// ─── 7. Check if a specific user has finished (for "play again" blocking) ─────
app.get('/api/user-status/:userId', (req, res) => {
  const { userId } = req.params;
  const isActive   = activeUser === userId;
  const inQueue    = queue.findIndex(u => u.userId === userId);
  const finished   = finishedUsers.has(userId);

  res.json({
    userId,
    state: finished ? 'finished'
         : isActive ? 'active'
         : inQueue >= 0 ? 'queued'
         : 'none',
    queuePos: inQueue >= 0 ? inQueue + 1 : null,
    finished
  });
});

// ─── 8. Admin: reset session (clears finished set, queue, active) ─────────────
app.post('/api/admin/reset', (req, res) => {
  queue = [];
  activeUser = null;
  pendingCommand = null;
  finishedUsers.clear();
  pushCommand('idle', {});
  console.log('[ADMIN] Full reset performed');
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Lock server running at http://localhost:${port}`);
});
