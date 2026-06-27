# 🤖 Gemini Workspace Guide - HighTraffic project

> [!IMPORTANT]
> **ENTORNO DE EJECUCIÓN CRÍTICO**
> El entorno de pruebas y desarrollo local para este proyecto es **Windows + Docker Desktop** (WSL2).
> Sin embargo, el objetivo final, el diseño de la arquitectura y la compatibilidad de todos los servicios deben estar preparados para una **implementación directa nativa en servidores Linux**.

## 📋 Directrices Generales de Desarrollo

1. **Evitar Herramientas Obsoletas o Abandonadas**:
   - Queda estrictamente prohibido el uso de proyectos sin mantenimiento (como *Orbiter*).
   - Priorizar siempre arquitecturas basadas en estándares modernos de la industria (como la combinación de **Telegraf + Alertmanager + Webhook Autoscaler personalizado**).

2. **Cero Variables Hardcodeadas**:
   - Todos los parámetros de configuración (réplicas mínimas, máximas, cooldown, puertos, nombres de servicios) se deben declarar en el archivo `.env` en la raíz del proyecto.
   - El archivo `docker-compose.yaml` y los servicios asociados deben utilizar estas variables a través de interpolación.

3. **Arquitectura Multiplataforma**:
   - Las herramientas de monitoreo y recolección de métricas no deben depender de llamadas exclusivas del kernel de Linux que puedan fallar en Docker Desktop (por ejemplo, accesos directos a `/sys/fs/cgroup` como hace cAdvisor).
   - Se debe utilizar **Telegraf** como recolector de métricas universal para comunicarse con la Docker API de forma multiplataforma.

4. **Estabilidad y Mitigación de Flapping**:
   - Toda regla de autoscaling debe contar con márgenes de histéresis y amortiguación adecuados (cooldowns parametrizados, tiempos de espera prudenciales en Alertmanager y validación de réplicas límites en el webhook de escala).
