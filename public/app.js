'use strict';

const el = id => document.getElementById(id);
const activity = [];

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const box = el('toast'); box.textContent = message; box.className = error ? 'show error' : 'show';
  setTimeout(() => { box.className = ''; }, 4000);
}

function addActivity(message, level = 'info') {
  if (!message) return;
  activity.unshift({ message, level, time: new Date().toLocaleTimeString() });
  activity.splice(50);
  const escape = value => String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  el('activity-log').innerHTML = activity.map(item => `<li class="${item.level}"><time>${item.time}</time><span>${escape(item.message)}</span></li>`).join('');
}

function setButtonState(state = {}) {
  const active = ['running', 'pausing'].includes(state.status);
  for (const id of ['start-run', 'start-us', 'start-uk']) el(id).disabled = active;
  el('pause-run').disabled = !active;
  el('resume-run').disabled = state.status !== 'paused';
}

function render(state = {}) {
  el('today').textContent = state.today || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
  el('us-target').textContent = state.us_target ?? 500;
  el('uk-target').textContent = state.uk_target ?? 500;
  el('us-found').textContent = state.us_leads_found ?? 0;
  el('us-remaining').textContent = Math.max(0, (state.us_target ?? 500) - (state.us_leads_found ?? 0));
  el('uk-found').textContent = state.uk_leads_found ?? 0;
  el('uk-remaining').textContent = Math.max(0, (state.uk_target ?? 500) - (state.uk_leads_found ?? 0));
  el('candidates').textContent = state.candidates_found ?? 0;
  el('collected').textContent = state.total_collected ?? 0;
  el('qualified').textContent = state.total_qualified ?? 0;
  el('duplicates').textContent = state.duplicates_removed ?? 0;
  el('manual').textContent = state.needs_manual_verification ?? 0;
  el('rejected').textContent = state.rejected ?? 0;
  el('sheets-synced').textContent = state.sheets_rows_synced ?? 0;
  el('sqlite-saved').textContent = state.rows_saved_sqlite ?? 0;
  el('master-synced').textContent = state.master_rows_synced ?? 0;
  el('daily-synced').textContent = state.daily_rows_synced ?? 0;
  el('sheet-pending').textContent = state.pending_sheet_rows ?? 0;
  el('processed').textContent = state.candidates_processed ?? 0;
  el('error-count').textContent = state.error_count ?? 0;
  el('source-queries').textContent = state.source_queries ?? 0;
  el('last-query-count').textContent = state.source_candidates_last_query ?? 0;
  el('http-status').textContent = state.last_http_status || '—';
  el('speed').textContent = state.processing_speed_per_min ?? 0;
  el('run-status').textContent = state.status || 'idle';
  el('export-status').textContent = state.excel_export_status || 'not_started';
  el('current-source').textContent = state.current_source || '—';
  el('current-country').textContent = state.current_country || '—';
  el('current-city').textContent = state.current_city || '—';
  el('current-category').textContent = state.current_category || '—';
  el('current-website').textContent = state.current_website || '—';
  el('current-business').textContent = state.current_business || '—';
  el('last-checkpoint').textContent = state.last_successful_checkpoint || '—';
  el('last-fetch').textContent = state.last_successful_fetch || '—';
  el('last-error-code').textContent = state.last_error_code || 'None';
  el('estimated-finish').textContent = state.estimated_finish_time || '—';
  el('shortfall').textContent = state.shortfall_reason || 'None';
  el('last-error').textContent = state.last_error || 'None';
  const mapsState = state.google_maps_status || (state.google_maps_configured ? 'untested' : 'not_configured');
  const mapsBlocked = ['blocked', 'error'].includes(mapsState);
  el('maps-status').textContent = mapsState === 'connected' ? 'Connected' : mapsBlocked ? 'Blocked' : state.google_maps_configured ? 'Configured · test required' : 'Missing key';
  el('maps-status').className = mapsState === 'connected' ? 'ok-text' : mapsBlocked ? 'bad-text' : 'warn-text';
  el('maps-detail').textContent = mapsBlocked ? (state.google_maps_error || 'Google Maps request failed') : (state.google_maps_configured ? 'Click Test Google Maps API' : 'Add GOOGLE_MAPS_API_KEY');
  el('source-mode').textContent = state.source_mode || 'Unknown';
  el('source-event').textContent = state.source_event || 'idle';
  const target = Number(state.run_target || (Number(state.us_target || 0) + Number(state.uk_target || 0)));
  const collected = Number(state.total_collected || 0);
  const pct = target > 0 ? Math.min(100, Math.round((collected / target) * 100)) : 0;
  el('progress-fill').style.width = `${pct}%`;
  el('progress-label').textContent = `${collected} / ${target} source-backed leads (${pct}%)`;
  const healthy = !state.last_error && Number(state.error_count || 0) === 0;
  el('agent-health').textContent = state.status === 'running' ? (healthy ? 'Running' : 'Running with errors') : (state.status || 'idle');
  el('agent-health').className = healthy ? 'ok-text' : state.status === 'failed' ? 'bad-text' : 'warn-text';
  el('health-detail').textContent = state.last_error || 'No active errors';
  setButtonState(state);
}

