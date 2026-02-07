# VoltAssistant Load Manager

Gestión inteligente de cargas para evitar sobrecargar tu inversor.

## Configuración

### Potencia máxima del inversor
La potencia máxima que puede entregar tu inversor (en vatios). Por defecto 6000W para Deye SUN-6K-EU.

### Margen de seguridad
Porcentaje de margen antes de empezar a apagar cargas. Con 10%, empezará a actuar cuando llegues al 90% de la potencia máxima.

### Intervalo de comprobación
Cada cuántos segundos comprueba el estado de las cargas.

### Cargas

Cada carga tiene:

| Campo | Descripción |
|-------|-------------|
| **id** | Identificador único (ej: `ev-charger`) |
| **name** | Nombre descriptivo (ej: `Cargador EV`) |
| **priority** | `essential` (nunca apagar), `comfort` (reducir si hace falta), `accessory` (primero en apagar) |
| **power_sensor** | Sensor de potencia en HA (ej: `sensor.ev_charger_power`) |
| **switch_entity** | Interruptor para controlar (ej: `switch.ev_charger`) |
| **max_power** | Potencia máxima esperada en vatios |

## Prioridades

1. **Essential** - Nunca se apagan (frigorífico, router, etc.)
2. **Comfort** - Se apagan si las accessory no son suficientes
3. **Accessory** - Primero en apagarse (cargador EV, deshumidificador, etc.)

## Funcionamiento

1. Lee la potencia actual de todas las cargas
2. Si supera el límite, apaga cargas empezando por las `accessory`
3. Cuando hay margen, restaura automáticamente las cargas apagadas
