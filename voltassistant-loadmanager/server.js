/**
 * VoltAssistant - Home Assistant Addon
 * Battery optimization + load management for Deye inverters
 */

const http = require('http');
const fs = require('fs');
const axios = require('axios');
const { getSolarForecast, getPVPCPrices, generateChargingPlan, calculateMonthlySavings } = require('./forecast');

// HA Supervisor API
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_URL = SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : 'http://192.168.31.54:8123/api';

// Config files
const HA_OPTIONS = '/data/options.json';
const USER_CONFIG = '/data/user-config.json';
const STATE_FILE = '/data/state.json';
const HISTORY_FILE = '/data/history.json';

// Debug logs - keep last 200 entries
let debugLogs = [];
const MAX_LOGS = 200;

function log(level, msg, data = null) {
  const entry = { ts: new Date().toISOString(), level, msg, data };
  debugLogs.push(entry);
  if (debugLogs.length > MAX_LOGS) debugLogs.shift();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  console.log(`${prefix} ${msg}`, data ? JSON.stringify(data) : '');
}

// History for charts - keep 24h of data (every 5 min = 288 points)
let history = { soc: [], price: [], pv: [], load: [], grid: [] };
const MAX_HISTORY = 288;

function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    history = saved;
    log('info', 'History loaded', { points: history.soc?.length || 0 });
  } catch (e) {
    log('info', 'No history file, starting fresh');
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    log('error', 'Failed to save history', { error: e.message });
  }
}

function addHistoryPoint() {
  const ts = Date.now();
  history.soc.push({ ts, v: state.battery.soc });
  history.price.push({ ts, v: state.currentPrice });
  history.pv.push({ ts, v: state.pv.power });
  history.load.push({ ts, v: state.load.power });
  history.grid.push({ ts, v: state.grid.power });
  
  // Trim old data
  for (const key of Object.keys(history)) {
    if (history[key].length > MAX_HISTORY) {
      history[key] = history[key].slice(-MAX_HISTORY);
    }
  }
  saveHistory();
}

loadHistory();

// Load HA addon options as defaults
let haOptions = {};
try {
  haOptions = JSON.parse(fs.readFileSync(HA_OPTIONS, 'utf8'));
  log('success', 'HA options loaded');
} catch (e) {
  log('warn', 'No HA options, using defaults');
}

// Load user config (overrides HA options)
let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  log('success', 'User config loaded');
} catch (e) {}

// Scheduled actions tracking
const scheduledActions = [];

// Do Not Disturb mode
let dndUntil = null;

// Battery optimization presets
const PRESETS = {
  'eco': { name: 'Eco Mode', target: 50, description: 'Minimal charging, maximize self-consumption' },
  'balanced': { name: 'Balanced', target: 80, description: 'Default balance of grid/solar' },
  'full': { name: 'Full Charge', target: 100, description: 'Always keep battery full' },
  'export': { name: 'Export Priority', target: 30, description: 'Maximize grid export, low battery' }
};

// Merge configs: user config overrides HA options
function getConfig() {
  return {
    inverter: { ...haOptions.inverter, ...userConfig.inverter },
    sensors: { ...haOptions.sensors, ...userConfig.sensors },
    controls: { ...haOptions.controls, ...userConfig.controls },
    tariff_periods: { ...haOptions.tariff_periods, ...userConfig.tariff_periods },
    loads: userConfig.loads || haOptions.loads || [],
    ev_charging: { ...haOptions.ev_charging, ...userConfig.ev_charging },
    load_manager: { ...haOptions.load_manager, ...userConfig.load_manager },
    battery_optimization: { ...haOptions.battery_optimization, ...userConfig.battery_optimization }
  };
}

function saveUserConfig(config) {
  userConfig = config;
  try {
    fs.writeFileSync(USER_CONFIG, JSON.stringify(config, null, 2));
    log('success', 'User config saved');
  } catch (e) {
    log('error', 'Error saving config', { error: e.message });
  }
}

// Get current merged config
let config = getConfig();
const inv = () => config.inverter || {};
const sens = () => config.sensors || {};
const ctrl = () => config.controls || {};
const tariff = () => config.tariff_periods || {};
const lm = () => config.load_manager || {};
const batOpt = () => config.battery_optimization || {};

// State
let state = {
  battery: { soc: 0, power: 0, kwh: 0, capacity: 32.6 },
  grid: { power: 0 },
  load: { power: 0 },
  pv: { power: 0 },
  currentPrice: null,
  currentPeriod: 'unknown',
  contractedPower: 6900,
  manualTargetSoc: null,
  manualTargetExpiry: null,
  effectiveTargetSoc: 80,
  chargingDecision: 'idle',
  chargingReason: '',
  carSoc: null,
  carChargingSlot: false,
  totalManagedPower: 0,
  maxAvailable: 6000,
  usagePercent: 0,
  isOverloaded: false,
  shedLoads: [],
  loads: [],
  lastAction: null,
  lastCheck: null,
  haConnection: { status: 'unknown', lastSuccess: null, lastError: null },
  alerts: { active: [], history: [] }
};

// Load persistent state
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved.manualTargetSoc !== undefined) state.manualTargetSoc = saved.manualTargetSoc;
  if (saved.manualTargetExpiry) state.manualTargetExpiry = saved.manualTargetExpiry;
  if (saved.shedLoads) state.shedLoads = saved.shedLoads;
} catch (e) {}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      manualTargetSoc: state.manualTargetSoc,
      manualTargetExpiry: state.manualTargetExpiry,
      shedLoads: state.shedLoads
    }));
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// HA API
// ─────────────────────────────────────────────────────────────────────────────

