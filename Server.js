const admin = require('firebase-admin');
const express = require('express');
const path = require('path');

// 1. DATABASE CONFIGURATION
// Use environment variable for Firebase credentials on Render
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // On Render: Use environment variable
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Local development: Use JSON file
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// 2. MIDDLEWARE
app.use(express.json());
app.use(express.static('public')); // Serves CSS/JS from public folder

// 3. SERVE FRONTEND (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. API: CHECK QUEUE STATUS (For Website)
app.get('/api/status', async (req, res) => {
  try {
    const queueSnapshot = await db.collection('lockQueue')
      .where('status', '==', 'pending')
      .orderBy('timestamp', 'asc')
      .get();
    
    const processingSnapshot = await db.collection('lockQueue')
      .where('status', '==', 'processing')
      .limit(1)
      .get();
    
    const userId = req.query.userId;
    let yourPosition = 0;
    
    queueSnapshot.forEach((doc, index) => {
      if (doc.data().userId === userId) {
        yourPosition = index + 1;
      }
    });
    
    res.json({
      isProcessing: !processingSnapshot.empty,
      queueLength: queueSnapshot.size,
      currentUser: processingSnapshot.empty ? null : processingSnapshot.docs[0].data().userId,
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
  
  try {
    const commandRef = await db.collection('lockQueue').add({
      button,
      userId,
      status: 'pending',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString()
    });
    
    // Listen for the RPi5 to update the status to 'completed'
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Timeout')); }, 60000);
      const unsubscribe = commandRef.onSnapshot(doc => {
        const data = doc.data();
        if (data.status === 'completed') { resolve(data); unsubscribe(); clearTimeout(timeout); }
        else if (data.status === 'failed') { reject(new Error('Failed')); unsubscribe(); clearTimeout(timeout); }
      });
    });

    res.json({ success: true, message: `Lock ${button} opened`, timestamp: result.completedAt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 6. RPi5: GET NEXT COMMAND
app.get('/api/rpi/next-command', async (req, res) => {
  try {
    const snapshot = await db.collection('lockQueue')
      .where('status', '==', 'pending')
      .orderBy('timestamp', 'asc')
      .limit(1)
      .get();
    
    if (snapshot.empty) return res.json({ command: null });
    
    const doc = snapshot.docs[0];
    await doc.ref.update({ status: 'processing', processingAt: new Date().toISOString() });
    
    res.json({ command: { id: doc.id, button: doc.data().button, userId: doc.data().userId } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. RPi5: MARK AS COMPLETE
app.post('/api/rpi/complete', async (req, res) => {
  const { commandId, success, error } = req.body;
  try {
    await db.collection('lockQueue').doc(commandId).update({
      status: success ? 'completed' : 'failed',
      completedAt: new Date().toISOString(),
      error: error || null
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is live on port ${PORT}`);
  console.log('Ready to handle Website and RPi5 communication.');
});