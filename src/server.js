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

const { initDatabase, isDataCollectionOnly } = require('./database/db');
const apiRoutes = require('./routes/api');
const { handleAuthCallback } = require('./services/gmailService');
const { startScheduler } = require('./services/scheduler');
const { initSocketService } = require('./services/socketService');
const { initSheetHeaders, initDataModeHeaders, logConfigStatus, validateGoogleSheetsConfig } = require('./services/googleSheets');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const dataMode = isDataCollectionOnly();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', data_collection_only: dataMode, timestamp: new Date().toISOString() }));

app.get('/auth/callback', async (req, res) => {
  if (dataMode) {
    return res.redirect('/?mode=data_collection');
  }
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) res.status(200).send('Zynqora Edge is LIVE 🚀');
  });
});

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

async function start() {
  try {
    console.log('🚀 Starting Zynqora Edge...');

    if (dataMode) {
      console.log('📊 MODE: Data Collection Only (no email sending)');
      console.log(`   Target: ${process.env.QUALIFIED_LEAD_TARGET_PER_DAY || 500} qualified leads/day`);
      console.log(`   Countries: ${process.env.TARGET_COUNTRIES || 'United States,United Kingdom'}`);
    } else {
      console.log('📧 MODE: Autonomous Email Outreach');
    }

    await initDatabase().catch(err => console.error('DB init failed:', err.message));

    initSocketService(io);

    const sheetsCfg = logConfigStatus();
    if (dataMode) {
      if (sheetsCfg.status === 'ok') {
        initDataModeHeaders().catch(err => console.log('[Sheets] Init deferred:', err.message));
      } else {
        console.log('[Sheets] Waiting for configuration before collection can start.');
      }
    } else {
      initSheetHeaders().catch(err => console.log('Sheets not configured:', err.message));
    }

    server.listen(PORT, () => {
      const modeLabel = dataMode ? 'Data Collection Only' : 'Fully Autonomous';
      console.log(`
╔═══════════════════════════════════════════════════════╗
║   ⚡ ZYNQORA EDGE — AI AGENT                        ║
║   Dashboard: http://localhost:${PORT}                ║
║   Mode:      ${modeLabel.padEnd(36)}║
╚═══════════════════════════════════════════════════════╝
      `);
      startScheduler();
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

start();
