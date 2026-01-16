const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Optional: npm install uuid

const app = express();

// --- IN-MEMORY DATABASE REPLACEMENT ---
// This replaces the Firestore 'lockQueue' collection
let lockQueue = []; 

// 2. MIDDLEWARE
app.use(express.json());
app.use(express.static('public')); 

// 3. SERVE FRONTEND
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. API: CHECK QUEUE STATUS (For Website)
app.get('/api/status', (req, res) => {
  try {
    const userId = req.query.userId;
    
    const pendingCommands = lockQueue.filter(cmd => cmd.status === 'pending');
    const processingCommand = lockQueue.find(cmd => cmd.status === 'processing');
    
    // Find user's position in the pending queue
    const userIndex = pendingCommands.findIndex(cmd => cmd.userId === userId);
    const yourPosition = userIndex !== -1 ? userIndex + 1 : 0;
    
    res.json({
      isProcessing: !!processingCommand,
      queueLength: pendingCommands.length,
      currentUser: processingCommand ? processingCommand.userId : null,
      yourPosition
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. API: ADD TO QUEUE (For Website)
app.post('/api/action', async (req, res) => {
  const { button, userId } = req.body;
  if (!userId || button < 1 || button > 8) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }
  
  const commandId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
  
  const newCommand = {
    id: commandId,
    button,
    userId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  lockQueue.push(newCommand);
  
  try {
    // Polling simulation for the 'completed' status (Replaces Firestore onSnapshot)
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('Timeout: RPi5 did not respond'));
      }, 60000);

      const poll = setInterval(() => {
        const cmd = lockQueue.find(c => c.id === commandId);
        if (cmd && cmd.status === 'completed') {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(cmd);
        } else if (cmd && cmd.status === 'failed') {
          clearInterval(poll);
          clearTimeout(timeout);
          reject(new Error('Action failed on RPi5'));
        }
      }, 500);
    });

    res.json({ success: true, message: `Lock ${button} opened`, timestamp: result.completedAt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 6. RPi5: GET NEXT COMMAND
app.get('/api/rpi/next-command', (req, res) => {
  const nextIndex = lockQueue.findIndex(cmd => cmd.status === 'pending');
  
  if (nextIndex === -1) return res.json({ command: null });
  
  // Update status to processing
  lockQueue[nextIndex].status = 'processing';
  lockQueue[nextIndex].processingAt = new Date().toISOString();
  
  const cmd = lockQueue[nextIndex];
  res.json({ command: { id: cmd.id, button: cmd.button, userId: cmd.userId } });
});

// 7. RPi5: MARK AS COMPLETE
app.post('/api/rpi/complete', (req, res) => {
  const { commandId, success, error } = req.body;
  const cmdIndex = lockQueue.findIndex(cmd => cmd.id === commandId);
  
  if (cmdIndex !== -1) {
    lockQueue[cmdIndex].status = success ? 'completed' : 'failed';
    lockQueue[cmdIndex].completedAt = new Date().toISOString();
    lockQueue[cmdIndex].error = error || null;

    // Optional: Clean up memory by removing very old completed items after a delay
    setTimeout(() => {
        lockQueue = lockQueue.filter(cmd => cmd.id !== commandId);
    }, 10000);

    return res.json({ success: true });
  }
  
  res.status(404).json({ error: "Command not found" });
});

// 8. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server live on port ${PORT} (Direct Mode - No Firebase)`);
});
