/**
 * VoltAssistant Load Manager - Home Assistant Addon
 * Reads config from /data/options.json (HA addon config)
 */

const http = require('http');
const fs = require('fs');
const axios = require('axios');

// HA Supervisor API
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_URL = 'http://supervisor/core/api';

// Read addon options (generated from the form in HA)
let options = {
  max_inverter_power: 6000,
  safety_margin: 10,
  check_interval: 30,
  loads: []
};

try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  console.log('📋 Config loaded:', JSON.stringify(options, null, 2));
} catch (e) {
  console.log('⚠️ No options.json, using defaults');
}

// State
let state = {
  totalPower: 0,
  maxAvailable: options.max_inverter_power * (1 - options.safety_margin / 100),
  usagePercent: 0,
  isOverloaded: false,
  shedLoads: [],
  lastAction: null,
  lastCheck: null,
  loads: options.loads.map(l => ({ ...l, current_power: 0, is_on: true }))
};

// HA API helpers
async function getEntityState(entityId) {
  try {
    const res = await axios.get(`${HA_URL}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` }
    });
    return res.data;
  } catch (e) {
    console.error(`Error getting ${entityId}:`, e.message);
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

async function turnOff(entityId) {
  const domain = entityId.split('.')[0];
  return callService(domain, 'turn_off', { entity_id: entityId });
}

async function turnOn(entityId) {
  const domain = entityId.split('.')[0];
  return callService(domain, 'turn_on', { entity_id: entityId });
}

// Update state from HA
async function updateState() {
  for (const load of state.loads) {
    // Get power
    if (load.power_sensor) {
      const entity = await getEntityState(load.power_sensor);
      load.current_power = entity ? parseFloat(entity.state) || 0 : 0;
    }
    // Get on/off state
    if (load.switch_entity) {
      const entity = await getEntityState(load.switch_entity);
      load.is_on = entity?.state === 'on';
    }
  }
  
  state.totalPower = state.loads.reduce((sum, l) => sum + (l.is_on ? l.current_power : 0), 0);
  state.usagePercent = (state.totalPower / options.max_inverter_power) * 100;
  state.isOverloaded = state.totalPower > state.maxAvailable;
  state.lastCheck = new Date().toISOString();
}

// Balance loads
async function balance() {
  await updateState();
  const actions = [];
  
  if (state.isOverloaded) {
    const excess = state.totalPower - state.maxAvailable;
    let saved = 0;
    
    // Shed accessory first, then comfort
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
          actions.push(`⬇️ Apagado: ${load.name} (${load.current_power}W)`);
        }
      }
    }
    
    if (actions.length) {
      state.lastAction = { time: new Date().toISOString(), type: 'shed', actions };
    }
  } else if (state.shedLoads.length > 0) {
    // Try to restore
    const headroom = state.maxAvailable - state.totalPower;
    
    for (const priority of ['comfort', 'accessory']) {
      const toRestore = state.loads
        .filter(l => l.priority === priority && state.shedLoads.includes(l.id))
        .sort((a, b) => (a.max_power || 1000) - (b.max_power || 1000));
      
      for (const load of toRestore) {
        if ((load.max_power || 1000) <= headroom * 0.8) {
          if (await turnOn(load.switch_entity)) {
            state.shedLoads = state.shedLoads.filter(id => id !== load.id);
            actions.push(`⬆️ Restaurado: ${load.name}`);
          }
        }
      }
    }
    
    if (actions.length) {
      state.lastAction = { time: new Date().toISOString(), type: 'restore', actions };
    }
  }
  
  return actions;
}