async function load() {
  try {
    const [state, sheets] = await Promise.all([api('/collection/local-status'), api('/sheets/status')]);
    render(state);
    el('sheets-status').textContent = sheets.connected && sheets.write_access ? 'Connected' : sheets.configured ? 'Not connected' : 'Not configured';
    el('sheets-status').className = sheets.connected && sheets.write_access ? 'ok-text' : 'warn-text';
    el('sheet-detail').textContent = sheets.connected
      ? `${sheets.spreadsheet_title || 'Spreadsheet'} · ${sheets.write_access ? 'write access verified' : (sheets.error || 'read access only')}`
      : (sheets.error || 'Configuration required');
  } catch (error) { toast(error.message, true); }
}

el('test-sheets').onclick = async () => {
  try { const result = await api('/sheets/test', { method: 'POST' }); el('sheets-status').textContent = result.connected ? 'Connected' : 'Not connected'; el('sheet-detail').textContent = result.connected ? 'Write access verified' : 'Connection failed'; addActivity('Google Sheets write access verified.', 'success'); toast('Google Sheets connection verified.'); }
  catch (error) { el('sheets-status').textContent = 'Not connected'; toast(error.message, true); }
};
el('test-maps').onclick = async () => {
  try {
    el('maps-status').textContent = 'Testing…';
    const result = await api('/maps/test', { method: 'POST', body: '{}' });
    el('maps-status').textContent = 'Connected'; el('maps-status').className = 'ok-text';
    el('maps-detail').textContent = `HTTP ${result.http_status} · ${result.places_returned} place returned`;
    addActivity('Google Maps Places API verified.', 'success'); toast('Google Maps API verified.');
  } catch (error) {
    el('maps-status').textContent = 'Connection failed'; el('maps-status').className = 'bad-text';
    el('maps-detail').textContent = error.message; addActivity(`Google Maps test failed: ${error.message}`, 'error'); toast(error.message, true);
  }
};
async function startDiscovery(dataset = '') {
  try {
    const suffix = dataset ? `/${dataset}` : '';
    const result = await api(`/collection/start${suffix}`, { method: 'POST', body: '{}' });
    render(result.state || {}); addActivity(dataset ? `${dataset} discovery started.` : 'Full discovery started.', 'success'); toast(dataset ? `${dataset} discovery started.` : 'Full automatic discovery started.');
  } catch (error) { toast(error.message, true); }
}
el('start-run').onclick = () => startDiscovery();
el('start-us').onclick = () => startDiscovery('US');
el('start-uk').onclick = () => startDiscovery('UK');
el('pause-run').onclick = async () => { try { const result = await api('/collection/pause', { method: 'POST' }); render(result.state); toast('Pause requested.'); } catch (error) { toast(error.message, true); } };
el('resume-run').onclick = async () => { try { const result = await api('/collection/resume', { method: 'POST', body: '{}' }); render(result.state || {}); toast('Collection resumed from its saved checkpoint.'); } catch (error) { toast(error.message, true); } };
for (const dataset of ['us','uk']) el(`export-${dataset}`).onclick = async () => { try { const result = await api(`/collection/export/${dataset}`, { method: 'POST' }); toast(`Excel created: ${result.path}`); await load(); } catch (error) { toast(error.message, true); } };
el('clear-log').onclick = () => { activity.length = 0; el('activity-log').innerHTML = '<li class="muted">Activity cleared.</li>'; };

if (typeof io === 'function') {
  const socket = io();
  socket.on('connect', () => addActivity('Live dashboard connected.', 'success'));
  socket.on('disconnect', () => addActivity('Live dashboard disconnected.', 'error'));
  socket.on('collection:progress', state => {
    render(state);
    const details = [state.source_event, state.current_source, state.current_city, state.current_category].filter(Boolean).join(' · ');
    if (details) addActivity(details, state.last_error ? 'error' : 'info');
  });
}
load();
