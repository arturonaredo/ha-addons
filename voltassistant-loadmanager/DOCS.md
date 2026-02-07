# Volt Load Manager

Smart battery and load management for Deye/Solarman inverters with PVPC tariffs.

## Features

- **Price-based charging** - Automatically charge when electricity is cheap
- **Tariff periods** - Full support for Spanish 2.0TD tariffs (punta/llano/valle)
- **Manual SOC target** - Override automatic decisions when needed
- **Load shedding** - Automatically turn off loads to prevent exceeding contracted power
- **Weekend mode** - Option to keep battery at 100% during weekends

---

## Configuration

### Inverter

| Field | Description | Example |
|-------|-------------|---------|
| `max_power` | Maximum inverter output (W) | 6000 |
| `battery_capacity_kwh` | Total battery capacity (kWh) | 32.6 |
| `battery_min_soc` | Safety floor SOC (%) | 10 |
| `battery_max_soc` | Maximum SOC (%) | 100 |

### Sensors

Home Assistant entities to read inverter state:

| Field | Description | Example |
|-------|-------------|---------|
| `battery_soc` | Battery state of charge | `sensor.inverter_battery_soc` |
| `battery_power` | Battery power (W) | `sensor.inverter_battery_power` |
| `grid_power` | Grid power (W) | `sensor.inverter_grid_power` |
| `load_power` | Total consumption (W) | `sensor.inverter_load_power` |
| `pv_power` | Solar production (W) | `sensor.inverter_pv_power` |
| `pvpc_price` | Current PVPC price | `sensor.esios_pvpc` |
| `tariff_period` | Current tariff period | `sensor.predbat_periodo_potencia` |

### Controls

Entities to control the inverter:

| Field | Description | Example |
|-------|-------------|---------|
| `program_1_soc` | Program 1 SOC target | `number.inverter_program_1_soc` |
| `grid_charge_start_soc` | Grid charge trigger | `number.inverter_battery_grid_charging_start` |

### Tariff Periods (2.0TD)

Configure contracted power and behavior per period:

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
  min_soc: 10                      # Never go below this
  default_target_soc: 80           # Default target
  always_charge_below_price: 0.05  # Always charge if price < €0.05
  never_charge_above_price: 0.15   # Never charge if price > €0.15
  keep_full_weekends: true         # 100% on weekends
```

### Controllable Loads

List of loads that can be turned off during overload:

```yaml
loads:
  - id: heating
    name: "Heating"
    priority: comfort              # essential | comfort | accessory
    power_sensor: "sensor.heating_power"
    switch_entity: "switch.heating"
    max_power: 3000
```

**Priorities:**
- `essential` - Never turned off
- `comfort` - Turned off if accessory loads aren't enough
- `accessory` - First to be turned off

---

## Control Panel

The addon adds **"Volt Load Manager"** to the Home Assistant sidebar.

### Panel Features:

- **Current SOC** with progress bar and target marker
- **Manual target** - Enter a % and click "Apply" to force charging
- **Auto button** - Return to automatic mode
- **Tariff period** - Shows active valle/llano/punta
- **Load status** - Shows active and shed loads
- **Balance** - Manually trigger load balancing
- **Restore** - Turn all shed loads back on

---

## API

### Status
```
GET /api/status
```

### Manual Target
```bash
# Set target to 100%
POST /api/target
{"soc": 100}

# Return to automatic
DELETE /api/target
```

### Load Balancing
```
POST /api/balance
POST /api/restore
```

### Apply Charging Decision
```
POST /api/apply
```

---

## Decision Logic

The system decides when to charge following this priority:

1. **Manual target** → If override is active, use that value
2. **Weekend** → If `keep_full_weekends: true`, target 100%
3. **Very low price** → If price < `always_charge_below_price`, target 100%
4. **Very high price** → If price > `never_charge_above_price`, don't charge
5. **Mid-range price** → Proportional target based on price
6. **Tariff period** → Use the period's configured target

---

## Troubleshooting

### Inverter won't charge
- Verify `switch.inverter_battery_grid_charging` is ON in HA
- Check `select.inverter_program_1_charging` is set to "Grid"
- Review addon logs

### Loads not shedding
- Verify `load_manager.enabled: true`
- Check that `switch_entity` values exist and work
- Only `comfort` and `accessory` loads are shed, never `essential`

### Price not reading
- Verify you have the PVPC/ESIOS integration configured
- Check the price sensor exists in HA Developer Tools
