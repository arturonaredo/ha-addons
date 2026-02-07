/**
 * Volt Load Manager - Home Assistant Addon
 * Battery optimization + load management for Deye inverters
 * With tariff periods (punta/llano/valle) support
 */

const http = require('http');
const fs = require('fs');
const axios = require('axios');

// HA Supervisor API
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_URL = 'http://supervisor/core/api';

// Read addon options
let options = {};
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  console.log('📋 Config loaded');
} catch (e) {
  console.log('⚠️ No options.json, using defaults');
}

// Shortcuts
const inv = options.inverter || {};
const sens = options.sensors || {};
const ctrl = options.controls || {};
const tariff = options.tariff_periods || {};
const ev = options.ev_charging || {};
const lm = options.load_manager || {};

// State
let state = {
  // Inverter
  battery: { soc: 0, power: 0, kwh: 0, capacity: inv.battery_capacity_kwh || 32.6 },
  grid: { power: 0 },
  load: { power: 0 },
  pv: { power: 0 },
  
  // Tariff
  currentPrice: null,
  currentPeriod: 'unknown', // valle, llano, punta
  contractedPower: 6900, // Current period's contracted power in W
  
  // EV
  carSoc: null,
  carChargingSlot: false,
  
  // Load manager
  totalManagedPower: 0,
  maxAvailable: 6000,
  usagePercent: 0,
  isOverloaded: false,
  shedLoads: [],
  loads: (options.loads || []).map(l => ({ ...l, current_power: 0, is_on: true })),
  
  // Meta
  lastAction: null,
  lastCheck: null
};

// ─────────────────────────────────────────────────────────────────────────────
// HA API
// ─────────────────────────────────────────────────────────────────────────────

