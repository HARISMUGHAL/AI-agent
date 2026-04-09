/**
 * server.js — Zynqora Edge Autonomous Agent Server
 * Real-time dashboard via Socket.io
 */

require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Server } = require('socket.io');

const { initDatabase }       = require('./database/db');
const apiRoutes              = require('./routes/api');
const { handleAuthCallback } = require('./services/gmailService');
const { startScheduler }     = require('./services/scheduler');
const { initSocketService }  = require('./services/socketService');
const { initSheetHeaders }   = require('./services/googleSheets');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── Gmail OAuth Callback ─────────────────────────────────────────────────────
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

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Socket.io Connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Dashboard client connected (${socket.id})`);

  // Send current status immediately on connect
  const { getAgentStatus } = require('./services/scheduler');
  socket.emit('agent:status', getAgentStatus());

  socket.on('disconnect', () => {
    console.log(`🔌 Dashboard client disconnected (${socket.id})`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDatabase();

  // Initialize Socket.io service (must be before scheduler starts)
  initSocketService(io);

  // Try to initialize Google Sheets headers (non-blocking)
  initSheetHeaders().catch(e => console.log('ℹ️  Sheets not configured yet:', e.message));

  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ⚡  ZYNQORA EDGE — AUTONOMOUS AI OUTREACH AGENT    ║
║                                                       ║
║   Dashboard:  http://localhost:${PORT}                  ║
║   API:        http://localhost:${PORT}/api               ║
║   Mode:       Fully Autonomous                        ║
║   Hours:      9:00 AM – 6:00 PM                      ║
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
