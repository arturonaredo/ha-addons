# VoltAssistant - Smart Battery & Load Manager

VoltAssistant is an intelligent battery optimization and load management system for Home Assistant, designed specifically for solar installations with battery storage in Spain (PVPC tariff).

## Features

### 🔋 Battery Optimization
- **PVPC Price Optimization**: Automatically fetches electricity prices and plans charging during the cheapest hours
- **Solar Forecast Integration**: Uses Open-Meteo to predict solar generation and optimize charging strategy
- **Smart Charging**: Price thresholds with automatic target SOC adjustment
- **Weekend Mode**: Keep battery full on weekends when prices are lower
- **Manual Override**: Temporarily set a custom target SOC with auto-expiry

### ⚡ Load Management
- **Priority-based Load Shedding**: Essential > Comfort > Accessory
- **2.0TD Tariff Support**: Different contracted power per period (Valle/Llano/Punta)
- **Automatic Balancing**: Sheds non-essential loads when approaching contracted power
- **Auto-restore**: Brings loads back online when headroom is available

### 📊 Monitoring
- **Real-time Dashboard**: Battery, solar, grid, and load power
- **Charts**: 24-hour history of SOC, prices, and power flow
- **Forecast Panel**: Solar and price forecasts with charging plan
- **Debug Panel**: Entity tests, logs, and connection status

### 🔌 Integration
- **REST API**: Full API for automation and external integrations
- **Webhooks**: HA-friendly webhooks for automations
- **Prometheus Metrics**: `/metrics` endpoint for Grafana

## Quick Start

### 1. Add the Repository

Go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add:

```
https://github.com/arturonaredo/ha-addons
```

### 2. Install VoltAssistant

Find "VoltAssistant" in the add-on store and click **Install**.

### 3. Configure

Open the add-on configuration or use the web UI (Configuration tab) to set:

- **Sensors**: Your inverter's entity IDs for SOC, power, prices, etc.
- **Controls**: Entity IDs for charging controls
- **Tariff Periods**: Contracted power per period
- **Battery Optimization**: Price thresholds and preferences

### 4. Start & Open Web UI

Start the add-on and click "Open Web UI" to access the dashboard.

## Configuration

### Required Sensors

| Setting | Description | Example |
|---------|-------------|---------|
| `sensors.battery_soc` | Battery state of charge (%) | `sensor.inverter_battery_soc` |
| `sensors.battery_power` | Battery power (W) | `sensor.inverter_battery_power` |
| `sensors.grid_power` | Grid import/export (W) | `sensor.inverter_grid_power` |
| `sensors.load_power` | House consumption (W) | `sensor.inverter_load_power` |
| `sensors.pv_power` | Solar generation (W) | `sensor.inverter_pv_power` |
| `sensors.pvpc_price` | PVPC electricity price | `sensor.esios_pvpc` |

### Optional Controls

| Setting | Description | Example |
|---------|-------------|---------|
| `controls.program_1_soc` | Charge target SOC | `number.inverter_program_1_soc` |
| `controls.grid_charge_start_soc` | Grid charge trigger | `number.inverter_grid_charging_start` |
| `controls.work_mode` | Inverter work mode | `select.inverter_work_mode` |

### Tariff Periods (2.0TD)

```yaml
tariff_periods:
  valle:
    hours: "00:00-08:00"
    contracted_power_kw: 6.9
    charge_battery: true
    target_soc: 100
  llano:
    hours: "08:00-10:00,14:00-18:00,22:00-00:00"
    contracted_power_kw: 3.45
    charge_battery: false
    target_soc: 50
  punta:
    hours: "10:00-14:00,18:00-22:00"
    contracted_power_kw: 3.45
    charge_battery: false
    target_soc: 20
```

### Battery Optimization

```yaml
battery_optimization:
  enabled: true
  min_soc: 10
  default_target_soc: 80
  always_charge_below_price: 0.05  # €/kWh
  never_charge_above_price: 0.15   # €/kWh
  keep_full_weekends: true
```

## API Endpoints

### Status & Dashboard

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics |
| `/api/status` | GET | Full system status |
| `/api/config` | GET | Current configuration |
| `/api/config` | POST | Update configuration |

