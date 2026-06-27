# 👥 Agents Workspace Configuration - HighTraffic project

> [!IMPORTANT]
> **ENTORNO DE EJECUCIÓN CRÍTICO**
> El entorno de pruebas y desarrollo local para este proyecto es **Windows + Docker Desktop** (WSL2).
> Sin embargo, el objetivo final, el diseño de la arquitectura y la compatibilidad de todos los servicios deben estar preparados para una **implementación directa nativa en servidores Linux**.

## ⚙️ Reglas de Comportamiento para Agentes de Codificación

Cualquier agente de IA que trabaje en este repositorio (incluyendo Claude, Gemini, GLM o asistentes futuros) debe adherirse estrictamente a las siguientes directivas:

1. **Monitoreo de Infraestructura**:
   - **Telegraf** es el recolector de métricas oficial del proyecto.
   - Las reglas de Prometheus en `alert.rules` se deben basar en las métricas de Telegraf (`docker_container_cpu_usage_percent` o similares) y no en métricas exclusivas de cAdvisor.

2. **Manejo del Autoscaler**:
   - El autoescalado se realiza mediante el webhook personalizado ubicado en `autoscaler/server.js`.
   - Se debe evitar el uso de librerías obsoletas (como *Orbiter*).
   - Cualquier cambio en los límites de escalado se debe parametrizar en el archivo `.env`.

3. **Ciclo de Despliegue en Swarm**:
   - Para redesplegar el stack en entornos locales, tener en cuenta que las redes de tipo `overlay` en Docker Desktop de Windows tardan varios segundos en liberarse tras un `docker stack rm`. Se debe dar un tiempo de espera (`Start-Sleep -Seconds 15`) antes de realizar un `docker stack deploy` sucesivo para evitar el error `network ht_net not found`.

4. **Persistencia de Aprendizaje**:
   - Las reglas técnicas de este proyecto se encuentran sincronizadas en el archivo de personalización global/local del agente.
