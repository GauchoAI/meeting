# Simulación — Reporte de ventas de AI Agent (Dashboard CEO)

## Reporte en vivo
**Fecha:** 2026-05-25 (simulación)  
**Hora de corte:** 00:20  
**Responsable:** Jefe de ventas (visión de equipo)

## KPIs del día (visión de equipo)

| KPI | Valor | Semáforo |
|---|---:|---|
| Tráfico a página | 280 visitas | 🟢 |
| Intenciones de compra detectadas | 210 | 🟢 |
| Leads contactados | 210 | 🟢 |
| Respuestas | 158 (75%) | 🟢 |
| Ventas generadas | 12 conversiones | 🟢 |
| Ingresos | USD 4,800 | 🟢 |
| Efectividad comercial | 5.7% | 🟡 |

## What matters today
- El tráfico y la intención están fuertes.  
- La caída ocurre en el tramo de cierre.
- Prioridad ejecutiva: mantener volumen y aumentar tasa de conversión final.

## Estados del funnel (importantes)
- **Tráfico total (sesiones):** 280
- **Intención de compra detectada:** 210 (74.6% del tráfico)
- **Leads contactados:** 210
- **Respuestas:** 158
- **Ventas:** 12

## Seguimiento por empleado / agente
- **Objetivo de gestión:** el jefe debe ver desempeño individual, no solo de un agente único.
- **Tabla de ejemplo (hoy):**

| Empleado | Leads nuevos | Contactados | Respondidos | Ventas | Efectividad | Estado |
|---|---:|---:|---:|---:|---:|---|
| AI Agent | 210 | 210 | 158 | 12 | 5.7% | 🟡 |
| (Ej. Agente 2) | — | — | — | — | — | ⏳ |

## Checklist operativo por liderazgo
- [ ] Revisar leads sin seguimiento (D+1, D+2, D+3) por empleado.
- [ ] Asignar leads “calientes” a quienes cierren mejor.
- [ ] Detectar coaching: baja conversión individual con buena actividad de contacto.
- [ ] Definir meta de seguimiento semanal por persona (contactos y cierres).

## Comparativa semanal (vs semana anterior)
- **Indicador base:** usa estos mismos KPIs y los mismos empleados.
- **Semáforo W/W (a completar):** 
  - Tráfico: [▲ / ▼ / →]
  - Intenciones: [▲ / ▼ / →]
  - Respuesta: [▲ / ▼ / →]
  - Efectividad comercial: [▲ / ▼ / →]
- **Lectura de tendencia:** si el tráfico sube y la tasa de cierre baja, priorizar calidad de mensaje y seguimiento.
- **Próximo paso:** cargar semana anterior para calcular deltas exactos.

## Fórmulas de control
- **Tasa de intención** = (Intenciones detectadas ÷ Tráfico a página) × 100
- **Tasa de respuesta** = (Respuestas ÷ Leads contactados) × 100
- **Efectividad comercial** = (Ventas ÷ Leads contactados) × 100
- **Tasa de conversión por vendedor** = (Ventas por empleado ÷ Leads contactados por empleado) × 100

## Confiabilidad operacional
- **Uso de GPU observado:** 90% (cerca del umbral crítico).
- Semáforo: 🟠 Si supera 85% sostenido 3+ minutos, activar plan de degradación:
  - modo texto corto
  - bajar frecuencia de inferencia no crítica
  - reintento controlado y cola priorizada
- **Síntoma reportado:** un único usuario está provocando renderizado continuo de artefactos (re-render repetitivo), elevando carga.
- **Acción correctiva sugerida (inmediata):**
  - cachear/validar cambios por `content-hash` antes de render
  - aplicar `debounce` a re-render por sesión (ej. 2–3 s)
  - limitar tasa de render por usuario/session (ratelimit)
  - activar “modo estático” para ese usuario hasta estabilización

## Estado
*Actualización en vivo de la simulación para revisión ejecutiva de equipo.*