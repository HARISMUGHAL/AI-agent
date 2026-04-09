/**
 * app.js — Zynqora Edge Dashboard
 * Real-time updates via Socket.io
 */

// ─── State ────────────────────────────────────────────
let currentPage = 'dashboard';
let allLeads    = [];
let dashboardData = null;
let socket      = null;
let agentState  = {
  status: 'idle',
  emails_sent_today: 0,
  leads_found_today: 0,
  daily_cap: 20,
  daily_target: 100,
  is_business_hours: false
};

// ─── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Check if Gmail was just connected
  const params = new URLSearchParams(window.location.search);
  if (params.get('gmail') === 'connected') {
    showToast('✅ Gmail connected successfully!', 'success');
    window.history.replaceState({}, '', '/');
  }

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.page);
    });
  });

  // Mobile menu toggle
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Close sidebar on page click (mobile)
  document.querySelector('.main-content').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  // Init Socket.io
  initSocket();

  // Load initial data
  loadDashboard();

  // Fallback polling every 10 seconds (if socket disconnects)
  setInterval(() => {
    if (!socket || !socket.connected) {
      pollAgentStatus();
    }
  }, 10000);
});

// ─── Socket.io Real-Time ──────────────────────────────
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    updateSocketStatus(true);
    addActivityLog('🔌 Real-time connection established.', 'success');
  });

  socket.on('disconnect', () => {
    updateSocketStatus(false);
    addActivityLog('⚠️ Real-time connection lost. Using polling fallback.', 'warning');
  });

  // Agent status updates (every 5s from server)
  socket.on('agent:status', (data) => {
    agentState = { ...agentState, ...data };
    updateAgentStatusBar(data);
    updatePipelinePage(data);
    updateAgentSidebarStatus(data);
  });

  // Agent log events
  socket.on('agent:log', (data) => {
    addActivityLog(data.message, data.level);
  });

  // New lead found
  socket.on('agent:lead_found', (data) => {
    agentState.leads_found_today++;
    showToast(`🎯 New lead: ${data.business_name} (${data.niche})`, 'success');
    if (currentPage === 'dashboard') {
      loadDashboard();
    } else if (currentPage === 'leads') {
      loadLeads();
    }
  });

  // Email sent
  socket.on('agent:email_sent', (data) => {
    agentState.emails_sent_today = data.emails_sent_today;
    updateAgentStatusBar(agentState);
    updateDailyProgress(data.emails_sent_today, data.daily_cap);
    showToast(`📤 Email sent to ${data.business_name}`, 'success');
    if (currentPage === 'dashboard') {
      loadDashboard();
    }
  });
}

// ─── Socket Status UI ─────────────────────────────────
function updateSocketStatus(connected) {
  const dot   = document.getElementById('socket-dot');
  const label = document.getElementById('socket-label');
  if (dot)   dot.className   = `status-dot ${connected ? 'online' : 'offline'}`;
  if (label) label.textContent = connected ? 'Live Updates: ON' : 'Live Updates: OFF';
}

// ─── Agent Status Bar (Header) ────────────────────────
function updateAgentStatusBar(data) {
  const sent  = data.emails_sent_today ?? agentState.emails_sent_today;
  const cap   = data.daily_cap        ?? agentState.daily_cap;
  const leads = data.leads_found_today ?? agentState.leads_found_today;
  const st    = (data.status || agentState.status || 'idle').toUpperCase();

  setEl('bar-emails-sent', sent);
  setEl('bar-daily-cap', cap);
  setEl('bar-leads-today', leads);
  setEl('bar-agent-state', st);

  updateDailyProgress(sent, cap);
}