### Forecasts

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/forecast/solar` | GET | Solar generation forecast |
| `/api/forecast/prices` | GET | PVPC price forecast |
| `/api/forecast/plan` | GET | Charging plan recommendation |
| `/api/forecast/savings` | GET | Estimated monthly savings |
| `/api/forecast/all` | GET | All forecasts combined |

### Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/target` | POST | Set manual target SOC (`{"soc": 80}`) |
| `/api/target` | DELETE | Clear manual target (auto mode) |
| `/api/quick-action` | POST | Execute quick action |
| `/api/balance` | POST | Trigger load balancing |
| `/api/restore` | POST | Restore all shed loads |

### Quick Actions

POST to `/api/quick-action` with `{"action": "<action>"}`:

| Action | Description |
|--------|-------------|
| `charge_100` | Charge to 100% (6h override) |
| `charge_80` | Charge to 80% (4h override) |
| `stop_charge` | Stop grid charging (2h) |
| `discharge` | Enable discharge mode |
| `auto` | Return to auto mode |

### Webhooks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/ha` | GET | HA automation-friendly status |
| `/api/webhook/notify` | GET | Generate notification text |

## Home Assistant Automation Examples

### Notify on Cheap Hours

```yaml
automation:
  - alias: "VoltAssistant Cheap Hour Alert"
    trigger:
      - platform: time_pattern
        hours: "/1"
    action:
      - service: rest_command.voltassistant_check
      - condition: template
        value_template: "{{ states.sensor.voltassistant_is_cheap.state == 'on' }}"
      - service: notify.mobile_app
        data:
          title: "⚡ Cheap Hour!"
          message: "Electricity is cheap now. Good time to run high-power appliances."
```

### REST Command

```yaml
rest_command:
  voltassistant_charge_100:
    url: "http://YOUR_ADDON_IP:8099/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "charge_100"}'
```

### Simple URL Control (GET)

For simple integrations, you can use GET requests:

```bash
# Set target SOC to 80%
curl http://YOUR_ADDON_IP:8099/api/set/target/80

# Execute action
curl http://YOUR_ADDON_IP:8099/api/set/action/charge_100
curl http://YOUR_ADDON_IP:8099/api/set/action/auto
```

In Home Assistant:

```yaml
rest_command:
  voltassistant_set_target:
    url: "http://YOUR_ADDON_IP:8099/api/set/target/{{ soc }}"
    method: GET
```

### Sensor from Webhook

```yaml
sensor:
  - platform: rest
    name: VoltAssistant Status
    resource: "http://YOUR_ADDON_IP:8099/api/webhook/ha"
    scan_interval: 60
    json_attributes:
      - battery_soc
      - target_soc
      - current_price
      - is_cheap_hour
      - recommended_action
    value_template: "{{ value_json.recommended_action }}"
```

### Morning Report Automation

```yaml
automation:
  - alias: "VoltAssistant Morning Report"
    trigger:
      - platform: time
        at: "08:00:00"
    action:
      - service: rest_command.voltassistant_report
      - service: notify.mobile_app_phone
        data:
          title: "⚡ VoltAssistant Report"
          message: "{{ states.sensor.voltassistant_report.state }}"

rest_command:
  voltassistant_report:
    url: "http://YOUR_ADDON_IP:8099/api/report/daily"
    method: GET
```

### Night Mode Before Bed

```yaml
automation:
  - alias: "VoltAssistant Night Mode"
    trigger:
      - platform: time
        at: "23:00:00"
    action:
      - service: rest_command.voltassistant_action
        data:
          action: night_mode

rest_command:
  voltassistant_action:
    url: "http://YOUR_ADDON_IP:8099/api/quick-action"
    method: POST
    content_type: "application/json"
    payload: '{"action": "{{ action }}"}'
```

### Low Battery Alert

```yaml
automation:
  - alias: "VoltAssistant Low Battery Alert"
    trigger:
      - platform: numeric_state
        entity_id: sensor.voltassistant_battery_soc
        below: 20
    condition:
      - condition: time
        after: "18:00:00"
        before: "08:00:00"
    action:
      - service: notify.mobile_app_phone
        data:
          title: "⚠️ Low Battery"
          message: "Battery at {{ states('sensor.voltassistant_battery_soc') }}% - consider charging"
```