// Web UI (ingress)
const html = `<!DOCTYPE html>
<html>
<head>
  <title>Load Manager</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1c1c1c; color: #fff; padding: 20px; }
    h1 { font-size: 24px; margin-bottom: 20px; }
    .card { background: #2d2d2d; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .card h2 { font-size: 14px; color: #888; margin-bottom: 12px; text-transform: uppercase; }
    .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #3d3d3d; }
    .stat:last-child { border: none; }
    .stat .label { color: #aaa; }
    .stat .value { font-weight: 600; }
    .ok { color: #4cd964; }
    .warn { color: #ff9500; }
    .danger { color: #ff3b30; }
    .load { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #3d3d3d; }
    .load:last-child { border: none; }
    .load-name { font-weight: 500; }
    .load-power { color: #888; font-size: 14px; }
    .priority { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
    .priority.essential { background: #ff3b30; }
    .priority.comfort { background: #ff9500; }
    .priority.accessory { background: #5856d6; }
    .shed { opacity: 0.5; text-decoration: line-through; }
    button { background: #0a84ff; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 8px; }
    button:hover { background: #0070e0; }
    .actions { margin-top: 16px; padding: 12px; background: #3d3d3d; border-radius: 8px; font-size: 14px; }
  </style>
</head>
<body>
  <h1>⚡ Load Manager</h1>
  
  <div class="card">
    <h2>Estado</h2>
    <div id="status">Cargando...</div>
  </div>
  
  <div class="card">
    <h2>Cargas</h2>
    <div id="loads">Cargando...</div>
  </div>
  
  <button onclick="runBalance()">🔄 Ejecutar Balance</button>
  <button onclick="forceRestore()" style="background:#5856d6">⬆️ Restaurar Todo</button>
  
  <div id="actions" class="actions" style="display:none"></div>
  
  <script>
    const base = window.location.pathname.replace(/\\/$/, '');
    
    async function refresh() {
      const res = await fetch(base + '/api/status');
      const data = await res.json();
      
      const statusClass = data.isOverloaded ? 'danger' : (data.usagePercent > 80 ? 'warn' : 'ok');
      document.getElementById('status').innerHTML = \`
        <div class="stat"><span class="label">Potencia Total</span><span class="value">\${data.totalPower.toFixed(0)}W</span></div>
        <div class="stat"><span class="label">Máximo Disponible</span><span class="value">\${data.maxAvailable.toFixed(0)}W</span></div>
        <div class="stat"><span class="label">Uso</span><span class="value \${statusClass}">\${data.usagePercent.toFixed(1)}%</span></div>
        <div class="stat"><span class="label">Estado</span><span class="value \${statusClass}">\${data.isOverloaded ? '⚠️ SOBRECARGA' : '✅ OK'}</span></div>
        <div class="stat"><span class="label">Última comprobación</span><span class="value">\${data.lastCheck ? new Date(data.lastCheck).toLocaleTimeString() : '-'}</span></div>
      \`;
      
      document.getElementById('loads').innerHTML = data.loads.length ? data.loads.map(l => \`
        <div class="load \${data.shedLoads.includes(l.id) ? 'shed' : ''}">
          <div>
            <div class="load-name">\${l.name}</div>
            <div class="load-power">\${l.current_power?.toFixed(0) || 0}W / \${l.max_power || '?'}W max</div>
          </div>
          <span class="priority \${l.priority}">\${l.priority}</span>
        </div>
      \`).join('') : '<p style="color:#888">No hay cargas configuradas. Añádelas en la configuración del addon.</p>';
    }
    
    async function runBalance() {
      const res = await fetch(base + '/api/balance', { method: 'POST' });
      const data = await res.json();
      if (data.actions?.length) {
        document.getElementById('actions').style.display = 'block';
        document.getElementById('actions').innerHTML = data.actions.join('<br>');
      }
      refresh();
    }
    
    async function forceRestore() {
      await fetch(base + '/api/restore', { method: 'POST' });
      refresh();
    }
    
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/[^/]+/, '') || '/'; // Strip ingress prefix
  
  res.setHeader('Content-Type', 'application/json');
  
  if (path === '/' || path === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  } else if (path === '/api/status') {
    await updateState();
    res.end(JSON.stringify(state));
  } else if (path === '/api/balance' && req.method === 'POST') {
    const actions = await balance();
    res.end(JSON.stringify({ success: true, actions }));
  } else if (path === '/api/restore' && req.method === 'POST') {
    for (const id of [...state.shedLoads]) {
      const load = state.loads.find(l => l.id === id);
      if (load?.switch_entity && await turnOn(load.switch_entity)) {
        state.shedLoads = state.shedLoads.filter(i => i !== id);
      }
    }
    res.end(JSON.stringify({ success: true, restored: state.shedLoads.length === 0 }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Auto-balance interval
if (options.check_interval > 0) {
  setInterval(() => balance(), options.check_interval * 1000);
  console.log(`⏱️ Auto-balance cada ${options.check_interval}s`);
}

server.listen(8099, () => {
  console.log('⚡ VoltAssistant Load Manager running on :8099');
  console.log(`📊 Max inverter: ${options.max_inverter_power}W, Margin: ${options.safety_margin}%`);
  console.log(`🔌 ${options.loads.length} loads configured`);
});
