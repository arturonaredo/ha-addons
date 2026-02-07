/**
 * Volt Load Manager - Home Assistant Addon
 * Battery optimization + load management for Deye inverters
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
  options = {
    inverter_max_power: 6000,
    battery_capacity_kwh: 32.6,
    battery_min_soc: 10,
    battery_max_soc: 100,
    entities: {},
    programs: [],
    price_cheap_threshold: 0.08,
    price_expensive_threshold: 0.18,
    load_manager_enabled: false,
    safety_margin: 10,
    check_interval: 30,
    loads: []
  };
}

// State
let state = {
  // Battery
  battery: { soc: 0, power: 0, kwh: 0 },
  grid: { power: 0 },
  load: { power: 0 },
  pv: { power: 0 },
  
  // Load manager
  totalPower: 0,
  maxAvailable: options.inverter_max_power * (1 - (options.safety_margin || 10) / 100),
  usagePercent: 0,
  isOverloaded: false,
  shedLoads: [],
  loads: (options.loads || []).map(l => ({ ...l, current_power: 0, is_on: true })),
  
  // Actions
  lastAction: null,
  lastCheck: null,
  
  // PVPC
  currentPrice: null,
  priceLevel: 'unknown', // cheap, normal, expensive
  
  // Active program
  activeProgram: null
};

// ─────────────────────────────────────────────────────────────────────────────
// HA API
// ─────────────────────────────────────────────────────────────────────────────

async function getEntityState(entityId) {
  if (!entityId) return null;
  try {
    const res = await axios.get(`${HA_URL}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

async function callService(domain, service, data) {
  try {
    await axios.post(`${HA_URL}/services/${domain}/${service}`, data, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
    });
    return true;
  } catch (e) {
    console.error(`Error calling ${domain}.${service}:`, e.message);
    return false;
  }
}

async function setNumber(entityId, value) {
  return callService('number', 'set_value', { entity_id: entityId, value });
}

async function setSelect(entityId, option) {
  return callService('select', 'select_option', { entity_id: entityId, option });
}

async function setTime(entityId, time) {
  return callService('time', 'set_value', { entity_id: entityId, time });
}

async function turnOff(entityId) {
  const domain = entityId.split('.')[0];
  return callService(domain, 'turn_off', { entity_id: entityId });
}

async function turnOn(entityId) {
  const domain = entityId.split('.')[0];
  return callService(domain, 'turn_on', { entity_id: entityId });
}

// ─────────────────────────────────────────────────────────────────────────────
// State Updates
// ─────────────────────────────────────────────────────────────────────────────

async function updateInverterState() {
  const ent = options.entities || {};
  
  const [soc, batPower, gridPower, loadPower, pvPower] = await Promise.all([
    getEntityState(ent.battery_soc),
    getEntityState(ent.battery_power),
    getEntityState(ent.grid_power),
    getEntityState(ent.load_power),
    getEntityState(ent.pv_power)
  ]);
  
  state.battery.soc = parseFloat(soc?.state) || 0;
  state.battery.power = parseFloat(batPower?.state) || 0;
  state.battery.kwh = (state.battery.soc / 100) * options.battery_capacity_kwh;
  state.grid.power = parseFloat(gridPower?.state) || 0;
  state.load.power = parseFloat(loadPower?.state) || 0;
  state.pv.power = parseFloat(pvPower?.state) || 0;
}

async function updateLoadState() {
  for (const load of state.loads) {
    if (load.power_sensor) {
      const entity = await getEntityState(load.power_sensor);
      load.current_power = parseFloat(entity?.state) || 0;
    }
    if (load.switch_entity) {
      const entity = await getEntityState(load.switch_entity);
      load.is_on = entity?.state === 'on';
    }
  }
  
  state.totalPower = state.loads.reduce((sum, l) => sum + (l.is_on ? l.current_power : 0), 0);
  state.usagePercent = (state.totalPower / options.inverter_max_power) * 100;
  state.isOverloaded = state.totalPower > state.maxAvailable;
}

async function updatePriceState() {
  // Try PVPC sensor
  const pvpc = await getEntityState('sensor.pvpc');
  if (pvpc?.state) {
    state.currentPrice = parseFloat(pvpc.state);
  }
  
  if (state.currentPrice !== null) {
    if (state.currentPrice < options.price_cheap_threshold) {
      state.priceLevel = 'cheap';
    } else if (state.currentPrice > options.price_expensive_threshold) {
      state.priceLevel = 'expensive';
    } else {
      state.priceLevel = 'normal';
    }
  }
}

async function updateState() {
  await Promise.all([
    updateInverterState(),
    updateLoadState(),
    updatePriceState()
  ]);
  state.lastCheck = new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Balancing
// ─────────────────────────────────────────────────────────────────────────────

async function balanceLoads() {
  if (!options.load_manager_enabled) {
    return { actions: [], message: 'Load manager disabled' };
  }
  
  await updateLoadState();
  const actions = [];
  
  if (state.isOverloaded) {
    const excess = state.totalPower - state.maxAvailable;
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
          actions.push(`⬇️ ${load.name} apagado (${load.current_power}W)`);
        }
      }
    }
    
    if (actions.length) {
      state.lastAction = { time: new Date().toISOString(), type: 'shed', actions };
    }
  } else if (state.shedLoads.length > 0) {
    const headroom = state.maxAvailable - state.totalPower;
    
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
// Program Management
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentProgram() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  const programs = (options.programs || [])
    .filter(p => p.enabled)
    .map(p => {
      const [h, m] = (p.time || '00:00').split(':').map(Number);
      return { ...p, minutes: h * 60 + m };
    })
    .sort((a, b) => a.minutes - b.minutes);
  
  // Find active program (last one before current time)
  let active = programs[programs.length - 1]; // Default to last (wraps from yesterday)
  for (const p of programs) {
    if (p.minutes <= currentMinutes) {
      active = p;
    }
  }
  
  return active;
}

async function applyProgram(program) {
  if (!program) return;
  
  const slot = program.slot;
  const actions = [];
  
  // Set SOC target
  const socEntity = `number.inverter_program_${slot}_soc`;
  await setNumber(socEntity, program.soc_target);
  actions.push(`SOC target: ${program.soc_target}%`);
  
  // Set time
  const timeEntity = `time.inverter_program_${slot}_time`;
  await setTime(timeEntity, program.time + ':00');
  actions.push(`Time: ${program.time}`);
  
  // Grid charging
  if (program.charge_from_grid) {
    // Enable grid charging
    await setNumber('number.inverter_battery_grid_charging_start', options.battery_min_soc);
    actions.push('Grid charge: enabled');
  }
  
  state.activeProgram = program;
  console.log(`📅 Applied program ${slot}:`, actions.join(', '));
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
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #eee; padding: 16px; }
    h1 { font-size: 22px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    h1 span { font-size: 28px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: #16213e; border-radius: 12px; padding: 16px; }
    .card.wide { grid-column: 1 / -1; }
    .card h2 { font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 8px; }
    .big { font-size: 32px; font-weight: 700; }
    .unit { font-size: 14px; color: #888; font-weight: 400; }
    .sub { font-size: 14px; color: #888; margin-top: 4px; }
    .ok { color: #00d26a; }
    .warn { color: #ffc107; }
    .danger { color: #ff4757; }
    .cheap { color: #00d26a; }
    .normal { color: #ffc107; }
    .expensive { color: #ff4757; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1f3460; }
    .row:last-child { border: none; }
    .load { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #1f3460; }
    .load:last-child { border: none; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; }
    .badge.essential { background: #ff4757; }
    .badge.comfort { background: #ffc107; color: #000; }
    .badge.accessory { background: #5f27cd; }
    .shed { opacity: 0.5; }
    .btn { background: #0984e3; color: #fff; border: none; padding: 12px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; }
    .btn:hover { background: #0770c2; }
    .btn-row { display: flex; gap: 8px; margin-top: 12px; }
    .program { padding: 8px 12px; background: #1f3460; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; }
    .program.active { border: 2px solid #00d26a; }
  </style>
</head>
<body>
  <h1><span>⚡</span> Volt Load Manager</h1>
  
  <div class="grid">
    <div class="card">
      <h2>Batería</h2>
      <div class="big" id="soc">--<span class="unit">%</span></div>
      <div class="sub" id="batKwh">-- kWh</div>
    </div>
    <div class="card">
      <h2>Solar</h2>
      <div class="big" id="pv">--<span class="unit">W</span></div>
    </div>
    <div class="card">
      <h2>Consumo</h2>
      <div class="big" id="load">--<span class="unit">W</span></div>
    </div>
    <div class="card">
      <h2>Red</h2>
      <div class="big" id="grid">--<span class="unit">W</span></div>
      <div class="sub" id="gridDir">--</div>
    </div>
    <div class="card">
      <h2>Precio PVPC</h2>
      <div class="big" id="price">--<span class="unit">€/kWh</span></div>
      <div class="sub" id="priceLevel">--</div>
    </div>
    <div class="card">
      <h2>Estado</h2>
      <div class="big" id="status">--</div>
      <div class="sub" id="lastCheck">--</div>
    </div>
  </div>
  
  <div class="card wide">
    <h2>Programas de Carga</h2>
    <div id="programs">Cargando...</div>
  </div>
  
  <div class="card wide">
    <h2>Cargas Gestionadas</h2>
    <div id="loads">No hay cargas configuradas</div>
    <div class="btn-row">
      <button class="btn" onclick="runBalance()">🔄 Balancear</button>
      <button class="btn" onclick="restoreAll()" style="background:#5f27cd">⬆️ Restaurar Todo</button>
    </div>
  </div>
  
  <script>
    const base = window.location.pathname.replace(/\\/$/, '');
    
    async function refresh() {
      try {
        const res = await fetch(base + '/api/status');
        const d = await res.json();
        
        document.getElementById('soc').innerHTML = d.battery.soc.toFixed(0) + '<span class="unit">%</span>';
        document.getElementById('batKwh').textContent = d.battery.kwh.toFixed(1) + ' kWh';
        document.getElementById('pv').innerHTML = d.pv.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('load').innerHTML = d.load.power.toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('grid').innerHTML = Math.abs(d.grid.power).toFixed(0) + '<span class="unit">W</span>';
        document.getElementById('gridDir').textContent = d.grid.power > 50 ? '← Importando' : d.grid.power < -50 ? '→ Exportando' : '≈ Equilibrado';
        
        if (d.currentPrice !== null) {
          document.getElementById('price').innerHTML = d.currentPrice.toFixed(3) + '<span class="unit">€/kWh</span>';
          document.getElementById('priceLevel').innerHTML = '<span class="' + d.priceLevel + '">' + 
            (d.priceLevel === 'cheap' ? '💚 Barato' : d.priceLevel === 'expensive' ? '🔴 Caro' : '🟡 Normal') + '</span>';
        }
        
        const statusClass = d.isOverloaded ? 'danger' : 'ok';
        document.getElementById('status').innerHTML = '<span class="' + statusClass + '">' + 
          (d.isOverloaded ? '⚠️ Sobrecarga' : '✅ OK') + '</span>';
        document.getElementById('lastCheck').textContent = d.lastCheck ? new Date(d.lastCheck).toLocaleTimeString() : '--';
        
        // Programs
        const programs = d.programs || [];
        document.getElementById('programs').innerHTML = programs.length ? programs.map(p => 
          '<div class="program' + (d.activeProgram?.slot === p.slot ? ' active' : '') + '">' +
            '<span>⏰ ' + p.time + ' → SOC ' + p.soc_target + '%</span>' +
            '<span>' + (p.charge_from_grid ? '🔌 Red' : '☀️ Solar') + '</span>' +
          '</div>'
        ).join('') : '<p style="color:#888">Configura programas en el addon</p>';
        
        // Loads
        document.getElementById('loads').innerHTML = d.loads.length ? d.loads.map(l =>
          '<div class="load' + (d.shedLoads.includes(l.id) ? ' shed' : '') + '">' +
            '<div><strong>' + l.name + '</strong><br><span style="color:#888">' + (l.current_power || 0).toFixed(0) + 'W</span></div>' +
            '<span class="badge ' + l.priority + '">' + l.priority + '</span>' +
          '</div>'
        ).join('') : '<p style="color:#888">Configura cargas en el addon</p>';
      } catch (e) {
        console.error('Error:', e);
      }
    }
    
    async function runBalance() {
      await fetch(base + '/api/balance', { method: 'POST' });
      refresh();
    }
    
    async function restoreAll() {
      await fetch(base + '/api/restore', { method: 'POST' });
      refresh();
    }
    
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
      res.end(JSON.stringify({
        ...state,
        programs: options.programs || [],
        config: {
          inverter_max_power: options.inverter_max_power,
          battery_capacity_kwh: options.battery_capacity_kwh,
          load_manager_enabled: options.load_manager_enabled
        }
      }));
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
    } else if (path === '/api/program' && req.method === 'POST') {
      const program = getCurrentProgram();
      if (program) await applyProgram(program);
      res.end(JSON.stringify({ success: true, program }));
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

// Auto-balance interval
if (options.check_interval > 0) {
  setInterval(() => balanceLoads(), options.check_interval * 1000);
}

// Check programs every minute
setInterval(() => {
  const program = getCurrentProgram();
  if (program && (!state.activeProgram || state.activeProgram.slot !== program.slot)) {
    applyProgram(program);
  }
}, 60000);

server.listen(8099, () => {
  console.log('⚡ Volt Load Manager running on :8099');
  console.log(`🔋 Battery: ${options.battery_capacity_kwh} kWh`);
  console.log(`📊 Inverter max: ${options.inverter_max_power}W`);
  console.log(`📅 Programs: ${(options.programs || []).length}`);
  console.log(`🔌 Loads: ${(options.loads || []).length}`);
});