function updateDailyProgress(sent, cap) {
  const pct = cap > 0 ? Math.min(Math.round((sent / cap) * 100), 100) : 0;
  const fill  = document.getElementById('daily-progress-fill');
  const label = document.getElementById('daily-progress-label');
  const pctEl = document.getElementById('daily-progress-pct');

  if (fill)  fill.style.width  = `${pct}%`;
  if (label) label.textContent = `${sent} / ${cap} emails sent today`;
  if (pctEl) pctEl.textContent = `${pct}%`;

  // Update the footnote to show warm-up stage
  const footnote = document.querySelector('.daily-progress-footnote');
  if (footnote) {
    footnote.textContent = cap <= 40 ? 'Warm-up: Day 1–3 (40/day)'
      : cap <= 80 ? 'Warm-up: Day 4–7 (80/day)'
      : `Full Send: Today’s Target ${cap} (range 100–150)`;
  }
}

// ─── Pipeline Page ─────────────────────────────────────
function updatePipelinePage(data) {
  const sent  = data.emails_sent_today ?? 0;
  const leads = data.leads_found_today ?? 0;
  const cap   = data.daily_cap        ?? 20;
  const st    = (data.status || 'idle').toUpperCase();

  setEl('pipe-emails-sent', sent);
  setEl('pipe-leads-today', leads);
  setEl('pipe-daily-cap', cap);
  setEl('pipe-status', st);
}

// ─── Sidebar Agent Status ──────────────────────────────
function updateAgentSidebarStatus(data) {
  const dot    = document.getElementById('agent-status-dot');
  const label  = document.getElementById('agent-status-label');
  const status = data.status || 'idle';

  const stateMap = {
    running:     { cls: 'online',  text: 'Agent Running' },
    idle:        { cls: 'online',  text: 'Agent Online'  },
    sleeping:    { cls: 'offline', text: 'Agent Sleeping' },
    cap_reached: { cls: 'offline', text: 'Cap Reached'   }
  };

  const s = stateMap[status] || stateMap.idle;
  if (dot)   dot.className   = `robot-status-dot ${s.cls === 'online' ? '' : 'offline'}`;
  if (label) label.textContent = s.text;
}

// ─── Activity Log ──────────────────────────────────────
function addActivityLog(message, level = 'info') {
  const levelClass = {
    info:    'log-info',
    success: 'log-success',
    warning: 'log-warning',
    error:   'log-error'
  }[level] || 'log-info';

  const ts = new Date().toLocaleTimeString();
  const entry = `<div class="log-entry ${levelClass}">[${ts}] ${escapeHtml(message)}</div>`;

  // Live activity log on dashboard
  const liveLog = document.getElementById('live-activity-log');
  if (liveLog) {
    liveLog.insertAdjacentHTML('afterbegin', entry);
    // Keep only last 20 entries
    const entries = liveLog.querySelectorAll('.log-entry');
    if (entries.length > 20) entries[entries.length - 1].remove();
  }

  // Pipeline page log
  const pipeLog = document.getElementById('pipeline-log');
  if (pipeLog) {
    pipeLog.insertAdjacentHTML('afterbegin', entry);
    const entries = pipeLog.querySelectorAll('.log-entry');
    if (entries.length > 50) entries[entries.length - 1].remove();
  }
}

// ─── Fallback Polling ──────────────────────────────────
async function pollAgentStatus() {
  try {
    const data = await api('/agent/status');
    if (data) {
      agentState = { ...agentState, ...data };
      updateAgentStatusBar(data);
      updatePipelinePage(data);
    }
  } catch (e) { /* silent */ }
}

// ─── Navigation ───────────────────────────────────────
function navigateTo(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    leads: 'Lead Management',
    niches: 'Niche Analysis',
    pipeline: 'Automation Pipeline',
    settings: 'Settings'
  };
  document.getElementById('page-title').textContent = titles[page] || page;

  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'leads':     loadLeads();     break;
    case 'niches':    loadNiches();    break;
    case 'settings':  loadSettings();  break;
  }
}

