/**
 * socketService.js — Centralized real-time event emitter
 * Zynqora Edge Autonomous Agent
 */

let _io = null;

/**
 * Initialize with socket.io server instance
 */
function initSocketService(io) {
  _io = io;
}

/**
 * Emit agent status update to all connected clients
 */
function emitStatus(statusData) {
  if (_io) {
    _io.emit('agent:status', statusData);
  }
}

/**
 * Emit a log message to all connected clients
 */
function emitLog(message, level = 'info') {
  if (_io) {
    _io.emit('agent:log', {
      message,
      level,          // 'info' | 'success' | 'warning' | 'error'
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Emit a lead event (new lead found)
 */
function emitLeadFound(lead) {
  if (_io) {
    _io.emit('agent:lead_found', {
      id: lead.id,
      business_name: lead.business_name,
      niche: lead.niche,
      location: lead.location,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Emit an email sent event
 */
function emitEmailSent(lead, emailsSentToday, dailyCap) {
  if (_io) {
    _io.emit('agent:email_sent', {
      business_name: lead.business_name,
      email: lead.email,
      emails_sent_today: emailsSentToday,
      daily_cap: dailyCap,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = { initSocketService, emitStatus, emitLog, emitLeadFound, emitEmailSent };
