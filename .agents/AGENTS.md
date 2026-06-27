# Project Rules - HighTraffic Workspace

> [!IMPORTANT]
> **ENTORNO DE EJECUCIÓN CRÍTICO**
> El entorno de pruebas y desarrollo local para este proyecto es **Windows + Docker Desktop** (WSL2).
> Sin embargo, el objetivo final, el diseño de la arquitectura y la compatibilidad de todos los servicios deben estar preparados para una **implementación directa nativa en servidores Linux**.

## Guidelines

- **Recolección de Métricas**: Utilizar exclusivamente **Telegraf** para la obtención de métricas del Docker Engine en formato Prometheus. No usar cAdvisor debido a incompatibilidades con cgroups v2 en Docker Desktop.
- **Alertas de Prometheus**: Asegurarse de que las expresiones PromQL de `prometheus/alert.rules` consuman métricas expuestas por Telegraf (tales como `docker_container_cpu_usage_percent` y `docker_container_mem_usage_percent`), no de cAdvisor.
- **Autoscaler**: El autoescalado se gestiona de forma nativa a través del webhook de Node.js en `autoscaler/server.js`. Bajo ningún concepto sugerir el uso de *Orbiter*.
- **Configuración Limpia**: Todos los límites de escala, cooldowns y puertos se leen desde el archivo `.env`. Queda prohibido hardcodear estos valores.
- **Despliegues en Swarm**: Dar un retardo de al menos 15 a 20 segundos tras borrar el stack (`docker stack rm`) antes de redesplegar, para permitir que la red virtual overlay se libere por completo en Docker Desktop Windows.