// ─── API Helpers ──────────────────────────────────────
async function api(endpoint, options = {}) {
  try {
    const res = await fetch(`/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return await res.json();
  } catch (error) {
    console.error(`API error: ${endpoint}`, error);
    showToast(`Error: ${error.message}`, 'error');
    return null;
  }
}

// ─── Dashboard ────────────────────────────────────────
async function loadDashboard() {
  const data = await api('/dashboard');
  if (!data) return;
  dashboardData = data;

  // Update stats
  animateNumber('stat-total-leads', data.totalLeads);
  animateNumber('stat-contacted',   data.contacted);
  animateNumber('stat-responded',   data.responded);
  animateNumber('stat-avg-score',   data.avgScore);

  // Gmail status
  updateGmailStatus(data.gmailConnected);

  // Update agent status bar from dashboard agent data
  if (data.agentStatus) {
    agentState = { ...agentState, ...data.agentStatus };
    updateAgentStatusBar(data.agentStatus);
    updatePipelinePage(data.agentStatus);
    updateAgentSidebarStatus(data.agentStatus);
  }

  // Status breakdown chart
  renderBarChart('status-chart', data.statusBreakdown.map(s => ({
    label: formatStatus(s.status),
    value: s.count,
    color: getStatusColor(s.status)
  })));

  // Service distribution chart
  renderBarChart('service-chart', data.serviceBreakdown.map(s => ({
    label: s.service_type || 'Unknown',
    value: s.count,
    color: getServiceColor(s.service_type)
  })));

  // Top niches chart
  renderBarChart('niche-chart', data.topNiches.slice(0, 6).map(n => ({
    label: capitalize(n.niche),
    value: n.count,
    color: '#6366f1'
  })));

  // Recent leads table
  renderLeadsTable('recent-leads-table', data.recentLeads.slice(0, 10));

  // Populate niche filter
  const nicheFilter = document.getElementById('lead-filter-niche');
  if (nicheFilter.options.length <= 1 && data.topNiches.length > 0) {
    data.topNiches.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.niche;
      opt.textContent = capitalize(n.niche);
      nicheFilter.appendChild(opt);
    });
  }
}

// ─── Leads ────────────────────────────────────────────
async function loadLeads() {
  const status = document.getElementById('lead-filter-status').value;
  const niche  = document.getElementById('lead-filter-niche').value;

  let endpoint = '/leads';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (niche)  params.set('niche', niche);
  if (params.toString()) endpoint += `?${params}`;

  const leads = await api(endpoint);
  if (!leads) return;
  allLeads = leads;

  renderLeadsTable('leads-table', leads, true);
}

function renderLeadsTable(containerId, leads, showActions = false) {
  const tbody = document.getElementById(containerId);

  if (!leads || leads.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${showActions ? 8 : 6}">
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h3>No leads yet</h3>
          <p>The autonomous agent will discover businesses automatically during business hours</p>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = leads.map(lead => {
    let mode = 'Unknown';
    if (lead.email && lead.phone)  mode = 'Email + WhatsApp';
    else if (!lead.email && lead.phone) mode = 'WhatsApp Only';
    else if (lead.email && !lead.phone) mode = 'Email Only';

    return `
    <tr onclick="showLeadDetail(${lead.id})">
      <td><strong>${escapeHtml(lead.business_name)}</strong></td>
      <td>${capitalize(lead.niche || '-')}</td>
      <td>${escapeHtml(lead.location || '-')}</td>
      ${showActions ? `<td>${lead.website
        ? `<a href="${escapeHtml(lead.website)}" class="website-link" target="_blank" onclick="event.stopPropagation()">${shortenUrl(lead.website)}</a>`
        : '<span class="no-website">No website</span>'}</td>` : ''}
      <td><span class="score-badge ${getScoreClass(lead.score)}">${lead.score || '-'}</span></td>
      <td><span class="badge" style="background:#334155;color:white;font-size:0.75rem">${mode}</span></td>
      <td><span class="badge badge-${lead.status}">${formatStatus(lead.status)}</span></td>
      ${showActions ? `<td onclick="event.stopPropagation()">
        <div style="display:flex;gap:6px">
          ${lead.status === 'scored' || lead.status === 'new' ? `<button class="btn btn-sm btn-secondary" onclick="generateEmail(${lead.id})">✉️ Gen</button>` : ''}
          ${lead.status === 'email_ready' && lead.email ? `<button class="btn btn-sm btn-glow" onclick="sendEmail(${lead.id})">📤 Send</button>` : ''}
          ${lead.status === 'email_ready' && lead.whatsapp_draft && lead.phone ? `<a href="https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(JSON.parse(lead.whatsapp_draft).body)}" target="_blank" class="btn btn-sm btn-secondary" style="background:#10b981">💬 WhatsApp</a>` : ''}
        </div>
      </td>` : ''}
    </tr>
  `;}).join('');
}

// ─── Lead Detail Modal ────────────────────────────────
async function showLeadDetail(id) {
  const data = await api(`/leads/${id}`);
  if (!data) return;

  let emailPreview = '';
  if (data.email_draft) {
    try {
      const draft = JSON.parse(data.email_draft);
      emailPreview = `
        <div class="modal-section">
          <h4>📧 Email Draft</h4>
          <p style="margin-bottom:8px;font-weight:600">Subject: ${escapeHtml(draft.subject)}</p>
          <div class="modal-email-preview">${escapeHtml(draft.body)}</div>
        </div>`;
    } catch (e) {}
  }

  let whatsappPreview = '';
  if (data.whatsapp_draft) {
    try {
      const draft = JSON.parse(data.whatsapp_draft);
      whatsappPreview = `
        <div class="modal-section" style="border-left: 4px solid #10b981;">
          <h4>💬 WhatsApp Draft</h4>
          <div class="modal-email-preview">${escapeHtml(draft.body)}</div>
          ${data.phone ? `<a href="https://wa.me/${data.phone.replace(/\D/g, '')}?text=${encodeURIComponent(draft.body)}" target="_blank" class="btn btn-sm btn-secondary" style="background:#10b981; margin-top:10px;">Send via WhatsApp Web</a>` : '<p style="color:var(--error);font-size:0.8rem;margin-top:5px;">No phone number available.</p>'}
        </div>`;
    } catch (e) {}
  }

  let mode = 'Unknown';
  if (data.email && data.phone)  mode = 'Email + WhatsApp';
  else if (!data.email && data.phone) mode = 'WhatsApp Only';
  else if (data.email && !data.phone) mode = 'Email Only';

  document.getElementById('modal-content').innerHTML = `
    <h3 class="modal-title">${escapeHtml(data.business_name)}</h3>
    <p class="modal-subtitle">${capitalize(data.niche || '')} • ${escapeHtml(data.location || '')} • <strong style="color:var(--text-highlight)">${mode}</strong></p>

    <div class="modal-section">
      <h4>Business Details</h4>
      <div class="modal-detail"><span class="modal-detail-label">Website:</span> ${data.website ? `<a href="${escapeHtml(data.website)}" class="website-link" target="_blank">${data.website}</a>` : '<span class="no-website">None</span>'}</div>
      <div class="modal-detail"><span class="modal-detail-label">Phone:</span> ${escapeHtml(data.phone || 'Not listed')}</div>
      <div class="modal-detail"><span class="modal-detail-label">Email:</span> ${escapeHtml(data.email || 'Not found')}</div>
      <div class="modal-detail"><span class="modal-detail-label">Rating:</span> ${data.rating ? `⭐ ${data.rating}/5 (${data.review_count} reviews)` : 'N/A'}</div>
      <div class="modal-detail"><span class="modal-detail-label">Address:</span> ${escapeHtml(data.address || 'N/A')}</div>
    </div>

    <div class="modal-section">
      <h4>AI Analysis</h4>
      <div class="modal-detail"><span class="modal-detail-label">Score:</span> <span class="score-badge ${getScoreClass(data.score)}">${data.score || 0}</span></div>
      <div class="modal-detail"><span class="modal-detail-label">Service:</span> ${data.service_type ? `<span class="service-tag service-${getServiceClass(data.service_type)}">${data.service_type}</span>` : '-'}</div>
      <div class="modal-detail"><span class="modal-detail-label">Status:</span> <span class="badge badge-${data.status}">${formatStatus(data.status)}</span></div>
      ${data.recommendation ? `<p style="margin-top:10px;color:var(--text-secondary);font-size:0.88rem">💡 ${escapeHtml(data.recommendation)}</p>` : ''}
      ${data.reasoning ? `<p style="margin-top:6px;color:var(--text-muted);font-size:0.82rem">🧠 ${escapeHtml(data.reasoning)}</p>` : ''}
    </div>

    ${emailPreview}
    ${whatsappPreview}

    ${data.outreach && data.outreach.length > 0 ? `
      <div class="modal-section">
        <h4>📤 Outreach History</h4>
        ${data.outreach.map(o => `<div class="modal-detail"><span class="modal-detail-label">${new Date(o.sent_at).toLocaleDateString()}</span> ${o.response_status} (Follow-up #${o.follow_up_number})</div>`).join('')}
      </div>
    ` : ''}

    <div class="modal-actions">
      ${!data.email ? `<input type="text" class="input" id="modal-email-input" placeholder="Add email address" style="flex:1">
        <button class="btn btn-secondary" onclick="updateLeadEmail(${data.id})">Save Email</button>` : ''}
      ${data.score === 0 ? `<button class="btn btn-secondary" onclick="scoreSingleLead(${data.id})">📊 Score</button>` : ''}
      ${data.status === 'scored' || data.status === 'new' ? `<button class="btn btn-secondary" onclick="generateEmail(${data.id})">✉️ Generate Email</button>` : ''}
      ${data.status === 'email_ready' && data.email ? `<button class="btn btn-glow" onclick="sendEmail(${data.id})">📤 Send Email</button>` : ''}
    </div>
  `;

  document.getElementById('lead-modal').classList.add('active');
}

function closeModal() {
  document.getElementById('lead-modal').classList.remove('active');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.getElementById('lead-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('lead-modal')) closeModal();
});

// ─── Niches ───────────────────────────────────────────
async function loadNiches() {
  const niches = await api('/niches');
  if (!niches) return;

  const grid = document.getElementById('niches-grid');

  if (niches.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-state-icon">📂</div>
        <h3>No niche data yet</h3>
        <p>The autonomous agent will discover and analyze niches automatically</p>
      </div>`;
    return;
  }

  const icons = {
    restaurants: '🍽️', salons: '💇', gyms: '💪', 'real estate': '🏠',
    clinics: '🏥', dental: '🦷', law: '⚖️', spas: '🧖',
    pet: '🐾', tutoring: '📚', auto: '🚗', default: '🏢'
  };

  grid.innerHTML = niches.map((niche, i) => {
    const icon = Object.entries(icons).find(([k]) => niche.name.toLowerCase().includes(k));
    return `
      <div class="niche-card" style="animation-delay:${i * 0.05}s">
        <h4>${icon ? icon[1] : icons.default} ${capitalize(niche.name)}</h4>
        <span class="service-tag service-${getServiceClass(niche.best_service)}">${niche.best_service || 'TBD'}</span>
        <div class="niche-card-stats">
          <div class="niche-stat">
            <div class="niche-stat-value">${niche.total_leads}</div>
            <div class="niche-stat-label">Total Leads</div>
          </div>
          <div class="niche-stat">
            <div class="niche-stat-value">${niche.contacted}</div>
            <div class="niche-stat-label">Contacted</div>
          </div>
          <div class="niche-stat">
            <div class="niche-stat-value">${niche.responses}</div>
            <div class="niche-stat-label">Responses</div>
          </div>
          <div class="niche-stat">
            <div class="niche-stat-value">${niche.total_leads > 0 ? Math.round((niche.responses / niche.total_leads) * 100) : 0}%</div>
            <div class="niche-stat-label">Response Rate</div>
          </div>
        </div>
        ${niche.reasoning ? `<div class="niche-reasoning">💡 ${escapeHtml(niche.reasoning)}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Settings ─────────────────────────────────────────
async function loadSettings() {
  const data = await api('/dashboard');
  if (!data) return;

  const keys = data.apiKeysConfigured;
  document.getElementById('settings-status').innerHTML = `
    <div class="setting-row">
      <span class="setting-name">🗺️ Google Maps API</span>
      <span class="setting-status ${keys.googleMaps ? 'configured' : 'missing'}">${keys.googleMaps ? '✅ Configured' : '❌ Not set'}</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">🧠 Gemini AI API</span>
      <span class="setting-status ${keys.gemini ? 'configured' : 'missing'}">${keys.gemini ? '✅ Configured' : '❌ Not set'}</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">📧 Gmail OAuth</span>
      <span class="setting-status ${keys.gmail ? 'configured' : 'missing'}">${keys.gmail ? '✅ Configured' : '❌ Not set'}</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">📤 Gmail Connected</span>
      <span class="setting-status ${data.gmailConnected ? 'configured' : 'missing'}">${data.gmailConnected ? '✅ Connected' : '❌ Not connected'}</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">🤖 Agent Mode</span>
      <span class="setting-status configured">✅ Fully Automatic</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">📊 Daily Target</span>
      <span class="setting-status configured">✅ 100–150 emails/day (randomized)</span>
    </div>
    <div class="setting-row">
      <span class="setting-name">🛡️ Email Strategy</span>
      <span class="setting-status configured">✅ Rate Limited + Warm-Up</span>
    </div>
  `;

  const gmailBtn = document.getElementById('btn-connect-gmail');
  if (data.gmailConnected) {
    gmailBtn.textContent = '🔄 Reconnect Gmail / Sheets';
    gmailBtn.classList.add('btn-secondary');
    gmailBtn.disabled = false;
  } else {
    gmailBtn.textContent = '📧 Connect Gmail / Sheets';
    gmailBtn.classList.remove('btn-secondary');
    gmailBtn.disabled = false;
  }
}

// ─── Actions ──────────────────────────────────────────
async function runPipeline() {
  showToast('🔧 Manual pipeline triggered (debug mode).', 'info');
  await api('/pipeline/run', { method: 'POST' });
  setTimeout(() => loadDashboard(), 3000);
}

async function runFollowUps() {
  showToast('📩 Follow-up pipeline started...', 'info');
  await api('/pipeline/follow-ups', { method: 'POST' });
}

async function discoverLeads() {
  showToast('🔍 Discovering leads...', 'info');
  const result = await api('/leads/discover', { method: 'POST' });
  if (result) {
    showToast(`Found ${result.leadsFound} new leads!`, 'success');
    if (currentPage === 'leads') loadLeads();
    else loadDashboard();
  }
}

async function scoreLeads() {
  showToast('📊 Scoring leads with AI...', 'info');
  const result = await api('/leads/score', { method: 'POST' });
  if (result) {
    showToast(`Scored ${result.leadsScored} leads!`, 'success');
    if (currentPage === 'leads') loadLeads();
  }
}

async function generateEmails() {
  showToast('✉️ Generating email pitches...', 'info');
  const result = await api('/leads/generate-emails', { method: 'POST' });
  if (result) {
    showToast(`Generated ${result.emailsGenerated} emails!`, 'success');
    if (currentPage === 'leads') loadLeads();
  }
}

async function generateEmail(id) {
  showToast('✉️ Generating email...', 'info');
  const result = await api(`/leads/${id}/generate-email`, { method: 'POST' });
  if (result && result.success) {
    showToast('Email draft generated!', 'success');
    closeModal();
    if (currentPage === 'leads') loadLeads();
  }
}

async function sendEmail(id) {
  showToast('📤 Sending email...', 'info');
  const result = await api(`/leads/${id}/send-email`, { method: 'POST' });
  if (result && result.success) {
    showToast('Email sent successfully!', 'success');
    closeModal();
    if (currentPage === 'leads') loadLeads();
  } else {
    showToast('Failed to send email. Check Gmail connection.', 'error');
  }
}

async function scoreSingleLead(id) {
  showToast('📊 Scoring lead...', 'info');
  const result = await api(`/leads/${id}/score`, { method: 'POST' });
  if (result && result.success) {
    showToast('Lead scored!', 'success');
    showLeadDetail(id);
  }
}

async function updateLeadEmail(id) {
  const emailInput = document.getElementById('modal-email-input');
  const email = emailInput.value.trim();
  if (!email) return showToast('Enter an email address', 'error');

  await api(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ email }) });
  showToast('Email updated!', 'success');
  showLeadDetail(id);
}

async function analyzeNiches() {
  showToast('🧠 Analyzing niches...', 'info');
  await api('/niches/analyze', { method: 'POST' });
  showToast('Niche analysis complete!', 'success');
  if (currentPage === 'niches') loadNiches();
}

async function connectGmail() {
  const result = await api('/gmail/auth-url');
  if (result && result.url) {
    window.open(result.url, '_blank');
    showToast('Complete sign-in in the new tab', 'info');
  } else {
    showToast('Gmail OAuth not configured. Add credentials to .env', 'error');
  }
}

async function manualDiscover() {
  const niche    = document.getElementById('discover-niche').value.trim();
  const location = document.getElementById('discover-location').value.trim();
  if (!niche || !location) return showToast('Enter both niche and location', 'error');

  showToast(`🔍 Searching for ${niche} in ${location}...`, 'info');
  const result = await api('/leads/discover', {
    method: 'POST',
    body: JSON.stringify({ niche, location })
  });
  if (result) {
    showToast(`Found ${result.leadsFound} new leads!`, 'success');
  }
}

// ─── Charts ───────────────────────────────────────────
function renderBarChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:20px"><p>No data</p></div>';
    return;
  }

  const max = Math.max(...data.map(d => d.value), 1);

  container.innerHTML = data.map(d => `
    <div class="chart-bar">
      <span class="chart-bar-label">${escapeHtml(d.label)}</span>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width:${(d.value / max) * 100}%;background:${d.color}">${d.value}</div>
      </div>
    </div>
  `).join('');
}

// ─── Gmail Status ─────────────────────────────────────
function updateGmailStatus(connected) {
  const el = document.getElementById('gmail-status');
  el.innerHTML = `
    <span class="status-dot ${connected ? 'online' : 'offline'}"></span>
    <span>Gmail: ${connected ? 'Connected' : 'Disconnected'}</span>
  `;
}

// ─── Toast Notifications ──────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Utilities ────────────────────────────────────────
function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function animateNumber(elementId, target) {
  const el = document.getElementById(elementId);
  const start = parseInt(el.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed  = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function capitalize(str) {
  if (!str) return '';
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatStatus(status) {
  const map = {
    new: 'New', scored: 'Scored', email_ready: 'Email Ready',
    contacted: 'Contacted', followed_up: 'Followed Up', responded: 'Responded'
  };
  return map[status] || capitalize(status || 'unknown');
}

function getScoreClass(score) {
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-med';
  return 'score-low';
}

function getServiceClass(type) {
  if (!type) return 'both';
  if (type.toLowerCase().includes('whatsapp')) return 'whatsapp';
  if (type.toLowerCase().includes('ai')) return 'ai';
  return 'both';
}

function getStatusColor(status) {
  const colors = {
    new: '#3b82f6', scored: '#f59e0b', email_ready: '#a78bfa',
    contacted: '#10b981', followed_up: '#22d3ee', responded: '#34d399'
  };
  return colors[status] || '#64748b';
}

function getServiceColor(type) {
  if (!type) return '#f59e0b';
  if (type.toLowerCase().includes('whatsapp')) return '#10b981';
  if (type.toLowerCase().includes('ai')) return '#6366f1';
  return '#f59e0b';
}

function shortenUrl(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch { return url; }
}
