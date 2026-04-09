require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database/db');
const apiRoutes = require('./routes/api');
const { handleAuthCallback } = require('./services/gmailService');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiRoutes);

// Gmail OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    await handleAuthCallback(code);
    res.redirect('/?gmail=connected');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Initialize DB then start server
async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ⚡  NEXASTRA CLIENT HUNTING AGENT                  ║
║                                                       ║
║   Dashboard:  http://localhost:${PORT}                  ║
║   API:        http://localhost:${PORT}/api               ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);

    startScheduler();
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