### Prometheus/Grafana Integration

Add to your Prometheus config:

```yaml
scrape_configs:
  - job_name: 'voltassistant'
    static_configs:
      - targets: ['YOUR_ADDON_IP:8099']
    metrics_path: '/metrics'
```

### Voice Assistant Integration

```yaml
# Alexa/Google Home via HA TTS
automation:
  - alias: "VoltAssistant Voice Report"
    trigger:
      - platform: event
        event_type: alexa_actionable_notification
        event_data:
          event_id: voltassistant_status
    action:
      - service: rest_command.get_voltassistant_speak
      - service: tts.speak
        target:
          entity_id: media_player.echo_living_room
        data:
          message: "{{ states.sensor.voltassistant_speak.state }}"

rest_command:
  get_voltassistant_speak:
    url: "http://YOUR_ADDON_IP:8099/api/speak"
    method: GET

sensor:
  - platform: rest
    name: VoltAssistant Speak
    resource: "http://YOUR_ADDON_IP:8099/api/speak"
    scan_interval: 300
```

## API Reference

### Core Endpoints
- `GET /api/status` - Full system status
- `GET /api/quick` - Compact status for widgets
- `GET /api/speak` - Plain text for voice assistants

### Control Endpoints
- `POST /api/quick-action` - Execute actions (charge_100, charge_80, auto, etc.)
- `POST /api/target` - Set target SOC
- `GET/POST /api/set/target/{soc}` - Simple URL-based target
- `GET/POST /api/set/action/{action}` - Simple URL-based action

### Scheduling
- `GET /api/schedule` - List scheduled actions
- `POST /api/schedule` - Schedule action (at_hour or in_minutes)

### Presets
- `GET /api/presets` - List available presets
- `POST /api/preset/{id}` - Apply preset (eco, balanced, full, export)

### Forecast
- `GET /api/forecast/solar` - Solar generation forecast
- `GET /api/forecast/prices` - PVPC price forecast
- `GET /api/forecast/plan` - Charging plan recommendation
- `GET /api/forecast/all` - Combined forecast data

### Notifications
- `POST /api/notify/test` - Send test notification
- `GET /api/dnd` - Check Do Not Disturb status
- `POST /api/dnd` - Enable/disable DND

### Stats & Reports
- `GET /api/stats/daily` - Daily statistics
- `GET /api/stats/summary` - Full system summary
- `GET /api/report/daily` - Text report for notifications

### Monitoring
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics
- `GET /api/demo` - Demo data for UI testing

## Troubleshooting

### Add-on won't start

1. Check the add-on logs for errors
2. Verify `init: false` is set in config.yaml
3. Ensure all required files exist in the add-on directory

### HA Connection Failed

1. Go to **Debug** tab and check connection status
2. Click **Test All Entities** to verify sensor accessibility
3. Ensure the add-on has access to Home Assistant API (Supervisor token)

### Sensors Not Found

1. Go to **Configuration** tab
2. Enter correct entity IDs for your inverter
3. Save and check Debug tab for errors

### Charging Not Working

1. Verify `controls.program_1_soc` and `controls.grid_charge_start_soc` are set
2. Check if the inverter accepts number.set_value service
3. Review logs in Debug tab for HA service call results

## Support

- **GitHub Issues**: [github.com/arturonaredo/ha-addons/issues](https://github.com/arturonaredo/ha-addons/issues)
- **Documentation**: This page

## Changelog

### v1.3.0
- Renamed to VoltAssistant
- Added Forecast panel with solar/price predictions
- Added Quick Actions (charge_100, charge_80, stop, discharge, auto)
- Added webhooks for HA automations
- Added Prometheus metrics endpoint
- Improved Debug panel with entity testing

### v1.2.0
- Added Debug panel with connection status and logs
- Added Charts panel with 24h history
- Improved UI with configuration panel

### v1.1.0
- Initial release with battery optimization and load management
