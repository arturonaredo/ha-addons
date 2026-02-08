# Changelog

All notable changes to VoltAssistant will be documented in this file.

## [1.4.0] - 2026-02-08

### Added

#### Dashboard
- **Summary Card**: "What's happening now" prominent display
- **Energy Flow Diagram**: Visual solar → load → grid flow
- **Battery Power Indicator**: Charge/discharge status
- **Next Cheap Hour**: Shows when next cheap period starts
- **Live Connection Status**: Green/red dot in header
- **Tooltips**: Hover info on battery display

#### Configuration
- **Export/Import**: Save and restore configuration
- **Reset to Defaults**: One-click configuration reset
- **Test Sensors Button**: Verify all entities work
- **Controls Section**: Configure inverter control entities

#### API Enhancements
- `/api/set/target/{soc}`: Simple URL-based target setting
- `/api/set/action/{action}`: URL-based action execution
- `/api/schedule`: Schedule future actions
- `/api/demo`: Demo data for UI testing
- `/api/ha-config`: Generate HA configuration YAML

#### UI/UX
- **Keyboard Shortcuts**: 1-7 tabs, R refresh, Ctrl+A auto
- **Demo Mode Toggle**: Test UI without HA connection
- **Hourly Price Table**: 12-hour price preview
- **Last Update Timestamp**: Shows data freshness
- **Error Handling**: Visual feedback on connection issues

## [1.3.0] - 2026-02-08

### Added

#### UI Panels
- **Forecast Panel**: Solar forecast (Open-Meteo) + PVPC prices + charging plan
- **EV Charging Panel**: Car SOC, target, ready time, smart charging plan
- **Statistics Panel**: Daily stats, SOC range, grid import/export, price range
- **Charts Panel**: 24h history for SOC, price, power flow (Chart.js)
- **Debug Panel**: Entity tests, logs, connection status, system info

#### Quick Actions
- `charge_100`: Charge to 100% (6h override)
- `charge_80`: Charge to 80% (4h override)
- `charge_50`: Charge to 50% (2h override)
- `stop_charge`: Stop grid charging (2h)
- `discharge`: Enable discharge mode
- `hold`: Hold current SOC (4h)
- `night_mode`: Maintain 80% for overnight (10h)
- `force_export`: Discharge to grid
- `grid_charge_on`: Enable grid charging
- `grid_charge_off`: Disable grid charging
- `balance_loads`: Trigger load balancing
- `restore_loads`: Restore all shed loads
- `auto`: Return to automatic mode

#### Alerts System
- Low SOC alert (configurable threshold)
- High price alert (configurable threshold)
- Overload alert (configurable % of contracted power)
- Alert banner in UI with dismiss button
- Alert history tracking

#### API Endpoints
- `/api/forecast/solar`: Solar generation forecast
- `/api/forecast/prices`: PVPC price forecast
- `/api/forecast/plan`: Charging plan recommendation
- `/api/forecast/savings`: Monthly savings estimate
- `/api/forecast/all`: Combined forecast data
- `/api/ev/status`: EV charging status
- `/api/ev/plan`: Smart EV charging plan
- `/api/stats/daily`: Daily statistics
- `/api/stats/summary`: Full system summary
- `/api/report/daily`: Text report for notifications
- `/api/alerts`: Active alerts
- `/api/alerts/history`: Alert history
- `/api/alerts/clear`: Clear alerts
- `/api/quick-action`: Execute quick actions
- `/api/webhook/ha`: HA automation webhook
- `/api/webhook/notify`: Notification webhook

#### Prometheus Metrics
- `voltassistant_battery_power`: Battery charge/discharge power
- `voltassistant_battery_kwh`: Energy stored
- `voltassistant_target_soc`: Target SOC
- `voltassistant_contracted_power`: Contracted power
- `voltassistant_usage_percent`: Usage as % of contracted
- `voltassistant_overloaded`: Overload status (0/1)
- `voltassistant_loads_shed`: Number of shed loads
- `voltassistant_alerts_active`: Active alert count
- `voltassistant_tariff_period`: Current period (1/2/3)
- `voltassistant_car_soc`: EV car SOC

#### Configuration
- Alerts configuration (thresholds)
- EV charging configuration
- Visual timer for manual target expiry

### Changed
- Renamed addon from "Volt Load Manager" to "VoltAssistant"
- Changed slug to `voltassistant`
- Improved UI with more compact quick action buttons
- Added alert badge in header

## [1.2.0] - 2026-02-07

### Added
- Debug panel with connection status and logs
- Charts panel with 24h history
- Configuration panel for all settings

## [1.1.0] - 2026-02-07

### Added
- Initial release with battery optimization and load management