async function getState(entityId) {
  if (!entityId) return null;
  try {
    const res = await axios.get(`${HA_URL}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      timeout: 5000
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

async function getNumericState(entityId) {
  const entity = await getState(entityId);
  return parseFloat(entity?.state) || 0;
}

async function callService(domain, service, data) {
  try {
    await axios.post(`${HA_URL}/services/${domain}/${service}`, data, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      timeout: 5000
    });
    return true;
  } catch (e) {
    console.error(`Error ${domain}.${service}:`, e.message);
    return false;
  }
}

const turnOff = (id) => callService(id.split('.')[0], 'turn_off', { entity_id: id });
const turnOn = (id) => callService(id.split('.')[0], 'turn_on', { entity_id: id });
const setNumber = (id, val) => callService('number', 'set_value', { entity_id: id, value: val });
const setTime = (id, val) => callService('time', 'set_value', { entity_id: id, time: val });
const setSelect = (id, opt) => callService('select', 'select_option', { entity_id: id, option: opt });

// ─────────────────────────────────────────────────────────────────────────────
// Tariff Period Detection
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentPeriodFromTime() {
  const now = new Date();
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  
  // Weekends = all valle for 2.0TD
  if (isWeekend) return 'valle';
  
  // Weekday schedule for 2.0TD
  if (hour >= 0 && hour < 8) return 'valle';
  if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'punta';
  return 'llano';
}

function getPeriodConfig(period) {
  const defaults = {
    valle: { contracted_power_kw: 6.9, charge_battery: true, target_soc: 100 },
    llano: { contracted_power_kw: 3.45, charge_battery: false, target_soc: 50 },
    punta: { contracted_power_kw: 3.45, charge_battery: false, target_soc: 20 }
  };
  return tariff[period] || defaults[period] || defaults.llano;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Updates
// ─────────────────────────────────────────────────────────────────────────────

async function updateState() {
  // Inverter state
  const [soc, batPower, gridPower, loadPower, pvPower, batCap] = await Promise.all([
    getNumericState(sens.battery_soc),
    getNumericState(sens.battery_power),
    getNumericState(sens.grid_power),
    getNumericState(sens.load_power),
    getNumericState(sens.pv_power),
    sens.battery_capacity ? getNumericState(sens.battery_capacity) : null
  ]);
  
  state.battery.soc = soc;
  state.battery.power = batPower;
  state.battery.capacity = batCap || inv.battery_capacity_kwh || 32.6;
  state.battery.kwh = (soc / 100) * state.battery.capacity;
  state.grid.power = gridPower;
  state.load.power = loadPower;
  state.pv.power = pvPower;
  
  // Price
  if (sens.pvpc_price) {
    state.currentPrice = await getNumericState(sens.pvpc_price);
  }
  
  // Period - from sensor or calculate
  if (sens.tariff_period) {
    const periodEntity = await getState(sens.tariff_period);
    state.currentPeriod = periodEntity?.state?.toLowerCase() || getCurrentPeriodFromTime();
  } else {
    state.currentPeriod = getCurrentPeriodFromTime();
  }
  
  // Update contracted power based on period
  const periodConfig = getPeriodConfig(state.currentPeriod);
  state.contractedPower = (periodConfig.contracted_power_kw || 6.9) * 1000;
  
  // EV
  if (ev.enabled) {
    if (ev.car_soc_sensor) state.carSoc = await getNumericState(ev.car_soc_sensor);
    if (ev.car_charging_slot) {
      const slot = await getState(ev.car_charging_slot);
      state.carChargingSlot = slot?.state === 'on';
    }
  }
  
  // Loads
  for (const load of state.loads) {
    if (load.power_sensor) {
      const p = await getNumericState(load.power_sensor);
      // Handle kW vs W
      load.current_power = p < 100 ? p * 1000 : p;
    }
    if (load.switch_entity) {
      const sw = await getState(load.switch_entity);
      load.is_on = sw?.state === 'on';
    }
  }
  
  // Calculate managed power and limits
  state.totalManagedPower = state.loads.reduce((sum, l) => sum + (l.is_on ? l.current_power : 0), 0);
  const margin = (lm.safety_margin_percent || 10) / 100;
  state.maxAvailable = state.contractedPower * (1 - margin);
  state.usagePercent = (state.load.power / state.contractedPower) * 100;
  state.isOverloaded = state.load.power > state.maxAvailable;
  
  state.lastCheck = new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Balancing
// ─────────────────────────────────────────────────────────────────────────────

async function balanceLoads() {
  if (!lm.enabled) {
    return { actions: [], message: 'Load manager disabled' };
  }
  
  await updateState();
  const actions = [];
  
  if (state.isOverloaded) {
    const excess = state.load.power - state.maxAvailable;
    let saved = 0;
    
    for (const priority of ['accessory', 'comfort']) {
      if (saved >= excess) break;
      
      const toShed = state.loads
        .filter(l => l.priority === priority && l.switch_entity && l.is_on && !state.shedLoads.includes(l.id))
        .sort((a, b) => b.current_power - a.current_power);
      
      for (const load of toShed) {
        if (saved >= excess) break;
        if (await turnOff(load.switch_entity)) {
          saved += load.current_power;
          state.shedLoads.push(load.id);
          actions.push(`⬇️ ${load.name} apagado (${(load.current_power/1000).toFixed(1)}kW)`);
        }
      }
    }
    
    if (actions.length) {
      state.lastAction = { time: new Date().toISOString(), type: 'shed', actions };
    }
  } else if (state.shedLoads.length > 0) {
    const headroom = state.maxAvailable - state.load.power;
    
    for (const priority of ['comfort', 'accessory']) {
      const toRestore = state.loads
        .filter(l => l.priority === priority && state.shedLoads.includes(l.id))
        .sort((a, b) => (a.max_power || 1000) - (b.max_power || 1000));
      
      for (const load of toRestore) {
        if ((load.max_power || 1000) <= headroom * 0.8) {
          if (await turnOn(load.switch_entity)) {
            state.shedLoads = state.shedLoads.filter(id => id !== load.id);
            actions.push(`⬆️ ${load.name} restaurado`);
          }
        }
      }
    }
    
    if (actions.length) {
      state.lastAction = { time: new Date().toISOString(), type: 'restore', actions };
    }
  }
  
  return { actions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Battery Charging Control
// ─────────────────────────────────────────────────────────────────────────────

async function applyPeriodSettings() {
  const periodConfig = getPeriodConfig(state.currentPeriod);
  const actions = [];
  
  if (periodConfig.charge_battery && ctrl.grid_charge_start_soc) {
    // Enable grid charging in valle
    await setNumber(ctrl.grid_charge_start_soc, inv.battery_min_soc || 10);
    if (ctrl.program_1_soc) await setNumber(ctrl.program_1_soc, periodConfig.target_soc);
    actions.push(`🔋 Carga de red activada → SOC ${periodConfig.target_soc}%`);
  } else if (ctrl.grid_charge_start_soc) {
    // Disable grid charging
    await setNumber(ctrl.grid_charge_start_soc, 0);
    actions.push('☀️ Solo carga solar');
  }
  
  return actions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Web UI
// ─────────────────────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html>
<head>
  <title>Volt Load Manager</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f1a; color: #eee; padding: 16px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 20px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .card { background: linear-gradient(145deg, #1a1a2e, #16213e); border-radius: 12px; padding: 14px; }
    .card.wide { grid-column: 1 / -1; }
    .card h2 { font-size: 11px; color: #666; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px; }
    .big { font-size: 28px; font-weight: 700; line-height: 1.1; }
    .unit { font-size: 12px; color: #666; font-weight: 400; }
    .sub { font-size: 12px; color: #666; margin-top: 4px; }
    .valle { color: #00d26a; }
    .llano { color: #ffc107; }
    .punta { color: #ff4757; }
    .ok { color: #00d26a; }
    .warn { color: #ffc107; }
    .danger { color: #ff4757; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1f3460; font-size: 14px; }
    .row:last-child { border: none; }
    .load { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #1f3460; }
    .load:last-child { border: none; }
    .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
    .badge.essential { background: #ff4757; }
    .badge.comfort { background: #ffc107; color: #000; }
    .badge.accessory { background: #5f27cd; }
    .shed { opacity: 0.4; }
    .btn { background: #0984e3; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; }
    .btn:hover { background: #0770c2; }
    .btn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .period-bar { display: flex; gap: 4px; margin: 8px 0; }
    .period-bar span { flex: 1; text-align: center; padding: 6px; border-radius: 6px; font-size: 11px; font-weight: 600; opacity: 0.3; }
    .period-bar span.active { opacity: 1; }
    .period-bar .valle { background: #00d26a22; border: 1px solid #00d26a; }
    .period-bar .llano { background: #ffc10722; border: 1px solid #ffc107; }
    .period-bar .punta { background: #ff475722; border: 1px solid #ff4757; }
    .progress { height: 6px; background: #1f3460; border-radius: 3px; margin-top: 8px; overflow: hidden; }
    .progress-bar { height: 100%; border-radius: 3px; transition: width 0.3s; }
  </style>
</head>
<body>
  <h1>⚡ Volt Load Manager</h1>
  
  <div class="card wide" style="margin-bottom:16px">
    <h2>Periodo Tarifario</h2>
    <div class="period-bar">
      <span class="valle" id="p-valle">Valle</span>
      <span class="llano" id="p-llano">Llano</span>
      <span class="punta" id="p-punta">Punta</span>
    </div>
    <div class="row">
      <span>Potencia contratada</span>
      <span id="contracted">-- kW</span>
    </div>
    <div class="row">
      <span>Consumo actual</span>
      <span id="usage">-- kW (<span id="usagePct">--%</span>)</span>
    </div>
    <div class="progress"><div class="progress-bar" id="usageBar" style="width:0%"></div></div>
  </div>
  
  <div class="grid">
    <div class="card">
      <h2>🔋 Batería</h2>
      <div class="big" id="soc">--<span class="unit">%</span></div>
      <div class="sub" id="batKwh">-- kWh</div>
    </div>
    <div class="card">
      <h2>☀️ Solar</h2>
      <div class="big" id="pv">--<span class="unit">W</span></div>
    </div>
    <div class="card">
      <h2>🏠 Consumo</h2>
      <div class="big" id="load">--<span class="unit">W</span></div>
    </div>
    <div class="card">
      <h2>⚡ Red</h2>
      <div class="big" id="grid">--<span class="unit">W</span></div>
      <div class="sub" id="gridDir">--</div>
    </div>
    <div class="card">
      <h2>💶 PVPC</h2>
      <div class="big" id="price">--<span class="unit">€</span></div>
    </div>
    <div class="card">
      <h2>Estado</h2>
      <div class="big" id="status">--</div>
    </div>
  </div>
  
  <div class="card wide">
    <h2>🔌 Cargas Controlables</h2>
    <div id="loads">Sin cargas configuradas</div>
    <div class="btn-row">
      <button class="btn" onclick="runBalance()">🔄 Balancear</button>
      <button class="btn" onclick="restoreAll()" style="background:#5f27cd">⬆️ Restaurar</button>
      <button class="btn" onclick="applyPeriod()" style="background:#00d26a">⚡ Aplicar periodo</button>
    </div>
  </div>
  
  <script>
    const base = window.location.pathname.replace(/\\/$/, '');
    
    async function refresh() {
      try {
        const res = await fetch(base + '/api/status');
        const d = await res.json();
        
        // Period
        ['valle','llano','punta'].forEach(p => {
          document.getElementById('p-'+p).classList.toggle('active', d.currentPeriod === p);
        });
        document.getElementById('contracted').textContent = (d.contractedPower/1000).toFixed(2) + ' kW';
        document.getElementById('usage').innerHTML = (d.load.power/1000).toFixed(2) + ' kW (<span id="usagePct">' + d.usagePercent.toFixed(0) + '%</span>)';
        
        const barColor = d.isOverloaded ? '#ff4757' : d.usagePercent > 80 ? '#ffc107' : '#00d26a';
        document.getElementById('usageBar').style.width = Math.min(d.usagePercent, 100) + '%';
        document.getElementById('usageBar').style.background = barColor;
        
        // Stats
        document.getElementById('soc').innerHTML = d.battery.soc.toFixed(0) + '<span class="unit">%</span>';
        document.getElementById('batKwh').textContent = d.battery.kwh.toFixed(1) + ' / ' + d.battery.capacity.toFixed(0) + ' kWh';
        document.getElementById('pv').innerHTML = d.pv.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('load').innerHTML = d.load.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('grid').innerHTML = Math.abs(d.grid.power).toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('gridDir').textContent = d.grid.power > 50 ? '← Import' : d.grid.power < -50 ? '→ Export' : '≈ Balance';
        document.getElementById('gridDir').className = 'sub ' + (d.grid.power > 50 ? 'danger' : d.grid.power < -50 ? 'ok' : '');
        
        if (d.currentPrice !== null) {
          document.getElementById('price').innerHTML = d.currentPrice.toFixed(3) + '<span class="unit">€/kWh</span>';
        }
        
        const statusClass = d.isOverloaded ? 'danger' : 'ok';
        document.getElementById('status').innerHTML = '<span class="' + statusClass + '">' + (d.isOverloaded ? '⚠️' : '✅') + '</span>';
        
        // Loads
        document.getElementById('loads').innerHTML = d.loads.length ? d.loads.map(l =>
          '<div class="load' + (d.shedLoads.includes(l.id) ? ' shed' : '') + '">' +
            '<div><strong>' + l.name + '</strong><br><span style="color:#888">' + ((l.current_power||0)/1000).toFixed(2) + ' kW</span></div>' +
            '<span class="badge ' + l.priority + '">' + l.priority + '</span>' +
          '</div>'
        ).join('') : '<p style="color:#888">Añade cargas en la configuración del addon</p>';
      } catch (e) { console.error(e); }
    }
    
    async function runBalance() { await fetch(base + '/api/balance', { method: 'POST' }); refresh(); }
    async function restoreAll() { await fetch(base + '/api/restore', { method: 'POST' }); refresh(); }
    async function applyPeriod() { await fetch(base + '/api/apply-period', { method: 'POST' }); refresh(); }
    
    refresh();
    setInterval(refresh, 5000);
  </script>
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
  
  try {
    if (path === '/' || path === '/index.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    } else if (path === '/api/status') {
      await updateState();
      res.end(JSON.stringify(state));
    } else if (path === '/api/balance' && req.method === 'POST') {
      const result = await balanceLoads();
      res.end(JSON.stringify({ success: true, ...result }));
    } else if (path === '/api/restore' && req.method === 'POST') {
      for (const id of [...state.shedLoads]) {
        const load = state.loads.find(l => l.id === id);
        if (load?.switch_entity && await turnOn(load.switch_entity)) {
          state.shedLoads = state.shedLoads.filter(i => i !== id);
        }
      }
      res.end(JSON.stringify({ success: true }));
    } else if (path === '/api/apply-period' && req.method === 'POST') {
      await updateState();
      const actions = await applyPeriodSettings();
      res.end(JSON.stringify({ success: true, actions }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

// Auto-balance
if (lm.check_interval_seconds > 0) {
  setInterval(() => balanceLoads(), lm.check_interval_seconds * 1000);
}

// Apply period settings every 5 min
setInterval(async () => {
  await updateState();
  await applyPeriodSettings();
}, 5 * 60 * 1000);

server.listen(8099, () => {
  console.log('⚡ Volt Load Manager running on :8099');
  console.log(`🔋 Battery: ${inv.battery_capacity_kwh || 32.6} kWh`);
  console.log(`📊 Inverter max: ${inv.max_power || 6000}W`);
  console.log(`🔌 Loads: ${(options.loads || []).length}`);
  console.log(`🚗 EV charging: ${ev.enabled ? 'enabled' : 'disabled'}`);
});
