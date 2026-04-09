/**
 * server.js — Zynqora Edge Autonomous Agent Server
 * Render-safe production version
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

// Services
const { initDatabase } = require('./database/db');
const apiRoutes = require('./routes/api');
const { handleAuthCallback } = require('./services/gmailService');
const { startScheduler } = require('./services/scheduler');
const { initSocketService } = require('./services/socketService');
const { initSheetHeaders } = require('./services/googleSheets');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ───────────────────────── Middleware ─────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ───────────────────────── API Routes ─────────────────────────
app.use('/api', apiRoutes);

// ───────────────────────── Gmail OAuth ─────────────────────────
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    await handleAuthCallback(code);
    res.redirect('/?gmail=connected');
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('Authentication failed');
  }
});

// ───────────────────────── Dashboard ─────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ───────────────────────── Fallback ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(
    path.join(__dirname, '..', 'public', 'index.html'),
    (err) => {
      if (err) res.status(200).send('Zynqora Edge is LIVE 🚀');
    }
  );
});

// ───────────────────────── Socket.io ─────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  try {
    const { getAgentStatus } = require('./services/scheduler');
    socket.emit('agent:status', getAgentStatus());
  } catch (e) {
    console.log('Status emit error:', e.message);
  }

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ───────────────────────── STARTUP (IMPORTANT FIX) ─────────────────────────
async function start() {
  try {
    console.log('🚀 Starting Zynqora Edge...');

    // ❗ NON-BLOCKING INIT (CRITICAL FOR RENDER)
    initDatabase().catch(err =>
      console.error('DB init failed:', err.message)
    );

    initSocketService(io);

    initSheetHeaders().catch(err =>
      console.log('Sheets not configured:', err.message)
    );

    // ✅ IMPORTANT: LISTEN FIRST (Render fix)
    server.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ⚡ ZYNQORA EDGE — AUTONOMOUS AI AGENT             ║
║                                                       ║
║   Dashboard: http://localhost:${PORT}                ║
║   API:       /api                                     ║
║   Mode:      Fully Autonomous                        ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
      `);

      // Start background tasks AFTER server is live
      startScheduler();
    });

  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

start();
