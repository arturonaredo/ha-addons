# Volt Load Manager

Gestión inteligente de batería y cargas para inversores Deye/Solarman con tarifas PVPC.

## Características

- **Optimización de carga por precio** - Carga automática cuando el precio es bajo
- **Periodos tarifarios** - Soporte para tarifas 2.0TD (punta/llano/valle)
- **Target SOC manual** - Override para forzar carga cuando quieras
- **Load shedding** - Apaga cargas automáticamente si superas la potencia contratada
- **Fines de semana** - Opción para mantener batería al 100%

---

## Configuración

### Inversor

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| `max_power` | Potencia máxima del inversor (W) | 6000 |
| `battery_capacity_kwh` | Capacidad de la batería (kWh) | 32.6 |
| `battery_min_soc` | SOC mínimo de seguridad (%) | 10 |
| `battery_max_soc` | SOC máximo (%) | 100 |

### Sensores

Entidades de Home Assistant para leer el estado del inversor:

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| `battery_soc` | SOC de la batería | `sensor.predbat_battery_soc_2` |
| `battery_power` | Potencia batería (W) | `sensor.inverter_battery_power` |
| `grid_power` | Potencia de red (W) | `sensor.inverter_grid_power` |
| `load_power` | Consumo total (W) | `sensor.inverter_load_power` |
| `pv_power` | Producción solar (W) | `sensor.inverter_pv_power` |
| `pvpc_price` | Precio PVPC actual | `sensor.esios_pvpc_octopus3` |
| `tariff_period` | Periodo tarifario | `sensor.predbat_periodo_potencia` |

### Controles

Entidades para controlar el inversor:

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| `program_1_soc` | SOC objetivo programa 1 | `number.inverter_program_1_soc` |
| `grid_charge_start_soc` | Iniciar carga de red | `number.inverter_battery_grid_charging_start` |

### Periodos tarifarios (2.0TD)

Configura la potencia contratada y comportamiento por periodo:

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

### Optimización de batería

```yaml
battery_optimization:
  enabled: true
  min_soc: 10                      # Nunca bajar de esto
  default_target_soc: 80           # Target por defecto
  always_charge_below_price: 0.05  # Cargar siempre si precio < 0.05€
  never_charge_above_price: 0.15   # No cargar si precio > 0.15€
  keep_full_weekends: true         # 100% en fines de semana
```

### Cargas controlables

Lista de cargas que el sistema puede apagar si hay sobrecarga:

```yaml
loads:
  - id: calefaccion
    name: "Calefacción"
    priority: comfort              # essential | comfort | accessory
    power_sensor: "sensor.energy_meter_calefaccion_potencia_de_la_fase_a"
    switch_entity: "switch.energy_meter_calefaccion_interruptor"
    max_power: 3000
```

**Prioridades:**
- `essential` - Nunca se apaga
- `comfort` - Se apaga si las accessory no son suficientes
- `accessory` - Primero en apagarse

---

## Panel de control

El addon añade **"Volt Load Manager"** al menú lateral de Home Assistant.

### Funciones del panel:

- **SOC actual** con barra de progreso y marcador de target
- **Target manual** - Introduce un % y pulsa "Aplicar" para forzar carga
- **Botón Auto** - Vuelve al modo automático
- **Periodo tarifario** - Muestra valle/llano/punta activo
- **Estado de cargas** - Muestra cargas activas y apagadas
- **Balancear** - Ejecuta balance manual
- **Restaurar** - Enciende todas las cargas apagadas

---

## API

### Estado
```
GET /api/status
```

### Target manual
```bash
# Poner target al 100%
POST /api/target
{"soc": 100}

# Volver a automático
DELETE /api/target
```

### Balance de cargas
```
POST /api/balance
POST /api/restore
```

### Aplicar decisión de carga
```
POST /api/apply
```

---

## Lógica de decisión

El sistema decide cuándo cargar siguiendo esta prioridad:

1. **Target manual** → Si hay override activo, usa ese valor
2. **Fin de semana** → Si `keep_full_weekends: true`, target 100%
3. **Precio muy bajo** → Si precio < `always_charge_below_price`, target 100%
4. **Precio muy alto** → Si precio > `never_charge_above_price`, no cargar
5. **Precio intermedio** → Target proporcional al precio
6. **Periodo tarifario** → Usa el target del periodo actual

---

## Troubleshooting

### El inversor no carga
- Verifica que `switch.inverter_battery_grid_charging` está ON en HA
- Comprueba que `select.inverter_program_1_charging` está en "Grid"
- Revisa los logs del addon

### Las cargas no se apagan
- Verifica que `load_manager.enabled: true`
- Comprueba que las entidades `switch_entity` existen y funcionan
- El sistema solo apaga cargas `comfort` y `accessory`, nunca `essential`

### El precio no se lee
- Verifica que tienes configurada la integración PVPC/ESIOS
- Comprueba el sensor `sensor.esios_pvpc_octopus3` en HA
