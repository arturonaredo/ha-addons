# Home Assistant Add-ons Repository

This repository contains custom Home Assistant add-ons.

## Add-ons

### ⚡ VoltAssistant

Smart battery optimization and load management for solar installations in Spain.

**Features:**
- PVPC price optimization - charge during cheapest hours
- Solar forecast integration - predict generation with Open-Meteo
- Load management - priority-based load shedding for 2.0TD tariff
- Real-time dashboard with charts and forecasts
- Quick actions for manual control
- Webhooks and API for automations
- Prometheus metrics for Grafana

**Supported Inverters:**
- Deye SUN-xK-SG04LP3-EU series
- Any inverter with Home Assistant integration

[📖 Full Documentation](voltassistant-loadmanager/DOCS.md)

## Installation

1. Navigate to **Settings → Add-ons → Add-on Store** in Home Assistant
2. Click the menu (⋮) and select **Repositories**
3. Add this repository URL:
   ```
   https://github.com/arturonaredo/ha-addons
   ```
4. Click **Add** and close the dialog
5. Refresh the page - you should now see "VoltAssistant" in the add-on store
6. Click on VoltAssistant and install

## Requirements

- Home Assistant 2024.1 or later
- Inverter integration with sensors for:
  - Battery SOC
  - Battery/Grid/Load/Solar power
  - (Optional) PVPC price sensor

## Support

For issues and feature requests, please use [GitHub Issues](https://github.com/arturonaredo/ha-addons/issues).

## License

MIT License