async function haGet(entityId) {
  if (!entityId) return null;
  try {
    const headers = SUPERVISOR_TOKEN 
      ? { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
      : { Authorization: `Bearer ${process.env.HA_TOKEN}` };
    const res = await axios.get(`${HA_URL}/states/${entityId}`, { headers, timeout: 5000 });
    state.haConnection = { status: 'connected', lastSuccess: new Date().toISOString(), lastError: null };
    return res.data;
  } catch (e) {
    state.haConnection = { status: 'error', lastSuccess: state.haConnection.lastSuccess, lastError: e.message };
    log('error', `HA GET failed: ${entityId}`, { error: e.message });
    return null;
  }
}

async function haNum(entityId) {
  const entity = await haGet(entityId);
  return parseFloat(entity?.state) || 0;
}

async function haCall(domain, service, data) {
  try {
    const headers = SUPERVISOR_TOKEN 
      ? { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
      : { Authorization: `Bearer ${process.env.HA_TOKEN}` };
    await axios.post(`${HA_URL}/services/${domain}/${service}`, data, { headers, timeout: 5000 });
    log('success', `HA service called: ${domain}.${service}`, data);
    return true;
  } catch (e) {
    log('error', `HA service failed: ${domain}.${service}`, { error: e.message });
    return false;
  }
}

const turnOff = (id) => haCall(id.split('.')[0], 'turn_off', { entity_id: id });
const turnOn = (id) => haCall(id.split('.')[0], 'turn_on', { entity_id: id });
const setNumber = (id, val) => haCall('number', 'set_value', { entity_id: id, value: val });

// Test an entity - returns detailed info
async function testEntity(entityId) {
  if (!entityId) return { ok: false, error: 'No entity ID' };
  try {
    const headers = SUPERVISOR_TOKEN 
      ? { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
      : { Authorization: `Bearer ${process.env.HA_TOKEN}` };
    const start = Date.now();
    const res = await axios.get(`${HA_URL}/states/${entityId}`, { headers, timeout: 5000 });
    const latency = Date.now() - start;
    return { 
      ok: true, 
      entity_id: res.data.entity_id,
      state: res.data.state, 
      unit: res.data.attributes?.unit_of_measurement,
      friendly_name: res.data.attributes?.friendly_name,
      latency 
    };
  } catch (e) {
    return { ok: false, error: e.response?.status === 404 ? 'Entity not found' : e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logic
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentPeriod() {
  const now = new Date();
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  if (isWeekend) return 'valle';
  if (hour >= 0 && hour < 8) return 'valle';
  if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'punta';
  return 'llano';
}

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

function decideCharging() {
  const opt = batOpt();
  if (!opt.enabled) return { decision: 'idle', reason: 'Optimization disabled', targetSoc: state.battery.soc };
  
  if (state.manualTargetExpiry && new Date(state.manualTargetExpiry) < new Date()) {
    state.manualTargetSoc = null;
    state.manualTargetExpiry = null;
    saveState();
  }
  
  let targetSoc = opt.default_target_soc || 80;
  let reason = '';
  
  if (state.manualTargetSoc !== null) {
    targetSoc = state.manualTargetSoc;
    reason = `Manual target: ${targetSoc}%`;
  } else if (isWeekend() && opt.keep_full_weekends) {
    targetSoc = 100;
    reason = 'Weekend → 100%';
  } else if (state.currentPrice !== null) {
    if (state.currentPrice <= (opt.always_charge_below_price || 0.05)) {
      targetSoc = 100;
      reason = `Low price (${state.currentPrice.toFixed(3)}€) → 100%`;
    } else if (state.currentPrice >= (opt.never_charge_above_price || 0.15)) {
      targetSoc = opt.min_soc || 10;
      reason = `High price (${state.currentPrice.toFixed(3)}€) → minimum`;
    } else {
      const minP = opt.always_charge_below_price || 0.05;
      const maxP = opt.never_charge_above_price || 0.15;
      const ratio = (state.currentPrice - minP) / (maxP - minP);
      targetSoc = Math.round(100 - (ratio * (100 - (opt.min_soc || 10))));
      reason = `Price ${state.currentPrice.toFixed(3)}€ → ${targetSoc}%`;
    }
  }
  
  state.effectiveTargetSoc = targetSoc;
  
  if (state.battery.soc < targetSoc - 2) {
    return { decision: 'charge', reason, targetSoc };
  }
  return { decision: 'hold', reason: `SOC ${state.battery.soc}% ≥ target ${targetSoc}%`, targetSoc };
}

async function applyCharging() {
  const { decision, reason, targetSoc } = decideCharging();
  state.chargingDecision = decision;
  state.chargingReason = reason;
  
  log('info', `Charging decision: ${decision}`, { reason, targetSoc, soc: state.battery.soc });
  
  if (decision === 'charge') {
    const c = ctrl();
    if (c.program_1_soc) await setNumber(c.program_1_soc, targetSoc);
    if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, targetSoc);
  } else {
    const c = ctrl();
    if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
  }
  return { decision, reason, targetSoc };
}

async function updateState() {
  config = getConfig();
  const s = sens();
  const i = inv();
  
  log('info', 'Updating state...');
  
  const [soc, batPower, gridPower, loadPower, pvPower] = await Promise.all([
    haNum(s.battery_soc), haNum(s.battery_power), haNum(s.grid_power), haNum(s.load_power), haNum(s.pv_power)
  ]);
  
  state.battery.soc = soc;
  state.battery.power = batPower;
  state.battery.capacity = i.battery_capacity_kwh || 32.6;
  state.battery.kwh = (soc / 100) * state.battery.capacity;
  state.grid.power = gridPower;
  state.load.power = loadPower;
  state.pv.power = pvPower;
  
  if (s.pvpc_price) state.currentPrice = await haNum(s.pvpc_price);
  
  if (s.tariff_period) {
    const p = await haGet(s.tariff_period);
    state.currentPeriod = p?.state?.toLowerCase() || getCurrentPeriod();
  } else {
    state.currentPeriod = getCurrentPeriod();
  }
  
  const periodConfig = tariff()[state.currentPeriod] || {};
  state.contractedPower = (periodConfig.contracted_power_kw || 6.9) * 1000;
  
  state.loads = (config.loads || []).map(l => ({ ...l, current_power: 0, is_on: true }));
  for (const load of state.loads) {
    if (load.power_sensor) load.current_power = await haNum(load.power_sensor);
    if (load.switch_entity) {
      const sw = await haGet(load.switch_entity);
      load.is_on = sw?.state === 'on';
    }
  }
  
  const margin = (lm().safety_margin_percent || 10) / 100;
  state.maxAvailable = state.contractedPower * (1 - margin);
  state.usagePercent = (state.load.power / state.contractedPower) * 100;
  state.isOverloaded = state.load.power > state.maxAvailable;
  
  // EV Charging state
  const ev = config.ev_charging || {};
  if (ev.enabled && ev.car_soc_sensor) {
    state.carSoc = await haNum(ev.car_soc_sensor);
  }
  if (ev.car_charging_slot) {
    const slot = await haGet(ev.car_charging_slot);
    state.carChargingSlot = slot?.state === 'on';
  }
  
  decideCharging();
  checkAlerts();
  state.lastCheck = new Date().toISOString();
  
  log('success', 'State updated', { soc, price: state.currentPrice, period: state.currentPeriod });
}

// Check and generate alerts
function checkAlerts() {
  const alerts = config.alerts || {};
  const newAlerts = [];
  const now = new Date().toISOString();
  
  // Low battery alert
  if (alerts.low_soc && state.battery.soc < alerts.low_soc) {
    const existing = state.alerts.active.find(a => a.type === 'low_soc');
    if (!existing) {
      newAlerts.push({
        id: 'low_soc_' + Date.now(),
        type: 'low_soc',
        severity: 'warning',
        message: `Battery low: ${state.battery.soc}% (threshold: ${alerts.low_soc}%)`,
        value: state.battery.soc,
        threshold: alerts.low_soc,
        timestamp: now
      });
    }
  } else {
    state.alerts.active = state.alerts.active.filter(a => a.type !== 'low_soc');
  }
  
  // High price alert
  if (alerts.high_price && state.currentPrice && state.currentPrice > alerts.high_price) {
    const existing = state.alerts.active.find(a => a.type === 'high_price');
    if (!existing) {
      newAlerts.push({
        id: 'high_price_' + Date.now(),
        type: 'high_price',
        severity: 'info',
        message: `Price high: ${(state.currentPrice * 100).toFixed(1)}¢ (threshold: ${(alerts.high_price * 100).toFixed(1)}¢)`,
        value: state.currentPrice,
        threshold: alerts.high_price,
        timestamp: now
      });
    }
  } else {
    state.alerts.active = state.alerts.active.filter(a => a.type !== 'high_price');
  }
  
  // Overload alert
  if (alerts.overload_percent && state.usagePercent > alerts.overload_percent) {
    const existing = state.alerts.active.find(a => a.type === 'overload');
    if (!existing) {
      newAlerts.push({
        id: 'overload_' + Date.now(),
        type: 'overload',
        severity: 'danger',
        message: `Power usage high: ${state.usagePercent.toFixed(0)}% (threshold: ${alerts.overload_percent}%)`,
        value: state.usagePercent,
        threshold: alerts.overload_percent,
        timestamp: now
      });
    }
  } else {
    state.alerts.active = state.alerts.active.filter(a => a.type !== 'overload');
  }
  
  // Add new alerts to active and history
  for (const alert of newAlerts) {
    state.alerts.active.push(alert);
    state.alerts.history.unshift(alert);
    log('warn', 'Alert triggered: ' + alert.message, { type: alert.type });
    
    // Send webhook notification if enabled
    sendWebhookNotification(alert);
  }
  
  // Keep history limited
  if (state.alerts.history.length > 100) {
    state.alerts.history = state.alerts.history.slice(0, 100);
  }
  
  return newAlerts;
}

async function sendTestNotification() {
  const notify = config.notifications || {};
  if (!notify.enabled || !notify.webhook_url) {
    return { success: false, error: 'Notifications not configured' };
  }
  
  try {
    const payload = {
      title: '🧪 VoltAssistant Test',
      message: 'This is a test notification from VoltAssistant',
      type: 'test',
      severity: 'info',
      timestamp: new Date().toISOString(),
      state: {
        soc: state.battery.soc || 0,
        price: state.currentPrice || 0,
        period: state.currentPeriod || 'unknown'
      }
    };
    
    const res = await fetch(notify.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      log('success', 'Test notification sent');
      return { success: true };
    } else {
      const error = 'HTTP ' + res.status;
      log('error', 'Test notification failed: ' + error);
      return { success: false, error };
    }
  } catch (e) {
    log('error', 'Test notification failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

async function sendWebhookNotification(alert) {
  const notify = config.notifications || {};
  if (!notify.enabled || !notify.webhook_url) return;
  
  // Check Do Not Disturb mode
  if (dndUntil && new Date() < new Date(dndUntil)) {
    log('info', 'Notification suppressed (DND mode)');
    return;
  }
  
  // Check if we should send this type of notification
  if (alert.type === 'low_soc' && !notify.on_low_soc) return;
  
  try {
    const payload = {
      title: '⚡ VoltAssistant Alert',
      message: alert.message,
      type: alert.type,
      severity: alert.severity,
      value: alert.value,
      threshold: alert.threshold,
      timestamp: alert.timestamp,
      state: {
        soc: state.battery.soc,
        price: state.currentPrice,
        period: state.currentPeriod
      }
    };
    
    await fetch(notify.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    log('success', 'Webhook notification sent: ' + alert.type);
  } catch (e) {
    log('error', 'Webhook notification failed', { error: e.message });
  }
}

async function balanceLoads() {
  if (!lm().enabled) return { actions: [] };
  await updateState();
  const actions = [];
  
  if (state.isOverloaded) {
    const excess = state.load.power - state.maxAvailable;
    log('warn', 'Overload detected', { excess, load: state.load.power, max: state.maxAvailable });
    let saved = 0;
    for (const priority of ['accessory', 'comfort']) {
      if (saved >= excess) break;
      const toShed = state.loads.filter(l => l.priority === priority && l.switch_entity && l.is_on && !state.shedLoads.includes(l.id));
      for (const load of toShed) {
        if (saved >= excess) break;
        if (await turnOff(load.switch_entity)) {
          saved += load.current_power || load.max_power || 1000;
          state.shedLoads.push(load.id);
          actions.push(`⬇️ ${load.name} off`);
          log('warn', `Shed load: ${load.name}`, { saved, excess });
        }
      }
    }
    if (actions.length) saveState();
  } else if (state.shedLoads.length > 0) {
    const headroom = state.maxAvailable - state.load.power;
    for (const id of [...state.shedLoads]) {
      const load = state.loads.find(l => l.id === id);
      if (load && (load.max_power || 1000) <= headroom * 0.8) {
        if (await turnOn(load.switch_entity)) {
          state.shedLoads = state.shedLoads.filter(i => i !== id);
          actions.push(`⬆️ ${load.name} on`);
          log('success', `Restored load: ${load.name}`);
        }
      }
    }
    if (actions.length) saveState();
  }
  return { actions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web UI
// ─────────────────────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html>
<head>
  <title>VoltAssistant</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0d1117; color: #e6edf3; padding: 16px; max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .tab { padding: 10px 20px; background: #21262d; border: none; color: #e6edf3; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .tab.active { background: #238636; }
    .panel { display: none; }
    .panel.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 14px; }
    .card.wide { grid-column: 1 / -1; }
    .card h2 { font-size: 11px; color: #8b949e; text-transform: uppercase; margin-bottom: 8px; }
    .big { font-size: 28px; font-weight: 700; }
    .unit { font-size: 12px; color: #8b949e; }
    .sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .ok { color: #3fb950; } .warn { color: #d29922; } .danger { color: #f85149; }
    .valle { color: #3fb950; } .llano { color: #d29922; } .punta { color: #f85149; }
    .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #30363d; }
    .row:last-child { border: none; }
    .period-bar { display: flex; gap: 4px; margin: 8px 0; }
    .period-bar span { flex: 1; text-align: center; padding: 8px; border-radius: 6px; font-size: 12px; font-weight: 600; opacity: 0.3; border: 1px solid transparent; }
    .period-bar span.active { opacity: 1; }
    .period-bar .valle { background: #23883622; border-color: #238636; color: #3fb950; }
    .period-bar .llano { background: #d2992222; border-color: #d29922; color: #d29922; }
    .period-bar .punta { background: #f8514922; border-color: #f85149; color: #f85149; }
    .progress { height: 10px; background: #30363d; border-radius: 5px; margin-top: 8px; overflow: hidden; position: relative; }
    .progress-bar { height: 100%; border-radius: 5px; transition: width 0.3s; }
    .progress-target { position: absolute; top: -2px; bottom: -2px; width: 3px; background: #fff; border-radius: 2px; }
    .target-control { display: flex; gap: 8px; margin-top: 12px; }
    .target-control input { flex: 1; background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 10px; color: #e6edf3; font-size: 16px; }
    .target-control button { background: #238636; border: none; padding: 10px 20px; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
    .target-control button.clear { background: #6e7681; }
    .btn { background: #238636; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; margin-right: 8px; margin-top: 8px; }
    .btn.secondary { background: #6e7681; }
    .btn.danger { background: #f85149; }
    .load { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #30363d; }
    .load:last-child { border: none; }
    .badge { font-size: 10px; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
    .badge.essential { background: #f85149; } .badge.comfort { background: #d29922; } .badge.accessory { background: #8957e5; }
    .shed { opacity: 0.4; }
    .charging { padding: 14px; background: #21262d; border-radius: 8px; margin-top: 12px; border-left: 4px solid #6e7681; }
    .charging.charge { border-left-color: #3fb950; }
    .charging.hold { border-left-color: #d29922; }
    /* Config styles */
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 6px; text-transform: uppercase; }
    .form-group input, .form-group select { width: 100%; background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 10px; color: #e6edf3; font-size: 14px; }
    .form-group input:focus, .form-group select:focus { outline: none; border-color: #238636; }
    .form-group .hint { font-size: 11px; color: #6e7681; margin-top: 4px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .section { margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #30363d; }
    .section h3 { font-size: 14px; margin-bottom: 16px; color: #e6edf3; }
    .load-table { width: 100%; }
    .load-table .load-row { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #21262d; border-radius: 8px; margin-bottom: 8px; }
    .load-table .load-info { flex: 1; }
    .load-table .load-name { font-weight: 600; }
    .load-table .load-entity { font-size: 12px; color: #8b949e; margin-top: 2px; }
    .load-table .load-actions { display: flex; gap: 8px; }
    .load-table .load-actions button { padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer; font-size: 12px; }
    .edit-btn { background: #30363d; color: #e6edf3; }
    .edit-btn:hover { background: #484f58; }
    .remove-btn { background: #f8514922; color: #f85149; }
    .remove-btn:hover { background: #f8514944; }
    .add-btn { background: #238636; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 12px; }
    .add-btn:hover { background: #2ea043; }
    /* Modal */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; width: 90%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
    .modal h3 { margin-bottom: 20px; font-size: 18px; }
    .modal .form-group { margin-bottom: 16px; }
    .modal .form-group label { display: block; margin-bottom: 6px; font-size: 13px; color: #8b949e; }
    .modal .form-group input, .modal .form-group select { width: 100%; padding: 10px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 14px; }
    .modal .form-group input:focus, .modal .form-group select:focus { border-color: #238636; outline: none; }
    .modal .form-group .hint { font-size: 11px; color: #6e7681; margin-top: 4px; }
    .modal-actions { display: flex; gap: 12px; margin-top: 24px; }
    .modal-actions button { flex: 1; padding: 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; }
    .modal-actions .save-btn { background: #238636; color: #fff; }
    .modal-actions .save-btn:hover { background: #2ea043; }
    .modal-actions .cancel-btn { background: #30363d; color: #e6edf3; }
    .modal-actions .cancel-btn:hover { background: #484f58; }
    .empty-state { text-align: center; padding: 32px; color: #8b949e; }
    
    /* Debug styles */
    .debug-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .debug-info .item { background: #21262d; padding: 12px; border-radius: 8px; }
    .debug-info .item .label { font-size: 11px; color: #8b949e; text-transform: uppercase; }
    .debug-info .item .value { font-size: 16px; font-weight: 600; margin-top: 4px; }
    .log-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; max-height: 400px; overflow-y: auto; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }
    .log-entry { padding: 6px 0; border-bottom: 1px solid #21262d; display: flex; gap: 8px; }
    .log-entry:last-child { border: none; }
    .log-entry .ts { color: #6e7681; min-width: 85px; }
    .log-entry .level { min-width: 20px; }
    .log-entry .msg { flex: 1; word-break: break-word; }
    .log-entry.error .msg { color: #f85149; }
    .log-entry.warn .msg { color: #d29922; }
    .log-entry.success .msg { color: #3fb950; }
    .entity-test { margin-top: 16px; }
    .entity-test .result { margin-top: 8px; padding: 12px; background: #21262d; border-radius: 8px; font-family: monospace; font-size: 12px; }
    .entity-test .result.ok { border-left: 3px solid #3fb950; }
    .entity-test .result.error { border-left: 3px solid #f85149; }
    .entity-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-top: 12px; }
    .entity-item { background: #21262d; padding: 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
    .entity-item .name { font-size: 12px; color: #8b949e; }
    .entity-item .id { font-family: monospace; font-size: 11px; margin-top: 2px; }
    .entity-item .status { font-size: 12px; font-weight: 600; }
    .entity-item .status.ok { color: #3fb950; }
    .entity-item .status.error { color: #f85149; }
    .entity-item .status.pending { color: #6e7681; }
    
    /* Chart styles */
    .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .chart-container h3 { font-size: 14px; margin-bottom: 12px; }
    .chart-wrapper { height: 200px; }
    
    /* Alert badge */
    .alert-badge { position: relative; display: inline-block; }
    .alert-badge .count { position: absolute; top: -8px; right: -8px; background: #f85149; color: #fff; font-size: 10px; font-weight: 700; min-width: 18px; height: 18px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
    .alert-banner { background: linear-gradient(90deg, #f8514922 0%, #f8514911 100%); border: 1px solid #f8514944; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; display: none; }
    .alert-banner.show { display: block; }
    .alert-banner .alert-title { font-weight: 600; color: #f85149; margin-bottom: 4px; }
    .alert-banner .alert-items { font-size: 13px; color: #e6edf3; }
    .alert-banner .dismiss { background: none; border: none; color: #8b949e; cursor: pointer; float: right; font-size: 16px; }
    .alert-banner .dismiss:hover { color: #f85149; }
  </style>
</head>
<body>
  <h1>⚡ VoltAssistant <span id="conn-status" style="font-size:10px;vertical-align:middle;margin-left:8px;">🔴</span> <span class="alert-badge" id="alert-indicator" style="display:none;"><span class="count" id="alert-count">0</span></span> <span id="last-update" style="font-size:11px;font-weight:normal;color:#8b949e;">⏱️ --</span></h1>
  
  <div id="alert-banner" class="alert-banner">
    <button class="dismiss" onclick="dismissAlerts()">✕</button>
    <div class="alert-title">⚠️ Active Alerts</div>
    <div class="alert-items" id="alert-items">--</div>
  </div>
  
  <div class="tabs">
    <button class="tab active" onclick="showPanel('status')">Status</button>
    <button class="tab" onclick="showPanel('forecast')">🔮 Forecast</button>
    <button class="tab" onclick="showPanel('ev')">🚗 EV</button>
    <button class="tab" onclick="showPanel('stats')">📈 Stats</button>
    <button class="tab" onclick="showPanel('charts')">📊 Charts</button>
    <button class="tab" onclick="showPanel('config')">⚙️ Config</button>
    <button class="tab" onclick="showPanel('debug')">🐛 Debug</button>
  </div>
  
  <!-- STATUS PANEL -->
  <div id="status-panel" class="panel active">
    <div class="card wide" id="summary-card" style="background:linear-gradient(135deg,#1a1a1a 0%,#0d1117 100%);border:1px solid #30363d;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;">
        <div>
          <div style="font-size:24px;font-weight:bold;margin-bottom:4px;" id="summary-action">⏳ Loading...</div>
          <div style="color:#8b949e;" id="summary-reason">Analyzing system state...</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:14px;color:#8b949e;">Next cheap hour</div>
          <div style="font-size:20px;font-weight:bold;color:#3fb950;" id="summary-next-cheap">--:00</div>
        </div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🔋 Battery</h2>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="big"><span id="soc">--</span><span class="unit">%</span></div>
        <div id="batKwh" class="sub">-- kWh</div>
      </div>
      <div class="progress">
        <div class="progress-bar" id="socBar" style="width:0%;background:#3fb950"></div>
        <div class="progress-target" id="targetMarker" style="left:80%"></div>
      </div>
      <div class="sub" style="margin-top:8px">
        Target: <strong id="targetSoc">--</strong>% <span id="targetType">(auto)</span>
        <span id="manualExpiry" style="display:none;margin-left:8px;color:#d29922;">⏱️ <span id="expiryTime">--</span></span>
      </div>
      <div class="target-control">
        <input type="number" id="manualTarget" placeholder="Target SOC %" min="10" max="100">
        <button onclick="setTarget()">Apply</button>
        <button class="clear" onclick="clearTarget()">Auto</button>
      </div>
      <div class="charging" id="chargingBox">
        <div id="chargingDecision">--</div>
        <div class="sub" id="chargingReason">--</div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>Tariff Period</h2>
      <div class="period-bar">
        <span class="valle" id="p-valle">Valle</span>
        <span class="llano" id="p-llano">Llano</span>
        <span class="punta" id="p-punta">Punta</span>
      </div>
      <div class="row"><span>PVPC Price</span><span id="price">--</span></div>
      <div class="row"><span>Contracted Power</span><span id="contracted">--</span></div>
      <div class="row"><span>Current Usage</span><span id="usage">--</span></div>
      <div class="row"><span>Next Period</span><span id="next-period">--</span></div>
      <div class="row"><span>Price Quality</span><span id="price-quality">--</span></div>
    </div>
    
    <div class="card wide" style="padding:20px;">
      <h2 style="margin-bottom:16px;">⚡ Energy Flow</h2>
      <div style="display:flex;justify-content:space-around;align-items:center;flex-wrap:wrap;gap:16px;">
        <div style="text-align:center;">
          <div style="font-size:32px;">☀️</div>
          <div class="big" id="pv" style="font-size:24px;">--<span class="unit">W</span></div>
          <div style="color:#8b949e;font-size:12px;">Solar</div>
        </div>
        <div id="flow-solar-to-load" style="font-size:20px;color:#f0883e;">→</div>
        <div style="text-align:center;">
          <div style="font-size:32px;">🏠</div>
          <div class="big" id="load" style="font-size:24px;">--<span class="unit">W</span></div>
          <div style="color:#8b949e;font-size:12px;">Load</div>
        </div>
        <div id="flow-grid" style="font-size:20px;color:#58a6ff;">↔</div>
        <div style="text-align:center;">
          <div style="font-size:32px;">⚡</div>
          <div class="big" id="grid" style="font-size:24px;">--<span class="unit">W</span></div>
          <div class="sub" id="gridDir" style="font-size:11px;">--</div>
        </div>
      </div>
    </div>
    
    <div class="grid" style="grid-template-columns:1fr 1fr;">
      <div class="card"><h2>System</h2><div class="big" id="status">--</div><div class="sub" id="health-detail">--</div></div>
      <div class="card"><h2>🔋 Battery Power</h2><div class="big" id="bat-power">--<span class="unit">W</span></div><div class="sub" id="bat-power-dir">--</div></div>
    </div>
    
    <div class="card wide">
      <h2>🔌 Controllable Loads</h2>
      <div id="loads">--</div>
      <button class="btn" onclick="runBalance()">🔄 Balance</button>
      <button class="btn secondary" onclick="restoreAll()">⬆️ Restore All</button>
    </div>
    
    <div class="card wide">
      <h2>⚡ Quick Actions</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn" onclick="quickAction('charge_100')">🔋 100%</button>
        <button class="btn" onclick="quickAction('charge_80')">🔋 80%</button>
        <button class="btn" onclick="quickAction('charge_50')">🔋 50%</button>
        <button class="btn secondary" onclick="quickAction('stop_charge')">⏹️ Stop</button>
        <button class="btn secondary" onclick="quickAction('discharge')">⚡ Discharge</button>
        <button class="btn secondary" onclick="quickAction('hold')">⏸️ Hold</button>
        <button class="btn secondary" onclick="quickAction('night_mode')">🌙 Night</button>
        <button class="btn secondary" onclick="quickAction('force_export')">📤 Export</button>
        <button class="btn secondary" onclick="quickAction('vacation')">🏖️ Vacation</button>
        <button class="btn secondary" onclick="quickAction('storm')">⛈️ Storm</button>
        <button class="btn" onclick="quickAction('auto')" style="background:#58a6ff;">🤖 Auto</button>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
        <span style="color:#8b949e;">Presets:</span>
        <button class="btn secondary" style="font-size:11px;padding:4px 8px;" onclick="applyPreset('eco')">🌿 Eco</button>
        <button class="btn secondary" style="font-size:11px;padding:4px 8px;" onclick="applyPreset('balanced')">⚖️ Balanced</button>
        <button class="btn secondary" style="font-size:11px;padding:4px 8px;" onclick="applyPreset('full')">🔋 Full</button>
        <button class="btn secondary" style="font-size:11px;padding:4px 8px;" onclick="applyPreset('export')">📤 Export</button>
      </div>
      <div id="quick-action-result" class="sub" style="margin-top:12px;"></div>
    </div>
  </div>
  
  <!-- FORECAST PANEL -->
  <div id="forecast-panel" class="panel">
    <div class="grid">
      <div class="card">
        <h2>☀️ Solar Today</h2>
        <div class="big" id="fc-solar-today">--<span class="unit">kWh</span></div>
        <div class="sub">Peak: <span id="fc-solar-peak">--</span>W at <span id="fc-solar-peak-hour">--</span>:00</div>
        <div class="sub" style="margin-top:4px;font-size:11px;color:#8b949e;">🌅 <span id="fc-sunrise">--</span> - 🌆 <span id="fc-sunset">--</span></div>
      </div>
      <div class="card">
        <h2>☀️ Solar Tomorrow</h2>
        <div class="big" id="fc-solar-tomorrow">--<span class="unit">kWh</span></div>
      </div>
      <div class="card">
        <h2>💶 Avg Price Today</h2>
        <div class="big" id="fc-price-avg">--<span class="unit">€</span></div>
        <div class="sub">Min: <span id="fc-price-min">--</span> · Max: <span id="fc-price-max">--</span></div>
      </div>
      <div class="card">
        <h2>💰 Monthly Savings</h2>
        <div class="big ok" id="fc-savings">--<span class="unit">€</span></div>
        <div class="sub" id="fc-savings-pct">--%</div>
      </div>
      <div class="card">
        <h2>📊 Est. Daily Cost</h2>
        <div class="big" id="fc-daily-cost">--<span class="unit">€</span></div>
        <div class="sub" id="fc-daily-cost-detail">-- kWh imported</div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🎯 Charging Plan</h2>
      <div id="fc-plan-action" class="charging">
        <div id="fc-plan-decision">Loading...</div>
        <div class="sub" id="fc-plan-reason">--</div>
      </div>
      <div style="margin-top:16px;">
        <div class="row"><span>Next Charge Hour</span><span id="fc-next-charge">--</span></div>
        <div class="row"><span>Optimal Hours</span><span id="fc-charge-hours">--</span></div>
        <div class="row"><span>Needed from Grid</span><span id="fc-needed-kwh">--</span></div>
        <div class="row"><span>Estimated Cost</span><span id="fc-est-cost">--</span></div>
        <div class="row"><span>Solar Coverage</span><span id="fc-solar-coverage">--</span></div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>💶 Today's Prices</h2>
      <div id="fc-price-chart" style="display:flex;gap:2px;height:100px;align-items:flex-end;margin-top:12px;"></div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#8b949e;">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
      </div>
      <div style="margin-top:12px;">
        <span class="badge" style="background:#3fb950">Cheapest: <span id="fc-cheapest-hours">--</span></span>
        <span class="badge" style="background:#f85149;margin-left:8px;">Expensive: <span id="fc-expensive-hours">--</span></span>
      </div>
    </div>
    
    <div class="card wide">
      <h2>☀️ Solar Forecast</h2>
      <div id="fc-solar-chart" style="display:flex;gap:2px;height:80px;align-items:flex-end;margin-top:12px;"></div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#8b949e;">
        <span>06:00</span><span>09:00</span><span>12:00</span><span>15:00</span><span>18:00</span>
      </div>
    </div>
    
    <button class="btn" onclick="loadForecast()">🔄 Refresh Forecast</button>
    
    <div class="card wide" style="margin-top:16px;">
      <h2>📋 Hourly Prices (Next 12h)</h2>
      <div id="fc-price-table" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;"></div>
    </div>
  </div>
  
  <!-- CHARTS PANEL -->
  <div id="charts-panel" class="panel">
    <div class="chart-container">
      <h3>🔋 Battery SOC (Last 24h)</h3>
      <div class="chart-wrapper"><canvas id="chart-soc"></canvas></div>
    </div>
    <div class="chart-container">
      <h3>💶 PVPC Price (Last 24h)</h3>
      <div class="chart-wrapper"><canvas id="chart-price"></canvas></div>
    </div>
    <div class="chart-container">
      <h3>⚡ Power Flow (Last 24h)</h3>
      <div class="chart-wrapper"><canvas id="chart-power"></canvas></div>
    </div>
    <button class="btn" onclick="loadCharts()">🔄 Refresh Charts</button>
  </div>
  
  <!-- EV PANEL -->
  <div id="ev-panel" class="panel">
    <div class="grid">
      <div class="card">
        <h2>🚗 Car Battery</h2>
        <div class="big" id="ev-soc">--<span class="unit">%</span></div>
        <div class="sub">Target: <span id="ev-target">80</span>%</div>
      </div>
      <div class="card">
        <h2>⏰ Ready By</h2>
        <div class="big" id="ev-ready-time">--</div>
        <div class="sub" id="ev-hours-left">-- hours left</div>
      </div>
      <div class="card">
        <h2>⚡ Charger</h2>
        <div class="big" id="ev-power">--<span class="unit">kW</span></div>
        <div class="sub" id="ev-slot-status">--</div>
      </div>
      <div class="card">
        <h2>💶 Est. Cost</h2>
        <div class="big" id="ev-cost">--<span class="unit">€</span></div>
        <div class="sub" id="ev-kwh-needed">-- kWh needed</div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>📋 Charging Plan</h2>
      <div class="charging" id="ev-plan-box">
        <div id="ev-recommendation">Loading...</div>
        <div class="sub" id="ev-plan-details">--</div>
      </div>
      <div style="margin-top:16px;">
        <div class="row"><span>Current Period</span><span id="ev-period">--</span></div>
        <div class="row"><span>Optimal Hours</span><span id="ev-optimal-hours">--</span></div>
        <div class="row"><span>Hours Needed</span><span id="ev-hours-needed">--</span></div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🔋 Hourly Prices</h2>
      <div id="ev-price-chart" style="display:flex;gap:2px;height:80px;align-items:flex-end;margin-top:12px;"></div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#8b949e;">
        <span>Now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span>
      </div>
      <div class="sub" style="margin-top:12px;">Green bars = planned charging hours</div>
    </div>
    
    <button class="btn" onclick="loadEV()">🔄 Refresh</button>
    <button class="btn secondary" onclick="startEVCharge()">⚡ Start Charging Now</button>
    <button class="btn secondary" onclick="stopEVCharge()">⏹️ Stop Charging</button>
  </div>
  
  <!-- STATS PANEL -->
  <div id="stats-panel" class="panel">
    <div class="grid">
      <div class="card">
        <h2>🔋 SOC Range</h2>
        <div class="big" id="st-soc-range">--</div>
        <div class="sub">Min - Max today</div>
      </div>
      <div class="card">
        <h2>☀️ Solar</h2>
        <div class="big ok" id="st-solar">--<span class="unit">kWh</span></div>
        <div class="sub">Generated today</div>
      </div>
      <div class="card">
        <h2>⬇️ Grid Import</h2>
        <div class="big warn" id="st-import">--<span class="unit">kWh</span></div>
        <div class="sub">From grid today</div>
      </div>
      <div class="card">
        <h2>⬆️ Grid Export</h2>
        <div class="big ok" id="st-export">--<span class="unit">kWh</span></div>
        <div class="sub">To grid today</div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>📊 Today's Summary</h2>
      <div style="margin-top:16px;">
        <div class="row"><span>Data Points</span><span id="st-points">--</span></div>
        <div class="row"><span>Average Load</span><span id="st-avg-load">-- W</span></div>
        <div class="row"><span>Peak Load</span><span id="st-peak-load">-- W</span></div>
        <div class="row"><span>Average Price</span><span id="st-avg-price">-- €/kWh</span></div>
        <div class="row"><span>Price Range</span><span id="st-price-range">--</span></div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>⚡ Power Summary</h2>
      <div class="grid" style="margin-top:16px;">
        <div style="text-align:center;padding:16px;background:#21262d;border-radius:8px;">
          <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Current SOC</div>
          <div style="font-size:32px;font-weight:700;color:#3fb950;" id="st-current-soc">--%</div>
        </div>
        <div style="text-align:center;padding:16px;background:#21262d;border-radius:8px;">
          <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Target SOC</div>
          <div style="font-size:32px;font-weight:700;color:#58a6ff;" id="st-target-soc">--%</div>
        </div>
        <div style="text-align:center;padding:16px;background:#21262d;border-radius:8px;">
          <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Battery kWh</div>
          <div style="font-size:32px;font-weight:700;" id="st-battery-kwh">--</div>
        </div>
        <div style="text-align:center;padding:16px;background:#21262d;border-radius:8px;">
          <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Capacity</div>
          <div style="font-size:32px;font-weight:700;color:#8b949e;" id="st-capacity">-- kWh</div>
        </div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🔮 Forecast Summary</h2>
      <div style="margin-top:16px;">
        <div class="row"><span>Solar Today</span><span id="st-fc-solar-today">-- kWh</span></div>
        <div class="row"><span>Solar Tomorrow</span><span id="st-fc-solar-tomorrow">-- kWh</span></div>
        <div class="row"><span>Cheapest Hours</span><span id="st-fc-cheap">--</span></div>
        <div class="row"><span>Expensive Hours</span><span id="st-fc-expensive">--</span></div>
        <div class="row"><span>Tomorrow Prices Available</span><span id="st-fc-tomorrow">--</span></div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>📜 Alert History</h2>
      <div id="alert-history" style="max-height:200px;overflow-y:auto;margin-top:12px;">
        <p style="color:#8b949e;">No alerts recorded</p>
      </div>
      <button class="btn secondary" onclick="clearAlertHistory()" style="margin-top:12px;">🗑️ Clear History</button>
    </div>
    
    <button class="btn" onclick="loadStats()">🔄 Refresh Stats</button>
  </div>
  
  <!-- CONFIG PANEL -->
  <div id="config-panel" class="panel">
    <div class="card wide">
      <div class="section">
        <h3>🔌 Inverter</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Max Power (W)</label>
            <input type="number" id="cfg-inv-max-power" value="6000">
            <div class="hint">Maximum inverter output power</div>
          </div>
          <div class="form-group">
            <label>Battery Capacity (kWh)</label>
            <input type="number" id="cfg-inv-capacity" step="0.1" value="32.6">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Min SOC (%)</label>
            <input type="number" id="cfg-inv-min-soc" value="10">
            <div class="hint">Never discharge below this</div>
          </div>
          <div class="form-group">
            <label>Max SOC (%)</label>
            <input type="number" id="cfg-inv-max-soc" value="100">
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>📊 Sensors (HA Entity IDs)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Battery SOC</label>
            <input type="text" id="cfg-sens-soc" placeholder="sensor.inverter_battery_soc">
          </div>
          <div class="form-group">
            <label>Battery Power</label>
            <input type="text" id="cfg-sens-bat-power" placeholder="sensor.inverter_battery_power">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Grid Power</label>
            <input type="text" id="cfg-sens-grid" placeholder="sensor.inverter_grid_power">
          </div>
          <div class="form-group">
            <label>Load Power</label>
            <input type="text" id="cfg-sens-load" placeholder="sensor.inverter_load_power">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Solar Power</label>
            <input type="text" id="cfg-sens-pv" placeholder="sensor.inverter_pv_power">
          </div>
          <div class="form-group">
            <label>PVPC Price</label>
            <input type="text" id="cfg-sens-price" placeholder="sensor.esios_pvpc">
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>🎛️ Controls (HA Entity IDs)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Program 1 SOC Target</label>
            <input type="text" id="cfg-ctrl-prog1" placeholder="number.inverter_program_1_soc">
            <div class="hint">Number entity to set charging target</div>
          </div>
          <div class="form-group">
            <label>Grid Charge Start SOC</label>
            <input type="text" id="cfg-ctrl-grid-start" placeholder="number.inverter_grid_charging_start">
            <div class="hint">Number entity to trigger grid charging</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Work Mode Select</label>
            <input type="text" id="cfg-ctrl-workmode" placeholder="select.inverter_work_mode">
            <div class="hint">(Optional) Select entity for work mode</div>
          </div>
          <div class="form-group">
            <label>Tariff Period Sensor</label>
            <input type="text" id="cfg-sens-period" placeholder="sensor.tariff_period">
            <div class="hint">(Optional) Shows valle/llano/punta</div>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>🎯 Battery Optimization</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Default Target SOC (%)</label>
            <input type="number" id="cfg-opt-default-soc" value="80">
          </div>
          <div class="form-group">
            <label>Keep Full on Weekends</label>
            <select id="cfg-opt-weekends">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Always Charge Below (€/kWh)</label>
            <input type="number" id="cfg-opt-low-price" step="0.01" value="0.05">
            <div class="hint">Charge to 100% when price is below this</div>
          </div>
          <div class="form-group">
            <label>Never Charge Above (€/kWh)</label>
            <input type="number" id="cfg-opt-high-price" step="0.01" value="0.15">
            <div class="hint">Don't charge when price is above this</div>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>⚡ Tariff Periods</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Valle - Contracted Power (kW)</label>
            <input type="number" id="cfg-tariff-valle-power" step="0.1" value="6.9">
          </div>
          <div class="form-group">
            <label>Valle - Target SOC (%)</label>
            <input type="number" id="cfg-tariff-valle-soc" value="100">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Llano - Contracted Power (kW)</label>
            <input type="number" id="cfg-tariff-llano-power" step="0.1" value="3.45">
          </div>
          <div class="form-group">
            <label>Punta - Contracted Power (kW)</label>
            <input type="number" id="cfg-tariff-punta-power" step="0.1" value="3.45">
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>🔔 Alerts & Notifications</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Low Battery Alert (%)</label>
            <input type="number" id="cfg-alert-low-soc" value="15">
            <div class="hint">Alert when SOC drops below this</div>
          </div>
          <div class="form-group">
            <label>High Price Alert (€/kWh)</label>
            <input type="number" id="cfg-alert-high-price" step="0.01" value="0.20">
            <div class="hint">Alert when price exceeds this</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Overload Margin (%)</label>
            <input type="number" id="cfg-alert-overload" value="90">
            <div class="hint">Alert at this % of contracted power</div>
          </div>
          <div class="form-group">
            <label>Solar Underperformance (%)</label>
            <input type="number" id="cfg-alert-solar" value="50">
            <div class="hint">Alert if solar is below forecast by this %</div>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>🚗 EV Charging</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Enable EV Charging</label>
            <select id="cfg-ev-enabled">
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Car SOC Sensor</label>
            <input type="text" id="cfg-ev-soc-sensor" placeholder="sensor.car_battery_soc">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Charger Max Power (kW)</label>
            <input type="number" id="cfg-ev-max-power" step="0.1" value="7.4">
          </div>
          <div class="form-group">
            <label>Target Car SOC (%)</label>
            <input type="number" id="cfg-ev-target-soc" value="80">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Ready By Time</label>
            <input type="text" id="cfg-ev-ready-time" placeholder="07:30">
            <div class="hint">Time when car should be charged</div>
          </div>
          <div class="form-group">
            <label>Charge Only in Valle</label>
            <select id="cfg-ev-valle-only">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h3>🔔 Notifications (Webhook)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Enable Notifications</label>
            <select id="cfg-notify-enabled">
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Webhook URL</label>
            <input type="text" id="cfg-notify-url" placeholder="https://your-webhook-url.com/notify">
            <div class="hint">POST requests with JSON payload</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Notify on Low SOC</label>
            <select id="cfg-notify-low-soc">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div class="form-group">
            <label>Notify on Cheap Hours</label>
            <select id="cfg-notify-cheap">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        </div>
        <button class="btn secondary" onclick="testNotification()" style="margin-top:12px;">🔔 Test</button>
        <button class="btn secondary" onclick="toggleDND()" id="dnd-btn" style="margin-top:12px;">🔕 DND Off</button>
        <span id="notify-test-result" class="sub" style="margin-left:12px;"></span>
      </div>
      
      <div class="section">
        <h3>🔌 Controllable Loads</h3>
        <div id="config-loads" class="load-table"></div>
        <button class="add-btn" onclick="openLoadModal(-1)">+ Add Load</button>
      </div>
      
      <button class="btn" onclick="saveConfig()">💾 Save Configuration</button>
      <button class="btn secondary" onclick="loadConfig()">🔄 Reload</button>
      <button class="btn secondary" onclick="testAllFromConfig()" style="background:#d29922;">🧪 Test Sensors</button>
      <button class="btn secondary" onclick="exportConfig()">📤 Export</button>
      <button class="btn secondary" onclick="document.getElementById('import-file').click()">📥 Import</button>
      <input type="file" id="import-file" accept=".json" style="display:none;" onchange="importConfig(event)">
      <button class="btn secondary" onclick="resetConfig()" style="background:#f85149;">🗑️ Reset</button>
      <div id="config-test-result" class="sub" style="margin-top:12px;"></div>
    </div>
  </div>
  
  <!-- DEBUG PANEL -->
  <div id="debug-panel" class="panel">
    <div class="card wide">
      <h2>ℹ️ System Info</h2>
      <div class="debug-info">
        <div class="item">
          <div class="label">Version</div>
          <div class="value">v1.3.0</div>
        </div>
        <div class="item">
          <div class="label">Uptime</div>
          <div class="value" id="dbg-uptime">--</div>
        </div>
        <div class="item">
          <div class="label">Memory</div>
          <div class="value" id="dbg-memory">--</div>
        </div>
        <div class="item">
          <div class="label">Data Points</div>
          <div class="value" id="dbg-datapoints">--</div>
        </div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🔗 Connection Status</h2>
      <div class="debug-info">
        <div class="item">
          <div class="label">HA Connection</div>
          <div class="value" id="dbg-ha-status">--</div>
        </div>
        <div class="item">
          <div class="label">Last Success</div>
          <div class="value" id="dbg-ha-last-ok">--</div>
        </div>
        <div class="item">
          <div class="label">Last Error</div>
          <div class="value" id="dbg-ha-last-err">--</div>
        </div>
        <div class="item">
          <div class="label">HA URL</div>
          <div class="value" id="dbg-ha-url">--</div>
        </div>
        <div class="item">
          <div class="label">Mode</div>
          <div class="value">
            <button class="btn" onclick="toggleDemoMode()" id="demo-toggle" style="font-size:11px;padding:4px 8px;">🎭 Demo Mode</button>
          </div>
        </div>
      </div>
    </div>
    
    <div class="card wide">
      <h2>🧪 Entity Tests</h2>
      <p class="sub">Test if configured sensors are responding correctly</p>
      <button class="btn" onclick="testAllEntities()">🔍 Test All Entities</button>
      <button class="btn secondary" onclick="clearEntityTests()">Clear</button>
      <div id="entity-tests" class="entity-grid"></div>
    </div>
    
    <div class="card wide">
      <h2>📊 Internal State</h2>
      <button class="btn" onclick="loadDebugState()">🔄 Refresh State</button>
      <pre id="debug-state" style="margin-top:12px;background:#21262d;padding:12px;border-radius:8px;font-size:11px;overflow-x:auto;max-height:300px;overflow-y:auto;">--</pre>
    </div>
    
    <div class="card wide">
      <h2>📜 Recent Logs</h2>
      <button class="btn" onclick="loadLogs()">🔄 Refresh</button>
      <button class="btn danger" onclick="clearLogs()">🗑️ Clear</button>
      <div id="logs" class="log-container" style="margin-top:12px;">--</div>
    </div>
  </div>
  
  <!-- Load Modal -->
  <div id="load-modal" class="modal-overlay" onclick="if(event.target===this)closeLoadModal()">
    <div class="modal">
      <h3 id="modal-title">Add Load</h3>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="load-name" placeholder="e.g. EV Charger">
        <div class="hint">Display name for this load</div>
      </div>
      <div class="form-group">
        <label>ID</label>
        <input type="text" id="load-id" placeholder="e.g. ev_charger">
        <div class="hint">Unique identifier (lowercase, no spaces)</div>
      </div>
      <div class="form-group">
        <label>Priority</label>
        <select id="load-priority">
          <option value="essential">Essential - Never turn off</option>
          <option value="comfort">Comfort - Turn off if needed</option>
          <option value="accessory" selected>Accessory - First to turn off</option>
        </select>
      </div>
      <div class="form-group">
        <label>Switch Entity</label>
        <input type="text" id="load-switch" placeholder="e.g. switch.ev_charger">
        <div class="hint">Home Assistant switch to control this load</div>
      </div>
      <div class="form-group">
        <label>Power Sensor (optional)</label>
        <input type="text" id="load-power-sensor" placeholder="e.g. sensor.ev_charger_power">
        <div class="hint">Sensor showing current power consumption</div>
      </div>
      <div class="form-group">
        <label>Max Power (W)</label>
        <input type="number" id="load-max-power" placeholder="e.g. 7400" value="1000">
        <div class="hint">Maximum expected power consumption</div>
      </div>
      <div class="modal-actions">
        <button class="cancel-btn" onclick="closeLoadModal()">Cancel</button>
        <button class="save-btn" onclick="saveLoad()">Save Load</button>
      </div>
    </div>
  </div>
  
  <script>
    const base = window.location.pathname.replace(/\\/$/, '');
    let currentConfig = {};
    let charts = {};
    
    function showPanel(name) {
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(name + '-panel').classList.add('active');
      event.target.classList.add('active');
      if (name === 'config') loadConfig();
      if (name === 'debug') { loadDebug(); loadLogs(); }
      if (name === 'charts') loadCharts();
      if (name === 'forecast') loadForecast();
      if (name === 'ev') loadEV();
      if (name === 'stats') loadStats();
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // STATUS
    // ─────────────────────────────────────────────────────────────────────────
    
    async function refresh() {
      try {
        const endpoint = demoMode ? '/api/demo' : '/api/status';
        const res = await fetch(base + endpoint);
        const d = await res.json();
        
        document.getElementById('soc').textContent = d.battery.soc.toFixed(0);
        document.getElementById('soc').title = d.battery.kwh.toFixed(2) + ' kWh stored';
        document.getElementById('batKwh').textContent = d.battery.kwh.toFixed(1) + ' / ' + d.battery.capacity.toFixed(0) + ' kWh';
        document.getElementById('socBar').style.width = d.battery.soc + '%';
        document.getElementById('socBar').title = 'Current: ' + d.battery.soc.toFixed(1) + '%';
        document.getElementById('targetMarker').style.left = d.effectiveTargetSoc + '%';
        document.getElementById('targetMarker').title = 'Target: ' + d.effectiveTargetSoc + '%';
        document.getElementById('targetSoc').textContent = d.effectiveTargetSoc;
        document.getElementById('targetType').textContent = d.manualTargetSoc !== null ? '(manual)' : '(auto)';
        
        // Show expiry timer for manual targets
        if (d.manualTargetExpiry) {
          const expiry = new Date(d.manualTargetExpiry);
          const now = new Date();
          const remaining = expiry - now;
          if (remaining > 0) {
            const hours = Math.floor(remaining / 3600000);
            const mins = Math.floor((remaining % 3600000) / 60000);
            document.getElementById('expiryTime').textContent = hours + 'h ' + mins + 'm';
            document.getElementById('manualExpiry').style.display = 'inline';
          } else {
            document.getElementById('manualExpiry').style.display = 'none';
          }
        } else {
          document.getElementById('manualExpiry').style.display = 'none';
        }
        
        const box = document.getElementById('chargingBox');
        box.className = 'charging ' + d.chargingDecision;
        document.getElementById('chargingDecision').textContent = d.chargingDecision === 'charge' ? '🔋 Charging' : '⏸️ Holding';
        document.getElementById('chargingReason').textContent = d.chargingReason;
        
        ['valle','llano','punta'].forEach(p => document.getElementById('p-'+p).classList.toggle('active', d.currentPeriod === p));
        
        // Calculate next period change
        const now = new Date();
        const hour = now.getHours();
        const isWeekend = now.getDay() === 0 || now.getDay() === 6;
        let nextChange, nextPeriod;
        
        if (isWeekend) {
          nextChange = 'Weekends are Valle all day';
          nextPeriod = '';
        } else if (hour < 8) {
          nextChange = '08:00';
          nextPeriod = 'Llano';
        } else if (hour < 10) {
          nextChange = '10:00';
          nextPeriod = 'Punta';
        } else if (hour < 14) {
          nextChange = '14:00';
          nextPeriod = 'Llano';
        } else if (hour < 18) {
          nextChange = '18:00';
          nextPeriod = 'Punta';
        } else if (hour < 22) {
          nextChange = '22:00';
          nextPeriod = 'Llano';
        } else {
          nextChange = '00:00';
          nextPeriod = 'Valle';
        }
        document.getElementById('next-period').innerHTML = nextPeriod ? nextChange + ' → <strong>' + nextPeriod + '</strong>' : nextChange;
        
        // Price quality indicator
        const price = d.currentPrice || 0;
        let quality, qualityColor;
        if (price < 0.06) { quality = '🟢 Excellent'; qualityColor = '#3fb950'; }
        else if (price < 0.10) { quality = '🟡 Good'; qualityColor = '#d29922'; }
        else if (price < 0.15) { quality = '🟠 Average'; qualityColor = '#f0883e'; }
        else { quality = '🔴 Expensive'; qualityColor = '#f85149'; }
        document.getElementById('price-quality').innerHTML = '<span style="color:' + qualityColor + '">' + quality + '</span>';
        document.getElementById('price').textContent = d.currentPrice !== null ? d.currentPrice.toFixed(3) + ' €/kWh' : '--';
        document.getElementById('contracted').textContent = (d.contractedPower/1000).toFixed(2) + ' kW';
        document.getElementById('usage').innerHTML = (d.load.power/1000).toFixed(2) + ' kW (' + d.usagePercent.toFixed(0) + '%)';
        
        document.getElementById('pv').innerHTML = d.pv.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('load').innerHTML = d.load.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('grid').innerHTML = Math.abs(d.grid.power).toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('gridDir').textContent = d.grid.power > 50 ? '← Import' : d.grid.power < -50 ? '→ Export' : '≈ Balanced';
        
        // Energy flow arrows
        document.getElementById('flow-solar-to-load').textContent = d.pv.power > 100 ? '→→' : '→';
        document.getElementById('flow-solar-to-load').style.color = d.pv.power > 100 ? '#f0883e' : '#30363d';
        document.getElementById('flow-grid').textContent = d.grid.power > 50 ? '←' : d.grid.power < -50 ? '→' : '↔';
        document.getElementById('flow-grid').style.color = d.grid.power > 50 ? '#f85149' : d.grid.power < -50 ? '#3fb950' : '#30363d';
        
        // Battery power
        document.getElementById('bat-power').innerHTML = Math.abs(d.battery.power || 0).toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('bat-power-dir').textContent = d.battery.power > 50 ? '⬆️ Charging' : d.battery.power < -50 ? '⬇️ Discharging' : '⏸️ Idle';
        
        // System health
        const issues = [];
        if (d.isOverloaded) issues.push('⚠️ Overload');
        if (d.battery.soc < 15) issues.push('🔴 Low SOC');
        if (!d.haConnection || d.haConnection.status !== 'connected') issues.push('❌ HA Offline');
        if (d.shedLoads?.length > 0) issues.push('🔌 Loads shed');
        
        if (issues.length === 0) {
          document.getElementById('status').innerHTML = '<span class="ok">✅ All OK</span>';
          document.getElementById('health-detail').textContent = 'System healthy';
        } else {
          document.getElementById('status').innerHTML = '<span class="danger">' + issues[0] + '</span>';
          document.getElementById('health-detail').textContent = issues.length > 1 ? '+' + (issues.length - 1) + ' more issues' : '';
        }
        
        document.getElementById('loads').innerHTML = d.loads.length ? d.loads.map(l =>
          '<div class="load' + (d.shedLoads.includes(l.id) ? ' shed' : '') + '">' +
            '<div><strong>' + l.name + '</strong><br><span style="color:#8b949e">' + ((l.current_power||0)/1000).toFixed(2) + ' kW</span></div>' +
            '<span class="badge ' + l.priority + '">' + l.priority + '</span>' +
          '</div>'
        ).join('') : '<p style="color:#8b949e">No loads configured. Go to Configuration tab to add loads.</p>';
        
        // Update timestamp and connection status
        document.getElementById('last-update').textContent = '⏱️ ' + new Date().toLocaleTimeString();
        document.getElementById('conn-status').textContent = d.haConnection?.status === 'connected' ? '🟢' : '🔴';
        document.getElementById('conn-status').title = d.haConnection?.status === 'connected' ? 'Connected to HA' : 'Disconnected from HA';
        
        // Update summary card
        let action, reason;
        if (d.chargingDecision === 'charge') {
          action = '⚡ Charging Battery';
          reason = d.chargingReason || 'Cheap electricity';
        } else if (d.pv?.power > 500) {
          action = '☀️ Solar Powering Home';
          reason = 'Using ' + d.pv.power + 'W from solar panels';
        } else if (d.grid?.power < -100) {
          action = '📤 Exporting to Grid';
          reason = 'Selling ' + Math.abs(d.grid.power) + 'W back to grid';
        } else if (d.battery?.soc < 20) {
          action = '⚠️ Low Battery';
          reason = 'Battery at ' + d.battery.soc + '% - consider charging';
        } else {
          action = '✅ Running Normally';
          reason = 'Battery at ' + d.battery.soc + '% - ready for peak hours';
        }
        document.getElementById('summary-action').textContent = action;
        document.getElementById('summary-reason').textContent = reason;
        
        // Generate tip
        let tip = '';
        if (d.currentPrice < 0.06 && d.battery.soc < 80) {
          tip = '💡 Tip: Price is very cheap - consider charging to 100%';
        } else if (d.pv?.power > 2000 && d.battery.soc > 90) {
          tip = '💡 Tip: Solar is high and battery full - run high-power appliances now';
        } else if (d.currentPeriod === 'punta' && d.battery.soc < 30) {
          tip = '⚠️ Warning: Peak hours with low battery - consider reducing consumption';
        } else if (d.grid?.power < -500) {
          tip = '💰 Earning: Exporting ' + Math.abs(d.grid.power) + 'W to grid!';
        }
        if (tip) {
          document.getElementById('summary-reason').textContent = tip;
        }
        
        // Find next cheap hour from current state
        const currentHour = new Date().getHours();
        const isCheap = d.currentPeriod === 'valle' || (d.currentPrice && d.currentPrice < 0.08);
        if (isCheap) {
          document.getElementById('summary-next-cheap').textContent = 'Now!';
          document.getElementById('summary-next-cheap').style.color = '#3fb950';
        } else {
          // Simplified: next valle starts at 00:00 or after 22:00
          const nextValle = currentHour >= 22 ? 'Now! (Valle)' : currentHour < 8 ? 'Now! (Valle)' : '00:00';
          document.getElementById('summary-next-cheap').textContent = nextValle;
          document.getElementById('summary-next-cheap').style.color = '#d29922';
        }
        
        // Update alerts
        if (d.alerts && d.alerts.active && d.alerts.active.length > 0) {
          document.getElementById('alert-indicator').style.display = 'inline-block';
          document.getElementById('alert-count').textContent = d.alerts.active.length;
          document.getElementById('alert-banner').classList.add('show');
          document.getElementById('alert-items').innerHTML = d.alerts.active.map(a => 
            '<div>' + (a.severity === 'danger' ? '🔴' : a.severity === 'warning' ? '🟡' : '🔵') + ' ' + a.message + '</div>'
          ).join('');
        } else {
          document.getElementById('alert-indicator').style.display = 'none';
          document.getElementById('alert-banner').classList.remove('show');
        }
      } catch (e) { 
        console.error(e);
        document.getElementById('conn-status').textContent = '🔴';
        document.getElementById('conn-status').title = 'Error: ' + e.message;
      }
    }
    
    async function dismissAlerts() {
      await fetch(base + '/api/alerts/clear', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      refresh();
    }
    
    async function toggleDND() {
      try {
        const statusRes = await fetch(base + '/api/dnd');
        const status = await statusRes.json();
        
        const hours = status.enabled ? 0 : 8; // Toggle: if on, turn off; if off, enable for 8h
        await fetch(base + '/api/dnd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hours })
        });
        
        const btn = document.getElementById('dnd-btn');
        btn.textContent = hours ? '🔕 DND On' : '🔔 DND Off';
        btn.style.background = hours ? '#f85149' : '';
      } catch (e) {
        console.error('DND toggle error:', e);
      }
    }
    
    async function checkDNDStatus() {
      try {
        const res = await fetch(base + '/api/dnd');
        const status = await res.json();
        const btn = document.getElementById('dnd-btn');
        if (btn) {
          btn.textContent = status.enabled ? '🔕 DND On' : '🔔 DND Off';
          btn.style.background = status.enabled ? '#f85149' : '';
        }
      } catch (e) {}
    }
    
    async function testNotification() {
      const resultEl = document.getElementById('notify-test-result');
      resultEl.textContent = 'Sending...';
      try {
        const res = await fetch(base + '/api/notify/test', { method: 'POST' });
        const data = await res.json();
        resultEl.innerHTML = data.success ? '<span class="ok">✅ Sent!</span>' : '<span class="danger">❌ ' + data.error + '</span>';
      } catch (e) {
        resultEl.innerHTML = '<span class="danger">❌ ' + e.message + '</span>';
      }
      setTimeout(() => resultEl.textContent = '', 5000);
    }
    
    async function resetConfig() {
      if (!confirm('Reset all configuration to defaults? This cannot be undone.')) return;
      
      try {
        await fetch(base + '/api/config/reset', { method: 'POST' });
        await loadConfig();
        document.getElementById('config-test-result').innerHTML = '<span class="ok">✅ Configuration reset to defaults</span>';
      } catch (e) {
        alert('Error resetting: ' + e.message);
      }
    }
    
    function exportConfig() {
      const blob = new Blob([JSON.stringify(currentConfig, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'voltassistant-config-' + new Date().toISOString().split('T')[0] + '.json';
      a.click();
      URL.revokeObjectURL(url);
    }
    
    async function importConfig(event) {
      const file = event.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        
        if (!imported.sensors && !imported.battery_optimization) {
          alert('Invalid configuration file');
          return;
        }
        
        currentConfig = imported;
        loadConfigValues(currentConfig);
        document.getElementById('config-test-result').innerHTML = '<span class="ok">✅ Configuration imported. Click Save to apply.</span>';
      } catch (e) {
        alert('Error importing: ' + e.message);
      }
      
      event.target.value = '';
    }
    
    async function testAllFromConfig() {
      const resultEl = document.getElementById('config-test-result');
      resultEl.innerHTML = '<span style="color:#d29922;">🧪 Testing sensors...</span>';
      
      const sensors = [
        { id: 'cfg-sens-soc', name: 'Battery SOC' },
        { id: 'cfg-sens-bat-power', name: 'Battery Power' },
        { id: 'cfg-sens-grid', name: 'Grid Power' },
        { id: 'cfg-sens-load', name: 'Load Power' },
        { id: 'cfg-sens-pv', name: 'Solar Power' },
        { id: 'cfg-sens-price', name: 'PVPC Price' },
        { id: 'cfg-ctrl-prog1', name: 'Program 1 SOC' },
        { id: 'cfg-ctrl-grid-start', name: 'Grid Charge Start' }
      ];
      
      const results = [];
      for (const s of sensors) {
        const entityId = document.getElementById(s.id)?.value;
        if (!entityId) continue;
        
        try {
          const res = await fetch(base + '/api/test-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId })
          });
          const data = await res.json();
          results.push({
            name: s.name,
            entity: entityId,
            ok: data.found,
            value: data.value
          });
        } catch (e) {
          results.push({ name: s.name, entity: entityId, ok: false, error: e.message });
        }
      }
      
      const html = results.map(r => 
        '<div style="margin:4px 0;">' +
          (r.ok ? '✅' : '❌') + ' <strong>' + r.name + '</strong>: ' +
          '<code>' + r.entity + '</code>' +
          (r.ok ? ' = ' + r.value : ' (not found)') +
        '</div>'
      ).join('');
      
      resultEl.innerHTML = html || '<span style="color:#8b949e;">No sensors configured</span>';
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // CHARTS
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadCharts() {
      try {
        const res = await fetch(base + '/api/history');
        const data = await res.json();
        
        const chartOpts = {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, labels: { color: '#8b949e' } } },
          scales: {
            x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } }, grid: { color: '#30363d' }, ticks: { color: '#8b949e' } },
            y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } }
          }
        };
        
        // SOC Chart
        if (charts.soc) charts.soc.destroy();
        charts.soc = new Chart(document.getElementById('chart-soc'), {
          type: 'line',
          data: {
            datasets: [{
              label: 'SOC %',
              data: data.soc.map(p => ({ x: p.ts, y: p.v })),
              borderColor: '#3fb950',
              backgroundColor: '#3fb95022',
              fill: true,
              tension: 0.3
            }]
          },
          options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, min: 0, max: 100 } } }
        });
        
        // Price Chart
        if (charts.price) charts.price.destroy();
        charts.price = new Chart(document.getElementById('chart-price'), {
          type: 'line',
          data: {
            datasets: [{
              label: '€/kWh',
              data: data.price.filter(p => p.v !== null).map(p => ({ x: p.ts, y: p.v })),
              borderColor: '#d29922',
              backgroundColor: '#d2992222',
              fill: true,
              tension: 0.1,
              stepped: 'before'
            }]
          },
          options: chartOpts
        });
        
        // Power Chart
        if (charts.power) charts.power.destroy();
        charts.power = new Chart(document.getElementById('chart-power'), {
          type: 'line',
          data: {
            datasets: [
              { label: 'Solar', data: data.pv.map(p => ({ x: p.ts, y: p.v })), borderColor: '#f0883e', tension: 0.3 },
              { label: 'Load', data: data.load.map(p => ({ x: p.ts, y: p.v })), borderColor: '#a371f7', tension: 0.3 },
              { label: 'Grid', data: data.grid.map(p => ({ x: p.ts, y: p.v })), borderColor: '#58a6ff', tension: 0.3 }
            ]
          },
          options: chartOpts
        });
      } catch (e) {
        console.error('Failed to load charts:', e);
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // FORECAST
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadForecast() {
      try {
        const res = await fetch(base + '/api/forecast/all');
        const d = await res.json();
        if (!d.success) throw new Error(d.error);
        
        // Solar
        if (d.solar?.today) {
          document.getElementById('fc-solar-today').innerHTML = (d.solar.today.totalKwh || 0) + '<span class="unit">kWh</span>';
          document.getElementById('fc-solar-peak').textContent = d.solar.today.peakWatts || '--';
          document.getElementById('fc-solar-peak-hour').textContent = d.solar.today.peakHour ?? '--';
          
          // Calculate approximate sunrise/sunset based on solar data
          const forecasts = d.solar.today.forecasts || [];
          const firstSolar = forecasts.find(f => f.watts > 50);
          const lastSolar = [...forecasts].reverse().find(f => f.watts > 50);
          document.getElementById('fc-sunrise').textContent = firstSolar ? (firstSolar.hour + ':00') : '07:00';
          document.getElementById('fc-sunset').textContent = lastSolar ? (lastSolar.hour + ':00') : '19:00';
        }
        if (d.solar?.tomorrow) {
          document.getElementById('fc-solar-tomorrow').innerHTML = (d.solar.tomorrow.totalKwh || 0) + '<span class="unit">kWh</span>';
        }
        
        // Prices
        if (d.prices?.today?.stats) {
          const s = d.prices.today.stats;
          document.getElementById('fc-price-avg').innerHTML = (s.avg * 100).toFixed(1) + '<span class="unit">¢</span>';
          document.getElementById('fc-price-min').textContent = (s.min * 100).toFixed(1) + '¢';
          document.getElementById('fc-price-max').textContent = (s.max * 100).toFixed(1) + '¢';
          document.getElementById('fc-cheapest-hours').textContent = (s.cheapest || []).map(h => h + ':00').join(', ') || '--';
          document.getElementById('fc-expensive-hours').textContent = (s.expensive || []).map(h => h + ':00').join(', ') || '--';
        }
        
        // Price chart (bar chart)
        if (d.prices?.today?.prices) {
          const maxPrice = Math.max(...d.prices.today.prices.map(p => p.price));
          const currentHour = new Date().getHours();
          document.getElementById('fc-price-chart').innerHTML = d.prices.today.prices.map(p => {
            const height = (p.price / maxPrice * 100).toFixed(0);
            const color = p.hour === currentHour ? '#58a6ff' : d.prices.today.stats.cheapest?.includes(p.hour) ? '#3fb950' : d.prices.today.stats.expensive?.includes(p.hour) ? '#f85149' : '#30363d';
            return '<div style="flex:1;background:' + color + ';height:' + height + '%;border-radius:2px;" title="' + p.hour + ':00 - ' + (p.price*100).toFixed(2) + '¢/kWh"></div>';
          }).join('');
        }
        
        // Solar chart (bar chart)
        if (d.solar?.today?.forecasts) {
          const daylight = d.solar.today.forecasts.filter(f => f.hour >= 6 && f.hour <= 20);
          const maxWatts = Math.max(...daylight.map(f => f.watts), 1);
          document.getElementById('fc-solar-chart').innerHTML = daylight.map(f => {
            const height = (f.watts / maxWatts * 100).toFixed(0);
            return '<div style="flex:1;background:#f0883e;height:' + height + '%;border-radius:2px;" title="' + f.hour + ':00 - ' + f.watts + 'W"></div>';
          }).join('');
        }
        
        // Plan
        if (d.plan) {
          const p = d.plan;
          const box = document.getElementById('fc-plan-action');
          box.className = 'charging ' + (p.action === 'charge_now' ? 'charge' : 'hold');
          document.getElementById('fc-plan-decision').textContent = p.action === 'charge_now' ? '⚡ Charging Now' : p.action === 'wait_for_solar' ? '☀️ Waiting for Solar' : p.action === 'wait_for_cheap' ? '⏳ Waiting for Cheap Hour' : '✅ Battery OK';
          document.getElementById('fc-plan-reason').textContent = p.reason || '--';
          document.getElementById('fc-next-charge').textContent = p.nextChargeHour !== undefined ? p.nextChargeHour + ':00' : 'N/A';
          document.getElementById('fc-charge-hours').textContent = p.chargeHours?.map(h => h + ':00').join(', ') || 'None needed';
          document.getElementById('fc-needed-kwh').textContent = (p.neededKwh || 0) + ' kWh';
          document.getElementById('fc-est-cost').textContent = '€' + (p.estimatedCost || 0).toFixed(2);
          document.getElementById('fc-solar-coverage').textContent = (p.solarCoverage || 0) + ' kWh';
        }
        
        // Savings
        if (d.savings) {
          document.getElementById('fc-savings').innerHTML = d.savings.monthlySavings + '<span class="unit">€</span>';
          document.getElementById('fc-savings-pct').textContent = d.savings.savingsPercent + '% vs base';
        }
        
        // Estimate daily cost
        if (d.plan && d.prices?.today?.stats) {
          const neededKwh = d.plan.neededKwh || 0;
          const avgPrice = d.prices.today.stats.avg || 0.12;
          const estimatedCost = neededKwh * avgPrice;
          document.getElementById('fc-daily-cost').innerHTML = estimatedCost.toFixed(2) + '<span class="unit">€</span>';
          document.getElementById('fc-daily-cost-detail').textContent = neededKwh.toFixed(1) + ' kWh from grid';
        }
        
        // Hourly price table (next 12h)
        if (d.prices?.today?.prices) {
          const currentHour = new Date().getHours();
          const next12 = [];
          for (let i = 0; i < 12; i++) {
            const h = (currentHour + i) % 24;
            const todayPrice = d.prices.today.prices.find(p => p.hour === h);
            const tomorrowPrice = d.prices.tomorrow?.prices?.find(p => p.hour === h);
            const price = (currentHour + i) < 24 ? todayPrice : tomorrowPrice;
            if (price) next12.push({ hour: h, price: price.price, isCheap: d.prices.today.stats.cheapest?.includes(h) });
          }
          document.getElementById('fc-price-table').innerHTML = next12.map(p => 
            '<div style="padding:8px;background:' + (p.isCheap ? 'rgba(63,185,80,0.2)' : '#21262d') + ';border-radius:4px;text-align:center;">' +
              '<div style="font-weight:bold;">' + p.hour.toString().padStart(2,'0') + ':00</div>' +
              '<div style="color:' + (p.isCheap ? '#3fb950' : '#e0e0e0') + ';">' + (p.price * 100).toFixed(2) + '¢</div>' +
            '</div>'
          ).join('');
        }
      } catch (e) {
        console.error('Forecast error:', e);
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // EV CHARGING
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadEV() {
      try {
        // Get status
        const statusRes = await fetch(base + '/api/ev/status');
        const status = await statusRes.json();
        
        if (!status.enabled) {
          document.getElementById('ev-recommendation').textContent = '⚠️ EV Charging not configured';
          document.getElementById('ev-plan-details').textContent = 'Go to Configuration tab to set up EV sensors';
          return;
        }
        
        document.getElementById('ev-soc').innerHTML = (status.carSoc || 0) + '<span class="unit">%</span>';
        document.getElementById('ev-target').textContent = status.targetSoc || 80;
        document.getElementById('ev-ready-time').textContent = status.readyByTime || '--:--';
        document.getElementById('ev-power').innerHTML = (status.maxPower || 0) + '<span class="unit">kW</span>';
        document.getElementById('ev-slot-status').textContent = status.chargingSlot ? '✅ Slot active' : '⏸️ No slot';
        document.getElementById('ev-period').textContent = status.currentPeriod || '--';
        
        const planBox = document.getElementById('ev-plan-box');
        planBox.className = 'charging ' + (status.shouldCharge ? 'charge' : 'hold');
        document.getElementById('ev-recommendation').textContent = status.shouldCharge ? '⚡ Charge Now' : '⏳ Wait for Valle';
        document.getElementById('ev-plan-details').textContent = status.recommendation || '--';
        
        // Get plan
        const planRes = await fetch(base + '/api/ev/plan');
        const plan = await planRes.json();
        
        if (plan.success) {
          document.getElementById('ev-cost').innerHTML = plan.estimatedCost + '<span class="unit">€</span>';
          document.getElementById('ev-kwh-needed').textContent = plan.neededKwh + ' kWh needed';
          document.getElementById('ev-optimal-hours').textContent = plan.chargeHours?.map(h => h.hour + ':00').join(', ') || 'None';
          document.getElementById('ev-hours-needed').textContent = plan.hoursNeeded + ' hours';
          
          // Calculate hours left
          const [readyHour] = (status.readyByTime || '07:30').split(':').map(Number);
          const now = new Date().getHours();
          let hoursLeft = readyHour - now;
          if (hoursLeft <= 0) hoursLeft += 24;
          document.getElementById('ev-hours-left').textContent = hoursLeft + ' hours until ready';
          
          // Render price chart with charge hours highlighted
          const prices = await fetch(base + '/api/forecast/prices').then(r => r.json());
          if (prices.today?.prices) {
            const allPrices = [...prices.today.prices, ...(prices.tomorrow?.prices || []).map(p => ({...p, hour: p.hour + 24}))];
            const next24 = allPrices.filter(p => p.hour >= now && p.hour < now + 24);
            const maxPrice = Math.max(...next24.map(p => p.price), 0.01);
            const chargeHourSet = new Set(plan.chargeHours?.map(h => h.hour) || []);
            
            document.getElementById('ev-price-chart').innerHTML = next24.map(p => {
              const height = (p.price / maxPrice * 100).toFixed(0);
              const isChargeHour = chargeHourSet.has(p.hour % 24);
              const color = isChargeHour ? '#3fb950' : '#30363d';
              return '<div style="flex:1;background:' + color + ';height:' + height + '%;border-radius:2px;" title="' + (p.hour % 24) + ':00 - ' + (p.price*100).toFixed(2) + '¢"></div>';
            }).join('');
          }
        }
      } catch (e) {
        console.error('EV error:', e);
        document.getElementById('ev-recommendation').textContent = '❌ Error loading EV data';
      }
    }
    
    async function startEVCharge() {
      // This would call HA to start the charger - placeholder for now
      alert('Start EV Charge - Configure your charger switch in loads');
    }
    
    async function stopEVCharge() {
      // This would call HA to stop the charger - placeholder for now  
      alert('Stop EV Charge - Configure your charger switch in loads');
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // STATS
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadStats() {
      try {
        // Get daily stats
        const dailyRes = await fetch(base + '/api/stats/daily');
        const daily = await dailyRes.json();
        
        if (daily.success) {
          document.getElementById('st-soc-range').textContent = daily.soc.min + '% - ' + daily.soc.max + '%';
          document.getElementById('st-solar').innerHTML = (daily.solar.total / 1000).toFixed(1) + '<span class="unit">kWh</span>';
          document.getElementById('st-import').innerHTML = (daily.grid.import / 1000).toFixed(1) + '<span class="unit">kWh</span>';
          document.getElementById('st-export').innerHTML = (daily.grid.export / 1000).toFixed(1) + '<span class="unit">kWh</span>';
          document.getElementById('st-points').textContent = daily.dataPoints;
          document.getElementById('st-avg-load').textContent = daily.load.avg + ' W';
          document.getElementById('st-peak-load').textContent = daily.load.max + ' W';
          document.getElementById('st-avg-price').textContent = (daily.price.avg * 100).toFixed(2) + ' ¢/kWh';
          document.getElementById('st-price-range').textContent = (daily.price.min * 100).toFixed(2) + ' - ' + (daily.price.max * 100).toFixed(2) + ' ¢';
        }
        
        // Get summary
        const summaryRes = await fetch(base + '/api/stats/summary');
        const summary = await summaryRes.json();
        
        if (summary.success) {
          document.getElementById('st-current-soc').textContent = summary.battery.soc + '%';
          document.getElementById('st-target-soc').textContent = summary.battery.target + '%';
          document.getElementById('st-battery-kwh').textContent = summary.battery.kwh.toFixed(1);
          document.getElementById('st-capacity').textContent = summary.battery.capacity + ' kWh';
          
          document.getElementById('st-fc-solar-today').textContent = summary.forecast.solarTodayKwh + ' kWh';
          document.getElementById('st-fc-solar-tomorrow').textContent = summary.forecast.solarTomorrowKwh + ' kWh';
          document.getElementById('st-fc-cheap').textContent = summary.forecast.cheapestHours.slice(0, 4).map(h => h + ':00').join(', ') || '--';
          document.getElementById('st-fc-expensive').textContent = summary.forecast.expensiveHours.slice(0, 4).map(h => h + ':00').join(', ') || '--';
          document.getElementById('st-fc-tomorrow').textContent = summary.forecast.tomorrowAvailable ? '✅ Yes' : '❌ Not yet';
        }
        // Load alert history
        const alertRes = await fetch(base + '/api/alerts/history');
        const alertHistory = await alertRes.json();
        
        if (alertHistory.length > 0) {
          document.getElementById('alert-history').innerHTML = alertHistory.slice(0, 20).map(a => 
            '<div style="padding:8px;border-bottom:1px solid #30363d;">' +
              '<span style="color:' + (a.severity === 'danger' ? '#f85149' : a.severity === 'warning' ? '#d29922' : '#3fb950') + ';">' +
              (a.severity === 'danger' ? '🔴' : a.severity === 'warning' ? '🟡' : '🔵') + '</span> ' +
              '<span style="color:#8b949e;font-size:11px;">' + new Date(a.timestamp).toLocaleString() + '</span><br>' +
              '<span>' + a.message + '</span>' +
            '</div>'
          ).join('');
        } else {
          document.getElementById('alert-history').innerHTML = '<p style="color:#8b949e;padding:12px;">No alerts recorded</p>';
        }
      } catch (e) {
        console.error('Stats error:', e);
      }
    }
    
    async function clearAlertHistory() {
      if (!confirm('Clear all alert history?')) return;
      await fetch(base + '/api/alerts/history', { method: 'DELETE' });
      loadStats();
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // DEBUG
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadDebug() {
      const res = await fetch(base + '/api/debug');
      const d = await res.json();
      
      // System info
      if (d.system) {
        const uptime = d.system.uptime || 0;
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        document.getElementById('dbg-uptime').textContent = hours + 'h ' + mins + 'm';
        document.getElementById('dbg-memory').textContent = ((d.system.memory || 0) / 1024 / 1024).toFixed(1) + ' MB';
        document.getElementById('dbg-datapoints').textContent = d.system.historyPoints || 0;
      }
      
      // Connection status
      document.getElementById('dbg-ha-status').innerHTML = d.haConnection.status === 'connected' 
        ? '<span class="ok">✅ Connected</span>' 
        : '<span class="danger">❌ ' + d.haConnection.status + '</span>';
      document.getElementById('dbg-ha-last-ok').textContent = d.haConnection.lastSuccess ? new Date(d.haConnection.lastSuccess).toLocaleTimeString() : '--';
      document.getElementById('dbg-ha-last-err').textContent = d.haConnection.lastError || '--';
      document.getElementById('dbg-ha-url').textContent = d.haUrl;
    }
    
    async function loadDebugState() {
      const res = await fetch(base + '/api/status');
      const d = await res.json();
      document.getElementById('debug-state').textContent = JSON.stringify(d, null, 2);
    }
    
    async function loadLogs() {
      const res = await fetch(base + '/api/logs');
      const logs = await res.json();
      document.getElementById('logs').innerHTML = logs.length ? logs.slice().reverse().map(l => 
        '<div class="log-entry ' + l.level + '">' +
          '<span class="ts">' + new Date(l.ts).toLocaleTimeString() + '</span>' +
          '<span class="level">' + (l.level === 'error' ? '❌' : l.level === 'warn' ? '⚠️' : l.level === 'success' ? '✅' : 'ℹ️') + '</span>' +
          '<span class="msg">' + l.msg + (l.data ? ' <code>' + JSON.stringify(l.data) + '</code>' : '') + '</span>' +
        '</div>'
      ).join('') : '<p style="color:#8b949e;padding:12px">No logs yet</p>';
    }
    
    async function clearLogs() {
      await fetch(base + '/api/logs', { method: 'DELETE' });
      loadLogs();
    }
    
    async function testAllEntities() {
      const container = document.getElementById('entity-tests');
      container.innerHTML = '<div style="color:#8b949e;padding:12px">Testing entities...</div>';
      
      const res = await fetch(base + '/api/test-entities');
      const results = await res.json();
      
      container.innerHTML = results.map(r => 
        '<div class="entity-item">' +
          '<div>' +
            '<div class="name">' + r.name + '</div>' +
            '<div class="id">' + r.entity_id + '</div>' +
          '</div>' +
          '<div class="status ' + (r.ok ? 'ok' : 'error') + '">' +
            (r.ok ? r.state + (r.unit ? ' ' + r.unit : '') + ' (' + r.latency + 'ms)' : r.error) +
          '</div>' +
        '</div>'
      ).join('');
    }
    
    function clearEntityTests() {
      document.getElementById('entity-tests').innerHTML = '';
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    
    async function loadConfig() {
      const res = await fetch(base + '/api/config');
      currentConfig = await res.json();
      const c = currentConfig;
      
      document.getElementById('cfg-inv-max-power').value = c.inverter?.max_power || 6000;
      document.getElementById('cfg-inv-capacity').value = c.inverter?.battery_capacity_kwh || 32.6;
      document.getElementById('cfg-inv-min-soc').value = c.inverter?.battery_min_soc || 10;
      document.getElementById('cfg-inv-max-soc').value = c.inverter?.battery_max_soc || 100;
      
      document.getElementById('cfg-sens-soc').value = c.sensors?.battery_soc || '';
      document.getElementById('cfg-sens-bat-power').value = c.sensors?.battery_power || '';
      document.getElementById('cfg-sens-grid').value = c.sensors?.grid_power || '';
      document.getElementById('cfg-sens-load').value = c.sensors?.load_power || '';
      document.getElementById('cfg-sens-pv').value = c.sensors?.pv_power || '';
      document.getElementById('cfg-sens-price').value = c.sensors?.pvpc_price || '';
      
      // Controls
      document.getElementById('cfg-ctrl-prog1').value = c.controls?.program_1_soc || '';
      document.getElementById('cfg-ctrl-grid-start').value = c.controls?.grid_charge_start_soc || '';
      document.getElementById('cfg-ctrl-workmode').value = c.controls?.work_mode || '';
      document.getElementById('cfg-sens-period').value = c.sensors?.tariff_period || '';
      
      document.getElementById('cfg-opt-default-soc').value = c.battery_optimization?.default_target_soc || 80;
      document.getElementById('cfg-opt-weekends').value = c.battery_optimization?.keep_full_weekends !== false ? 'true' : 'false';
      document.getElementById('cfg-opt-low-price').value = c.battery_optimization?.always_charge_below_price || 0.05;
      document.getElementById('cfg-opt-high-price').value = c.battery_optimization?.never_charge_above_price || 0.15;
      
      document.getElementById('cfg-tariff-valle-power').value = c.tariff_periods?.valle?.contracted_power_kw || 6.9;
      document.getElementById('cfg-tariff-valle-soc').value = c.tariff_periods?.valle?.target_soc || 100;
      document.getElementById('cfg-tariff-llano-power').value = c.tariff_periods?.llano?.contracted_power_kw || 3.45;
      document.getElementById('cfg-tariff-punta-power').value = c.tariff_periods?.punta?.contracted_power_kw || 3.45;
      
      // Alerts
      document.getElementById('cfg-alert-low-soc').value = c.alerts?.low_soc || 15;
      document.getElementById('cfg-alert-high-price').value = c.alerts?.high_price || 0.20;
      document.getElementById('cfg-alert-overload').value = c.alerts?.overload_percent || 90;
      document.getElementById('cfg-alert-solar').value = c.alerts?.solar_underperform || 50;
      
      // EV
      document.getElementById('cfg-ev-enabled').value = c.ev_charging?.enabled ? 'true' : 'false';
      document.getElementById('cfg-ev-soc-sensor').value = c.ev_charging?.car_soc_sensor || '';
      document.getElementById('cfg-ev-max-power').value = c.ev_charging?.max_charge_power_kw || 7.4;
      document.getElementById('cfg-ev-target-soc').value = c.ev_charging?.target_soc || 80;
      document.getElementById('cfg-ev-ready-time').value = c.ev_charging?.smart_plan_time || '07:30';
      document.getElementById('cfg-ev-valle-only').value = c.ev_charging?.charge_in_valle !== false ? 'true' : 'false';
      
      // Notifications
      document.getElementById('cfg-notify-enabled').value = c.notifications?.enabled ? 'true' : 'false';
      document.getElementById('cfg-notify-url').value = c.notifications?.webhook_url || '';
      document.getElementById('cfg-notify-low-soc').value = c.notifications?.on_low_soc !== false ? 'true' : 'false';
      document.getElementById('cfg-notify-cheap').value = c.notifications?.on_cheap_hours !== false ? 'true' : 'false';
      
      renderLoads(c.loads || []);
    }
    
    let editingLoadIndex = -1;
    
    function renderLoads(loads) {
      if (!loads || loads.length === 0) {
        document.getElementById('config-loads').innerHTML = '<div class="empty-state">No loads configured.<br>Click "Add Load" to add your first controllable load.</div>';
        return;
      }
      document.getElementById('config-loads').innerHTML = loads.map((l, i) => 
        '<div class="load-row">' +
          '<div class="load-info">' +
            '<div class="load-name">' + (l.name || 'Unnamed') + ' <span class="badge ' + l.priority + '">' + l.priority + '</span></div>' +
            '<div class="load-entity">' + (l.switch_entity || 'No switch') + ' · ' + (l.max_power || '?') + 'W max</div>' +
          '</div>' +
          '<div class="load-actions">' +
            '<button class="edit-btn" onclick="openLoadModal(' + i + ')">Edit</button>' +
            '<button class="remove-btn" onclick="removeLoad(' + i + ')">Delete</button>' +
          '</div>' +
        '</div>'
      ).join('');
    }
    
    function openLoadModal(index) {
      editingLoadIndex = index;
      const modal = document.getElementById('load-modal');
      const title = document.getElementById('modal-title');
      
      if (index >= 0 && currentConfig.loads && currentConfig.loads[index]) {
        const load = currentConfig.loads[index];
        title.textContent = 'Edit Load';
        document.getElementById('load-name').value = load.name || '';
        document.getElementById('load-id').value = load.id || '';
        document.getElementById('load-priority').value = load.priority || 'accessory';
        document.getElementById('load-switch').value = load.switch_entity || '';
        document.getElementById('load-power-sensor').value = load.power_sensor || '';
        document.getElementById('load-max-power').value = load.max_power || 1000;
      } else {
        title.textContent = 'Add Load';
        document.getElementById('load-name').value = '';
        document.getElementById('load-id').value = '';
        document.getElementById('load-priority').value = 'accessory';
        document.getElementById('load-switch').value = '';
        document.getElementById('load-power-sensor').value = '';
        document.getElementById('load-max-power').value = 1000;
      }
      
      modal.classList.add('show');
    }
    
    function closeLoadModal() {
      document.getElementById('load-modal').classList.remove('show');
      editingLoadIndex = -1;
    }
    
    function saveLoad() {
      const load = {
        name: document.getElementById('load-name').value,
        id: document.getElementById('load-id').value || document.getElementById('load-name').value.toLowerCase().replace(/\\s+/g, '_'),
        priority: document.getElementById('load-priority').value,
        switch_entity: document.getElementById('load-switch').value,
        power_sensor: document.getElementById('load-power-sensor').value || undefined,
        max_power: parseInt(document.getElementById('load-max-power').value) || 1000
      };
      
      if (!load.name) { alert('Please enter a name'); return; }
      if (!load.switch_entity) { alert('Please enter a switch entity'); return; }
      
      if (!currentConfig.loads) currentConfig.loads = [];
      
      if (editingLoadIndex >= 0) {
        currentConfig.loads[editingLoadIndex] = load;
      } else {
        currentConfig.loads.push(load);
      }
      
      renderLoads(currentConfig.loads);
      closeLoadModal();
    }
    
    function removeLoad(i) {
      if (confirm('Delete this load?')) {
        currentConfig.loads.splice(i, 1);
        renderLoads(currentConfig.loads);
      }
    }
    
    async function saveConfig() {
      const config = {
        inverter: {
          max_power: parseInt(document.getElementById('cfg-inv-max-power').value),
          battery_capacity_kwh: parseFloat(document.getElementById('cfg-inv-capacity').value),
          battery_min_soc: parseInt(document.getElementById('cfg-inv-min-soc').value),
          battery_max_soc: parseInt(document.getElementById('cfg-inv-max-soc').value)
        },
        sensors: {
          battery_soc: document.getElementById('cfg-sens-soc').value,
          battery_power: document.getElementById('cfg-sens-bat-power').value,
          grid_power: document.getElementById('cfg-sens-grid').value,
          load_power: document.getElementById('cfg-sens-load').value,
          pv_power: document.getElementById('cfg-sens-pv').value,
          pvpc_price: document.getElementById('cfg-sens-price').value,
          tariff_period: document.getElementById('cfg-sens-period').value
        },
        controls: {
          program_1_soc: document.getElementById('cfg-ctrl-prog1').value,
          grid_charge_start_soc: document.getElementById('cfg-ctrl-grid-start').value,
          work_mode: document.getElementById('cfg-ctrl-workmode').value
        },
        battery_optimization: {
          enabled: true,
          default_target_soc: parseInt(document.getElementById('cfg-opt-default-soc').value),
          keep_full_weekends: document.getElementById('cfg-opt-weekends').value === 'true',
          always_charge_below_price: parseFloat(document.getElementById('cfg-opt-low-price').value),
          never_charge_above_price: parseFloat(document.getElementById('cfg-opt-high-price').value),
          min_soc: parseInt(document.getElementById('cfg-inv-min-soc').value)
        },
        tariff_periods: {
          valle: { contracted_power_kw: parseFloat(document.getElementById('cfg-tariff-valle-power').value), target_soc: parseInt(document.getElementById('cfg-tariff-valle-soc').value), charge_battery: true },
          llano: { contracted_power_kw: parseFloat(document.getElementById('cfg-tariff-llano-power').value), target_soc: 50, charge_battery: false },
          punta: { contracted_power_kw: parseFloat(document.getElementById('cfg-tariff-punta-power').value), target_soc: 20, charge_battery: false }
        },
        alerts: {
          low_soc: parseInt(document.getElementById('cfg-alert-low-soc').value),
          high_price: parseFloat(document.getElementById('cfg-alert-high-price').value),
          overload_percent: parseInt(document.getElementById('cfg-alert-overload').value),
          solar_underperform: parseInt(document.getElementById('cfg-alert-solar').value)
        },
        ev_charging: {
          enabled: document.getElementById('cfg-ev-enabled').value === 'true',
          car_soc_sensor: document.getElementById('cfg-ev-soc-sensor').value,
          max_charge_power_kw: parseFloat(document.getElementById('cfg-ev-max-power').value),
          target_soc: parseInt(document.getElementById('cfg-ev-target-soc').value),
          smart_plan_time: document.getElementById('cfg-ev-ready-time').value,
          charge_in_valle: document.getElementById('cfg-ev-valle-only').value === 'true'
        },
        notifications: {
          enabled: document.getElementById('cfg-notify-enabled').value === 'true',
          webhook_url: document.getElementById('cfg-notify-url').value,
          on_low_soc: document.getElementById('cfg-notify-low-soc').value === 'true',
          on_cheap_hours: document.getElementById('cfg-notify-cheap').value === 'true'
        },
        loads: currentConfig.loads || [],
        load_manager: { enabled: true, safety_margin_percent: 10, check_interval_seconds: 30 }
      };
      
      await fetch(base + '/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) });
      alert('Configuration saved!');
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // ACTIONS
    // ─────────────────────────────────────────────────────────────────────────
    
    async function setTarget() {
      const val = parseInt(document.getElementById('manualTarget').value);
      if (val >= 10 && val <= 100) {
        await fetch(base + '/api/target', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({soc: val}) });
        document.getElementById('manualTarget').value = '';
        refresh();
      }
    }
    async function clearTarget() { await fetch(base + '/api/target', { method: 'DELETE' }); refresh(); }
    async function runBalance() { await fetch(base + '/api/balance', { method: 'POST' }); refresh(); }
    async function restoreAll() { await fetch(base + '/api/restore', { method: 'POST' }); refresh(); }
    
    async function applyPreset(presetId) {
      const resultEl = document.getElementById('quick-action-result');
      resultEl.innerHTML = '<span style="color:#d29922;">⏳ Applying preset...</span>';
      try {
        const res = await fetch(base + '/api/preset/' + presetId, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          resultEl.innerHTML = '<span class="ok">✅ ' + data.name + ' applied (target: ' + data.target + '%)</span>';
          refresh();
        } else {
          resultEl.innerHTML = '<span class="danger">❌ ' + data.error + '</span>';
        }
      } catch (e) {
        resultEl.innerHTML = '<span class="danger">❌ ' + e.message + '</span>';
      }
      setTimeout(() => resultEl.textContent = '', 5000);
    }
    
    async function quickAction(action) {
      const resultEl = document.getElementById('quick-action-result');
      resultEl.textContent = 'Executing...';
      try {
        const res = await fetch(base + '/api/quick-action', { 
          method: 'POST', 
          headers: {'Content-Type':'application/json'}, 
          body: JSON.stringify({ action }) 
        });
        const data = await res.json();
        if (data.success) {
          resultEl.innerHTML = '<span class="ok">✅ ' + data.message + '</span>';
          refresh();
        } else {
          resultEl.innerHTML = '<span class="danger">❌ ' + (data.error || 'Failed') + '</span>';
        }
      } catch (e) {
        resultEl.innerHTML = '<span class="danger">❌ Error: ' + e.message + '</span>';
      }
      setTimeout(() => resultEl.textContent = '', 5000);
    }
    
    let demoMode = false;
    
    function toggleDemoMode() {
      demoMode = !demoMode;
      document.getElementById('demo-toggle').textContent = demoMode ? '🔴 Exit Demo' : '🎭 Demo Mode';
      document.getElementById('demo-toggle').style.background = demoMode ? '#f85149' : '';
      refresh();
    }
    
    refresh();
    setInterval(refresh, 5000);
    checkDNDStatus();
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      switch(e.key) {
        case '1': showTab('overview'); break;
        case '2': showTab('forecast'); break;
        case '3': showTab('ev'); break;
        case '4': showTab('stats'); break;
        case '5': showTab('charts'); break;
        case '6': showTab('config'); break;
        case '7': showTab('debug'); break;
        case 'r': case 'R': refresh(); break;
        case 'a': case 'A': if (e.ctrlKey) { quickAction('auto'); e.preventDefault(); } break;
        case 'c': case 'C': if (e.ctrlKey) { quickAction('charge_100'); e.preventDefault(); } break;
      }
    });
  </script>
  
  <footer style="margin-top:32px;padding:24px;text-align:center;border-top:1px solid #30363d;color:#8b949e;font-size:12px;">
    <div style="margin-bottom:8px;">
      ⚡ <strong>VoltAssistant</strong> v1.4.0 · Smart Battery & Load Management
      <span style="margin-left:12px;cursor:help;" title="Shortcuts: 1-7 tabs, R refresh, Ctrl+A auto, Ctrl+C charge">⌨️</span>
    </div>
    <div>
      <a href="/health" style="color:#3fb950;text-decoration:none;margin:0 8px;">Health</a>
      <a href="/metrics" style="color:#3fb950;text-decoration:none;margin:0 8px;">Metrics</a>
      <a href="/api/report/daily" style="color:#3fb950;text-decoration:none;margin:0 8px;">Report</a>
      <a href="/api/ha-config" style="color:#3fb950;text-decoration:none;margin:0 8px;">HA Config</a>
      <a href="https://github.com/arturonaredo/ha-addons" style="color:#3fb950;text-decoration:none;margin:0 8px;" target="_blank">GitHub</a>
    </div>
  </footer>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/[^/]+/, '') || '/';
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.end(); return; }
  
  try {
    if (path === '/' || path === '/index.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    
    } else if (path === '/api/dnd' && req.method === 'GET') {
      res.end(JSON.stringify({
        enabled: dndUntil && new Date() < new Date(dndUntil),
        until: dndUntil
      }));
    
    } else if (path === '/api/dnd' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const { hours } = JSON.parse(body || '{}');
        if (hours === 0 || hours === null) {
          dndUntil = null;
          log('info', 'DND mode disabled');
          res.end(JSON.stringify({ success: true, enabled: false }));
        } else {
          dndUntil = new Date(Date.now() + (hours || 8) * 60 * 60 * 1000).toISOString();
          log('info', 'DND mode enabled until ' + dndUntil);
          res.end(JSON.stringify({ success: true, enabled: true, until: dndUntil }));
        }
      });
      return;
    
    } else if (path === '/api/notify/test' && req.method === 'POST') {
      const result = await sendTestNotification();
      res.end(JSON.stringify(result));
    
    } else if (path === '/api/demo') {
      // Generate demo data for testing UI without HA
      const hour = new Date().getHours();
      const demoState = {
        battery: { soc: 65 + Math.random() * 20, kwh: 21.2, capacity: 32.6, power: hour < 8 ? 2500 : -1500 },
        pv: { power: hour >= 8 && hour <= 18 ? 3000 + Math.random() * 2000 : 0 },
        grid: { power: hour >= 10 && hour <= 14 ? -1500 : 500 },
        load: { power: 1200 + Math.random() * 800 },
        currentPrice: 0.08 + Math.random() * 0.12,
        currentPeriod: hour >= 0 && hour < 8 || hour >= 22 ? 'valle' : hour >= 10 && hour < 14 || hour >= 18 && hour < 22 ? 'punta' : 'llano',
        effectiveTargetSoc: 80,
        manualTargetSoc: null,
        manualTargetExpiry: null,
        chargingDecision: hour < 8 ? 'charge' : 'hold',
        chargingReason: hour < 8 ? 'Valle period - cheap electricity' : 'Waiting for cheaper hours',
        contractedPower: 6900,
        usagePercent: 25,
        isOverloaded: false,
        shedLoads: [],
        loads: [
          { id: 'ev_charger', name: 'EV Charger', priority: 'comfort', current_power: 0 },
          { id: 'pool_pump', name: 'Pool Pump', priority: 'accessory', current_power: 750 },
          { id: 'ac_living', name: 'Living Room AC', priority: 'comfort', current_power: 1200 }
        ],
        haConnection: { status: 'demo', lastSuccess: new Date().toISOString() },
        alerts: { active: [], history: [] }
      };
      res.end(JSON.stringify(demoState));
    
    } else if (path === '/health' || path === '/api/health') {
      res.end(JSON.stringify({
        status: 'ok',
        version: '1.3.0',
        uptime: Math.floor(process.uptime()),
        haConnection: state.haConnection.status,
        lastCheck: state.lastCheck
      }));
    
    } else if (path === '/metrics') {
      res.setHeader('Content-Type', 'text/plain');
      const lines = [
        '# HELP voltassistant_up Service status (1 = up)',
        '# TYPE voltassistant_up gauge',
        'voltassistant_up 1',
        '',
        '# HELP voltassistant_battery_soc Battery state of charge',
        '# TYPE voltassistant_battery_soc gauge',
        'voltassistant_battery_soc ' + (state.battery.soc || 0),
        '',
        '# HELP voltassistant_solar_power Current solar generation',
        '# TYPE voltassistant_solar_power gauge',
        'voltassistant_solar_power ' + (state.pv.power || 0),
        '',
        '# HELP voltassistant_grid_power Grid power (+ import, - export)',
        '# TYPE voltassistant_grid_power gauge',
        'voltassistant_grid_power ' + (state.grid.power || 0),
        '',
        '# HELP voltassistant_load_power Current load power',
        '# TYPE voltassistant_load_power gauge',
        'voltassistant_load_power ' + (state.load.power || 0),
        '',
        '# HELP voltassistant_price Current electricity price',
        '# TYPE voltassistant_price gauge',
        'voltassistant_price ' + (state.currentPrice || 0),
        '',
        '# HELP voltassistant_uptime_seconds Process uptime',
        '# TYPE voltassistant_uptime_seconds gauge',
        'voltassistant_uptime_seconds ' + Math.floor(process.uptime()),
        '',
        '# HELP voltassistant_battery_power Battery power (+ charge, - discharge)',
        '# TYPE voltassistant_battery_power gauge',
        'voltassistant_battery_power ' + (state.battery.power || 0),
        '',
        '# HELP voltassistant_battery_kwh Battery energy stored',
        '# TYPE voltassistant_battery_kwh gauge',
        'voltassistant_battery_kwh ' + (state.battery.kwh || 0),
        '',
        '# HELP voltassistant_target_soc Target state of charge',
        '# TYPE voltassistant_target_soc gauge',
        'voltassistant_target_soc ' + (state.effectiveTargetSoc || 0),
        '',
        '# HELP voltassistant_contracted_power Contracted power for current period',
        '# TYPE voltassistant_contracted_power gauge',
        'voltassistant_contracted_power ' + (state.contractedPower || 0),
        '',
        '# HELP voltassistant_usage_percent Usage as percentage of contracted power',
        '# TYPE voltassistant_usage_percent gauge',
        'voltassistant_usage_percent ' + (state.usagePercent || 0),
        '',
        '# HELP voltassistant_overloaded Whether system is overloaded (0/1)',
        '# TYPE voltassistant_overloaded gauge',
        'voltassistant_overloaded ' + (state.isOverloaded ? 1 : 0),
        '',
        '# HELP voltassistant_loads_shed Number of loads currently shed',
        '# TYPE voltassistant_loads_shed gauge',
        'voltassistant_loads_shed ' + (state.shedLoads?.length || 0),
        '',
        '# HELP voltassistant_alerts_active Number of active alerts',
        '# TYPE voltassistant_alerts_active gauge',
        'voltassistant_alerts_active ' + (state.alerts?.active?.length || 0),
        '',
        '# HELP voltassistant_tariff_period Current tariff period (0=unknown,1=valle,2=llano,3=punta)',
        '# TYPE voltassistant_tariff_period gauge',
        'voltassistant_tariff_period ' + (state.currentPeriod === 'valle' ? 1 : state.currentPeriod === 'llano' ? 2 : state.currentPeriod === 'punta' ? 3 : 0),
        '',
        '# HELP voltassistant_car_soc EV car state of charge',
        '# TYPE voltassistant_car_soc gauge',
        'voltassistant_car_soc ' + (state.carSoc || 0),
      ];
      res.end(lines.join('\\n'));
    
    } else if (path === '/api/status') {
      await updateState();
      res.end(JSON.stringify(state));
    
    } else if (path === '/api/speak') {
      // Text summary for voice assistants
      await updateState();
      const soc = state.battery.soc?.toFixed(0) || 0;
      const solar = state.pv.power || 0;
      const price = state.currentPrice ? (state.currentPrice * 100).toFixed(0) : 0;
      const period = state.currentPeriod;
      
      let text = `Battery is at ${soc} percent. `;
      
      if (solar > 100) {
        text += `Generating ${solar} watts from solar. `;
      }
      
      text += `Current electricity price is ${price} cents per kilowatt hour. `;
      text += `We're in the ${period} tariff period. `;
      
      if (state.chargingDecision === 'charge') {
        text += `Battery is charging. `;
      }
      
      if (state.grid.power < -100) {
        text += `Exporting ${Math.abs(state.grid.power)} watts to the grid. `;
      }
      
      res.setHeader('Content-Type', 'text/plain');
      res.end(text);
    
    } else if (path === '/api/quick') {
      // Quick status for widgets and simple integrations
      res.end(JSON.stringify({
        soc: state.battery.soc,
        target: state.effectiveTargetSoc,
        solar: state.pv.power,
        load: state.load.power,
        grid: state.grid.power,
        price: state.currentPrice,
        period: state.currentPeriod,
        charging: state.chargingDecision === 'charge',
        ok: !state.isOverloaded && state.battery.soc > 15
      }));
    
    } else if (path.startsWith('/api/set/')) {
      // Simple URL-based control: /api/set/target/80, /api/set/action/charge_100
      const parts = path.split('/').filter(Boolean);
      const cmd = parts[2];
      const value = parts[3];
      
      if (cmd === 'target' && value) {
        const soc = parseInt(value);
        if (soc >= 10 && soc <= 100) {
          state.manualTargetSoc = soc;
          state.manualTargetExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
          saveState();
          await applyCharging();
          res.end(JSON.stringify({ success: true, target: soc }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'SOC must be 10-100' }));
        }
      } else if (cmd === 'action' && value) {
        // Redirect to quick-action handling
        const validActions = ['charge_100','charge_80','charge_50','stop_charge','discharge','hold','night_mode','force_export','auto'];
        if (validActions.includes(value)) {
          // Simulate quick action
          const fakeReq = { method: 'POST', on: (e, cb) => { if (e === 'end') cb(); } };
          const body = JSON.stringify({ action: value });
          // Handle action directly (simplified)
          state.manualTargetSoc = value === 'charge_100' ? 100 : value === 'charge_80' ? 80 : value === 'charge_50' ? 50 : value === 'auto' ? null : state.manualTargetSoc;
          if (value === 'auto') state.manualTargetExpiry = null;
          else state.manualTargetExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
          saveState();
          res.end(JSON.stringify({ success: true, action: value }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Unknown action' }));
        }
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Usage: /api/set/target/{10-100} or /api/set/action/{action}' }));
      }
    
    } else if (path === '/api/presets') {
      res.end(JSON.stringify({ success: true, presets: PRESETS }));
    
    } else if (path.startsWith('/api/preset/') && req.method === 'POST') {
      const presetId = path.split('/')[3];
      const preset = PRESETS[presetId];
      
      if (!preset) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'Unknown preset' }));
      } else {
        state.manualTargetSoc = preset.target;
        state.manualTargetExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        saveState();
        
        const c = ctrl();
        if (c.program_1_soc) await setNumber(c.program_1_soc, preset.target);
        
        log('success', 'Preset applied: ' + preset.name);
        res.end(JSON.stringify({ 
          success: true, 
          preset: presetId,
          name: preset.name,
          target: preset.target
        }));
      }
    
    } else if (path === '/api/schedule' && req.method === 'GET') {
      // List scheduled actions
      const now = Date.now();
      const active = scheduledActions.filter(s => s.executeAt > now);
      res.end(JSON.stringify({ success: true, scheduled: active }));
    
    } else if (path === '/api/schedule' && req.method === 'POST') {
      // Schedule an action for later
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { action, target_soc, at_hour, in_minutes } = JSON.parse(body || '{}');
          
          let delayMs;
          if (in_minutes) {
            delayMs = in_minutes * 60 * 1000;
          } else if (at_hour !== undefined) {
            const now = new Date();
            const target = new Date(now);
            target.setHours(at_hour, 0, 0, 0);
            if (target <= now) target.setDate(target.getDate() + 1);
            delayMs = target - now;
          } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: 'Provide at_hour or in_minutes' }));
            return;
          }
          
          const scheduledTime = new Date(Date.now() + delayMs);
          const scheduleId = 'sched_' + Date.now();
          
          // Track the scheduled action
          scheduledActions.push({
            id: scheduleId,
            action: action || 'target_' + target_soc,
            executeAt: scheduledTime.getTime(),
            scheduledFor: scheduledTime.toISOString()
          });
          
          setTimeout(async () => {
            if (action === 'charge_100') state.manualTargetSoc = 100;
            else if (action === 'charge_80') state.manualTargetSoc = 80;
            else if (action === 'auto') { state.manualTargetSoc = null; state.manualTargetExpiry = null; }
            else if (target_soc) state.manualTargetSoc = target_soc;
            
            if (state.manualTargetSoc !== null) {
              state.manualTargetExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
            }
            saveState();
            await applyCharging();
            log('success', 'Scheduled action executed: ' + (action || 'target ' + target_soc));
            
            // Remove from scheduled list
            const idx = scheduledActions.findIndex(s => s.id === scheduleId);
            if (idx >= 0) scheduledActions.splice(idx, 1);
          }, delayMs);
          
          res.end(JSON.stringify({
            success: true,
            id: scheduleId,
            message: 'Scheduled for ' + scheduledTime.toLocaleTimeString(),
            scheduledAt: scheduledTime.toISOString()
          }));
        } catch (e) {
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    } else if (path === '/api/config' && req.method === 'GET') {
      res.end(JSON.stringify(getConfig()));
    } else if (path === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        saveUserConfig(JSON.parse(body));
        config = getConfig();
        res.end(JSON.stringify({ success: true }));
      });
      return;
    } else if (path === '/api/config/reset' && req.method === 'POST') {
      // Reset to default config
      saveUserConfig({
        inverter: { max_power: 6000, battery_capacity_kwh: 10, battery_min_soc: 10, battery_max_soc: 100 },
        sensors: {},
        controls: {},
        battery_optimization: { enabled: true, default_target_soc: 80, keep_full_weekends: true, always_charge_below_price: 0.05, never_charge_above_price: 0.15, min_soc: 10 },
        tariff_periods: { valle: { contracted_power_kw: 6.9, target_soc: 100, charge_battery: true }, llano: { contracted_power_kw: 3.45, target_soc: 50 }, punta: { contracted_power_kw: 3.45, target_soc: 20 } },
        alerts: { low_soc: 15, high_price: 0.2, overload_percent: 90, solar_underperform: 50 },
        ev_charging: { enabled: false },
        loads: []
      });
      config = getConfig();
      res.end(JSON.stringify({ success: true }));
    } else if (path === '/api/target' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const data = JSON.parse(body || '{}');
        if (data.soc >= 10 && data.soc <= 100) {
          state.manualTargetSoc = data.soc;
          saveState();
          await applyCharging();
          res.end(JSON.stringify({ success: true }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid SOC' }));
        }
      });
      return;
    } else if (path === '/api/target' && req.method === 'DELETE') {
      state.manualTargetSoc = null;
      saveState();
      await applyCharging();
      res.end(JSON.stringify({ success: true }));
    } else if (path === '/api/balance' && req.method === 'POST') {
      res.end(JSON.stringify(await balanceLoads()));
    } else if (path === '/api/restore' && req.method === 'POST') {
      for (const id of [...state.shedLoads]) {
        const load = state.loads.find(l => l.id === id);
        if (load?.switch_entity) await turnOn(load.switch_entity);
      }
      state.shedLoads = [];
      saveState();
      res.end(JSON.stringify({ success: true }));
    } else if (path === '/api/debug') {
      res.end(JSON.stringify({
        system: {
          version: '1.4.0',
          uptime: Math.floor(process.uptime()),
          memory: process.memoryUsage().heapUsed,
          historyPoints: history.soc?.length || 0,
          nodeVersion: process.version,
          platform: process.platform
        },
        haConnection: state.haConnection,
        haUrl: HA_URL,
        supervisorToken: !!SUPERVISOR_TOKEN,
        config: getConfig()
      }));
    } else if (path === '/api/logs') {
      if (req.method === 'DELETE') {
        debugLogs = [];
        res.end(JSON.stringify({ success: true }));
      } else {
        res.end(JSON.stringify(debugLogs));
      }
    } else if (path === '/api/history') {
      res.end(JSON.stringify(history));
    } else if (path === '/api/test-entities') {
      const cfg = getConfig();
      const tests = [];
      const sensorsToTest = [
        { name: 'Battery SOC', entity_id: cfg.sensors?.battery_soc },
        { name: 'Battery Power', entity_id: cfg.sensors?.battery_power },
        { name: 'Grid Power', entity_id: cfg.sensors?.grid_power },
        { name: 'Load Power', entity_id: cfg.sensors?.load_power },
        { name: 'Solar Power', entity_id: cfg.sensors?.pv_power },
        { name: 'PVPC Price', entity_id: cfg.sensors?.pvpc_price },
        { name: 'Tariff Period', entity_id: cfg.sensors?.tariff_period },
        { name: 'Program 1 SOC', entity_id: cfg.controls?.program_1_soc },
        { name: 'Grid Charge Start', entity_id: cfg.controls?.grid_charge_start_soc }
      ];
      
      for (const s of sensorsToTest) {
        if (s.entity_id) {
          const result = await testEntity(s.entity_id);
          tests.push({ name: s.name, entity_id: s.entity_id, ...result });
        }
      }
      
      res.end(JSON.stringify(tests));
    
    // ═══════════════════════════════════════════════════════════════════════
    // FORECAST ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/forecast/solar') {
      try {
        const cfg = getConfig();
        const peakPower = (cfg.inverter?.max_power || 6000) / 1000;
        const solar = await getSolarForecast(43.5322, -5.6611, peakPower);
        res.end(JSON.stringify({ success: true, ...solar }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    } else if (path === '/api/forecast/prices') {
      try {
        const prices = await getPVPCPrices();
        res.end(JSON.stringify({ success: true, ...prices }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    } else if (path === '/api/forecast/plan') {
      try {
        const [prices, solar] = await Promise.all([getPVPCPrices(), getSolarForecast()]);
        const cfg = getConfig();
        const plan = generateChargingPlan(prices, solar, {
          capacityKwh: cfg.inverter?.battery_capacity_kwh || 32.6,
          currentSoc: state.battery.soc,
          targetSoc: state.effectiveTargetSoc,
          chargeRateKw: (cfg.inverter?.max_power || 6000) / 1000
        });
        res.end(JSON.stringify({ success: true, plan }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    } else if (path === '/api/forecast/savings') {
      try {
        const prices = await getPVPCPrices();
        const savings = calculateMonthlySavings(history, prices);
        res.end(JSON.stringify({ success: true, ...savings }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    } else if (path === '/api/forecast/all') {
      try {
        const [prices, solar] = await Promise.all([getPVPCPrices(), getSolarForecast()]);
        const cfg = getConfig();
        const plan = generateChargingPlan(prices, solar, {
          capacityKwh: cfg.inverter?.battery_capacity_kwh || 32.6,
          currentSoc: state.battery.soc,
          targetSoc: state.effectiveTargetSoc,
          chargeRateKw: (cfg.inverter?.max_power || 6000) / 1000
        });
        const savings = calculateMonthlySavings(history, prices);
        res.end(JSON.stringify({
          success: true,
          solar,
          prices,
          plan,
          savings,
          currentState: {
            soc: state.battery.soc,
            targetSoc: state.effectiveTargetSoc,
            price: state.currentPrice,
            period: state.currentPeriod
          }
        }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    // ═══════════════════════════════════════════════════════════════════════
    // QUICK ACTIONS
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/quick-action' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { action } = JSON.parse(body || '{}');
          const c = ctrl();
          let message = '';
          
          switch (action) {
            case 'charge_100':
              state.manualTargetSoc = 100;
              state.manualTargetExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6h
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 100);
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 100);
              message = 'Charging to 100% (6h override)';
              log('success', message);
              break;
              
            case 'charge_80':
              state.manualTargetSoc = 80;
              state.manualTargetExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4h
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 80);
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 80);
              message = 'Charging to 80% (4h override)';
              log('success', message);
              break;
              
            case 'stop_charge':
              state.manualTargetSoc = state.battery.soc;
              state.manualTargetExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h
              saveState();
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
              message = 'Grid charging stopped (2h)';
              log('success', message);
              break;
              
            case 'discharge':
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
              message = 'Discharge mode enabled';
              log('success', message);
              break;
              
            case 'auto':
              state.manualTargetSoc = null;
              state.manualTargetExpiry = null;
              saveState();
              await applyCharging();
              message = 'Auto mode enabled';
              log('success', message);
              break;
            
            case 'charge_50':
              state.manualTargetSoc = 50;
              state.manualTargetExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 50);
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 50);
              message = 'Charging to 50% (2h override)';
              log('success', message);
              break;
            
            case 'night_mode':
              // Keep battery at 80% minimum for overnight use
              state.manualTargetSoc = 80;
              state.manualTargetExpiry = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(); // Until morning
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 80);
              message = 'Night mode: maintaining 80% SOC for 10h';
              log('success', message);
              break;
            
            case 'force_export':
              // Discharge to grid during high price
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
              if (c.program_1_soc) await setNumber(c.program_1_soc, batOpt().min_soc || 10);
              message = 'Force export mode - discharging to minimum';
              log('success', message);
              break;
            
            case 'hold':
              // Hold current SOC
              state.manualTargetSoc = state.battery.soc;
              state.manualTargetExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
              saveState();
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
              message = 'Hold mode - maintaining ' + state.battery.soc + '% for 4h';
              log('success', message);
              break;
            
            case 'grid_charge_on':
              // Enable grid charging immediately
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 100);
              message = 'Grid charging enabled';
              log('success', message);
              break;
            
            case 'grid_charge_off':
              // Disable grid charging
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 0);
              message = 'Grid charging disabled';
              log('success', message);
              break;
            
            case 'balance_loads':
              // Trigger load balancing
              const result = await balanceLoads();
              message = 'Load balancing executed: ' + (result.actions.length || 0) + ' actions';
              log('success', message);
              break;
            
            case 'restore_loads':
              // Restore all shed loads
              for (const id of [...state.shedLoads]) {
                const load = state.loads.find(l => l.id === id);
                if (load?.switch_entity) await turnOn(load.switch_entity);
              }
              state.shedLoads = [];
              saveState();
              message = 'All loads restored';
              log('success', message);
              break;
            
            case 'vacation':
              // Vacation mode: maintain 30% SOC, 7 days
              state.manualTargetSoc = 30;
              state.manualTargetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 30);
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 30);
              message = 'Vacation mode: 30% SOC for 7 days';
              log('success', message);
              break;
            
            case 'storm':
              // Storm mode: charge to 100% and hold
              state.manualTargetSoc = 100;
              state.manualTargetExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
              saveState();
              if (c.program_1_soc) await setNumber(c.program_1_soc, 100);
              if (c.grid_charge_start_soc) await setNumber(c.grid_charge_start_soc, 100);
              message = 'Storm mode: charging to 100% (48h hold)';
              log('success', message);
              break;
              
            default:
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, error: 'Unknown action: ' + action }));
              return;
          }
          
          res.end(JSON.stringify({ success: true, message, action }));
        } catch (e) {
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    
    // ═══════════════════════════════════════════════════════════════════════
    // WEBHOOK ENDPOINTS (for HA automations)
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/ha-config') {
      // Generate HA configuration YAML for automations
      const baseUrl = req.headers.host ? 'http://' + req.headers.host : 'http://localhost:8099';
      const yaml = `# VoltAssistant - Home Assistant Configuration
# Add these to your configuration.yaml

# REST Commands for Quick Actions
rest_command:
  voltassistant_charge_100:
    url: "${baseUrl}/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "charge_100"}'
  
  voltassistant_charge_80:
    url: "${baseUrl}/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "charge_80"}'
  
  voltassistant_auto:
    url: "${baseUrl}/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "auto"}'
  
  voltassistant_night_mode:
    url: "${baseUrl}/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "night_mode"}'

# Status Sensor
sensor:
  - platform: rest
    name: VoltAssistant Status
    resource: "${baseUrl}/api/webhook/ha"
    scan_interval: 60
    json_attributes:
      - battery_soc
      - target_soc
      - current_price
      - is_cheap_hour
      - recommended_action
    value_template: "{{ value_json.recommended_action }}"

# Example Automation: Charge at Cheap Hours
automation:
  - alias: "VoltAssistant Cheap Hour Charging"
    trigger:
      - platform: state
        entity_id: sensor.voltassistant_status
        attribute: is_cheap_hour
        to: true
    condition:
      - condition: numeric_state
        entity_id: sensor.voltassistant_status
        attribute: battery_soc
        below: 80
    action:
      - service: rest_command.voltassistant_charge_100
`;
      res.setHeader('Content-Type', 'text/plain');
      res.end(yaml);
    
    } else if (path === '/api/webhook/notify') {
      // Generate notification text for HA
      try {
        const [prices, solar] = await Promise.all([getPVPCPrices(), getSolarForecast()]);
        const hour = new Date().getHours();
        const currentPrice = prices.today?.prices?.find(p => p.hour === hour);
        
        const lines = [
          '⚡ VoltAssistant Update',
          '',
          '🔋 Battery: ' + state.battery.soc + '%',
          '☀️ Solar: ' + state.pv.power + 'W',
          '💶 Price: ' + (currentPrice?.price * 100 || 0).toFixed(1) + '¢/kWh',
          '',
          '📊 Forecast:',
          '  Solar today: ' + (solar.today?.totalKwh || 0) + ' kWh',
          '  Cheap hours: ' + (prices.today?.stats?.cheapest?.slice(0, 3).map(h => h + ':00').join(', ') || 'N/A'),
        ];
        
        res.end(JSON.stringify({
          success: true,
          title: '⚡ VoltAssistant',
          message: lines.join('\\n'),
          data: {
            soc: state.battery.soc,
            price: currentPrice?.price,
            solarForecast: solar.today?.totalKwh,
            cheapestHours: prices.today?.stats?.cheapest
          }
        }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    } else if (path === '/api/ev/status') {
      // EV charging status
      const ev = config.ev_charging || {};
      const currentHour = new Date().getHours();
      const isValle = state.currentPeriod === 'valle';
      const shouldCharge = ev.enabled && (isValle || !ev.charge_in_valle);
      
      res.end(JSON.stringify({
        success: true,
        enabled: ev.enabled || false,
        carSoc: state.carSoc,
        targetSoc: ev.target_soc || 80,
        maxPower: ev.max_charge_power_kw || 7.4,
        chargingSlot: state.carChargingSlot,
        currentPeriod: state.currentPeriod,
        shouldCharge,
        readyByTime: ev.smart_plan_time || '07:30',
        recommendation: shouldCharge ? 'Charge now - ' + (isValle ? 'Valle period' : 'Charging allowed') : 'Wait for Valle period'
      }));
    
    } else if (path === '/api/ev/plan') {
      // EV charging plan
      const ev = config.ev_charging || {};
      if (!ev.enabled) {
        res.end(JSON.stringify({ success: false, error: 'EV charging not enabled' }));
        return;
      }
      
      const carSoc = state.carSoc || 0;
      const targetSoc = ev.target_soc || 80;
      const batteryKwh = 60; // Assume 60kWh EV battery
      const chargerKw = ev.max_charge_power_kw || 7.4;
      
      const neededKwh = (targetSoc - carSoc) / 100 * batteryKwh;
      const hoursNeeded = Math.ceil(neededKwh / chargerKw);
      
      // Find cheapest hours for charging
      const prices = await getPVPCPrices();
      const now = new Date();
      const currentHour = now.getHours();
      
      // Get remaining hours until ready time
      const [readyHour] = (ev.smart_plan_time || '07:30').split(':').map(Number);
      let hoursUntilReady = readyHour - currentHour;
      if (hoursUntilReady <= 0) hoursUntilReady += 24;
      
      // Get available prices for remaining hours
      const availablePrices = (prices.today?.prices || [])
        .filter(p => p.hour >= currentHour)
        .concat((prices.tomorrow?.prices || []).map(p => ({ ...p, hour: p.hour + 24 })))
        .filter(p => p.hour < currentHour + hoursUntilReady)
        .sort((a, b) => a.price - b.price);
      
      const chargeHours = availablePrices.slice(0, hoursNeeded);
      const estimatedCost = chargeHours.reduce((sum, h) => sum + h.price * chargerKw, 0);
      
      res.end(JSON.stringify({
        success: true,
        carSoc,
        targetSoc,
        neededKwh: Math.round(neededKwh * 10) / 10,
        hoursNeeded,
        readyByTime: ev.smart_plan_time,
        chargeHours: chargeHours.map(h => ({ hour: h.hour % 24, price: h.price })),
        estimatedCost: Math.round(estimatedCost * 100) / 100,
        recommendation: hoursNeeded <= 0 ? 'Already at target' : 
          chargeHours.some(h => h.hour % 24 === currentHour) ? 'Start charging now' : 
          'Wait until ' + (chargeHours[0]?.hour % 24) + ':00'
      }));
    
    } else if (path === '/api/webhook/ha') {
      // Webhook for HA automations - returns current recommendation
      try {
        const [prices, solar] = await Promise.all([getPVPCPrices(), getSolarForecast()]);
        const cfg = getConfig();
        const plan = generateChargingPlan(prices, solar, {
          capacityKwh: cfg.inverter?.battery_capacity_kwh || 32.6,
          currentSoc: state.battery.soc,
          targetSoc: state.effectiveTargetSoc,
          chargeRateKw: (cfg.inverter?.max_power || 6000) / 1000
        });
        
        const hour = new Date().getHours();
        const currentPrice = prices.today?.prices?.find(p => p.hour === hour);
        const isCheap = prices.today?.stats?.cheapest?.includes(hour);
        const isExpensive = prices.today?.stats?.expensive?.includes(hour);
        
        res.end(JSON.stringify({
          battery_soc: state.battery.soc,
          target_soc: state.effectiveTargetSoc,
          current_price: currentPrice?.price || 0,
          is_cheap_hour: isCheap,
          is_expensive_hour: isExpensive,
          solar_power: state.pv.power,
          grid_power: state.grid.power,
          load_power: state.load.power,
          recommended_action: plan.action,
          charge_hours: plan.chargeHours,
          next_charge_hour: plan.nextChargeHour,
          solar_forecast_today: solar.today?.totalKwh || 0,
          overloaded: state.isOverloaded,
          period: state.currentPeriod
        }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STATISTICS ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/stats/daily') {
      // Daily statistics from history
      const today = new Date().toISOString().split('T')[0];
      const todayStart = new Date(today + 'T00:00:00').getTime();
      
      const todayData = {
        soc: history.soc.filter(p => p.ts >= todayStart),
        price: history.price.filter(p => p.ts >= todayStart),
        pv: history.pv.filter(p => p.ts >= todayStart),
        load: history.load.filter(p => p.ts >= todayStart),
        grid: history.grid.filter(p => p.ts >= todayStart)
      };
      
      const calcStats = (arr) => {
        if (!arr.length) return { min: 0, max: 0, avg: 0, total: 0 };
        const values = arr.map(p => p.v || 0);
        return {
          min: Math.min(...values),
          max: Math.max(...values),
          avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100,
          total: Math.round(values.reduce((a, b) => a + b, 0) / 12) // Rough kWh (5min intervals)
        };
      };
      
      res.end(JSON.stringify({
        success: true,
        date: today,
        dataPoints: todayData.soc.length,
        soc: { min: calcStats(todayData.soc).min, max: calcStats(todayData.soc).max, current: state.battery.soc },
        solar: { ...calcStats(todayData.pv), unit: 'Wh' },
        load: { ...calcStats(todayData.load), unit: 'Wh' },
        grid: {
          import: Math.round(todayData.grid.filter(p => p.v > 0).reduce((s, p) => s + p.v, 0) / 12),
          export: Math.round(Math.abs(todayData.grid.filter(p => p.v < 0).reduce((s, p) => s + p.v, 0)) / 12)
        },
        price: { ...calcStats(todayData.price), unit: '€/kWh' }
      }));
    
    } else if (path === '/api/stats/summary') {
      // Summary with key metrics
      const prices = await getPVPCPrices();
      const solar = await getSolarForecast();
      const hour = new Date().getHours();
      
      res.end(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        battery: {
          soc: state.battery.soc,
          kwh: state.battery.kwh,
          capacity: state.battery.capacity,
          target: state.effectiveTargetSoc,
          isManual: state.manualTargetSoc !== null
        },
        power: {
          solar: state.pv.power,
          load: state.load.power,
          grid: state.grid.power,
          battery: state.battery.power
        },
        tariff: {
          period: state.currentPeriod,
          price: state.currentPrice,
          contractedPower: state.contractedPower
        },
        forecast: {
          solarTodayKwh: solar.today?.totalKwh || 0,
          solarTomorrowKwh: solar.tomorrow?.totalKwh || 0,
          cheapestHours: prices.today?.stats?.cheapest || [],
          expensiveHours: prices.today?.stats?.expensive || [],
          tomorrowAvailable: prices.tomorrow?.available || false
        },
        loads: {
          total: state.loads.length,
          shedCount: state.shedLoads.length,
          isOverloaded: state.isOverloaded,
          usagePercent: state.usagePercent
        },
        ev: {
          enabled: config.ev_charging?.enabled || false,
          soc: state.carSoc,
          chargingSlot: state.carChargingSlot
        }
      }));
    
    // ═══════════════════════════════════════════════════════════════════════
    // REPORTS
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/report/daily') {
      try {
        const [prices, solar] = await Promise.all([getPVPCPrices(), getSolarForecast()]);
        const hour = new Date().getHours();
        const currentPrice = prices.today?.prices?.find(p => p.hour === hour);
        
        const lines = [
          '☀️ VoltAssistant - Daily Report',
          '━'.repeat(30),
          '',
          '🔋 Battery: ' + state.battery.soc + '% (' + state.battery.kwh.toFixed(1) + ' kWh)',
          '🎯 Target: ' + state.effectiveTargetSoc + '%',
          '',
          '⚡ Power Flow:',
          '   Solar: ' + state.pv.power + ' W',
          '   Load: ' + state.load.power + ' W',
          '   Grid: ' + (state.grid.power > 0 ? '+' : '') + state.grid.power + ' W',
          '',
          '💶 Electricity:',
          '   Current: ' + (currentPrice?.price * 100 || 0).toFixed(2) + ' ¢/kWh',
          '   Period: ' + state.currentPeriod?.toUpperCase(),
          '   Avg today: ' + (prices.today?.stats?.avg * 100 || 0).toFixed(2) + ' ¢/kWh',
          '',
          '📊 Forecast:',
          '   Solar today: ' + (solar.today?.totalKwh || 0) + ' kWh',
          '   Solar tomorrow: ' + (solar.tomorrow?.totalKwh || 0) + ' kWh',
          '',
          '⏰ Cheap hours: ' + (prices.today?.stats?.cheapest?.slice(0, 4).map(h => h + ':00').join(', ') || 'N/A'),
          ''
        ];
        
        // Add alerts if any
        if (state.alerts?.active?.length > 0) {
          lines.push('⚠️ Active Alerts:');
          for (const a of state.alerts.active) {
            lines.push('   • ' + a.message);
          }
          lines.push('');
        }
        
        res.end(JSON.stringify({
          success: true,
          text: lines.join('\\n'),
          data: {
            battery: state.battery,
            power: { solar: state.pv.power, load: state.load.power, grid: state.grid.power },
            price: currentPrice?.price,
            forecast: { solarToday: solar.today?.totalKwh, solarTomorrow: solar.tomorrow?.totalKwh },
            alerts: state.alerts?.active?.length || 0
          }
        }));
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    
    // ═══════════════════════════════════════════════════════════════════════
    // ALERTS ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════
    
    } else if (path === '/api/alerts') {
      res.end(JSON.stringify({
        success: true,
        active: state.alerts.active,
        count: state.alerts.active.length
      }));
    
    } else if (path === '/api/alerts/history') {
      if (req.method === 'DELETE') {
        state.alerts.history = [];
        saveState();
        res.end(JSON.stringify({ success: true }));
      } else {
        res.end(JSON.stringify(state.alerts.history));
      }
    
    } else if (path === '/api/alerts/clear' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id, type } = JSON.parse(body || '{}');
          if (id) {
            state.alerts.active = state.alerts.active.filter(a => a.id !== id);
          } else if (type) {
            state.alerts.active = state.alerts.active.filter(a => a.type !== type);
          } else {
            state.alerts.active = [];
          }
          res.end(JSON.stringify({ success: true, remaining: state.alerts.active.length }));
        } catch (e) {
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Auto tasks
setInterval(() => balanceLoads(), 30000);
setInterval(() => {
  applyCharging();
  addHistoryPoint();
}, 300000); // 5 min
setTimeout(() => { 
  applyCharging(); 
  addHistoryPoint();
}, 5000);

server.listen(8099, () => {
  log('success', 'VoltAssistant started on :8099');
  console.log('⚡ VoltAssistant on :8099');
});
