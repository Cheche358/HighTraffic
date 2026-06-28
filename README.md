<p align="center">
  <img src="./banner.png" width="800" alt="High Traffic Light Banner" />
</p>

<h1 align="center">🚀 High Traffic Light</h1>

<p align="center">
  Solucion de escalado horizontal self-hosted para un único servidor, que maximiza la capacidad y la elasticidad de esa instancia con réplicas dinámicas, balanceo, caché y colas sin la complejidad ni el overhead de Kubernetes.
</p>

<p align="center">
  <a href="https://nodejs.org/" target="_blank"><img src="https://img.shields.io/badge/node.js-6DA55F?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://expressjs.com/" target="_blank"><img src="https://img.shields.io/badge/express.js-%23404d59.svg?style=flat-square&logo=express&logoColor=%2361DAFB" alt="Express" /></a>
  <a href="https://www.docker.com/" target="_blank"><img src="https://img.shields.io/badge/docker-%230db7ed.svg?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="https://traefik.io/" target="_blank"><img src="https://img.shields.io/badge/traefik-%2324A1C1.svg?style=flat-square&logo=traefik&logoColor=white" alt="Traefik" /></a>
  <a href="https://redis.io/" target="_blank"><img src="https://img.shields.io/badge/redis-%23DD0031.svg?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
  <a href="https://www.rabbitmq.com/" target="_blank"><img src="https://img.shields.io/badge/rabbitmq-%23FF6600.svg?style=flat-square&logo=rabbitmq&logoColor=white" alt="RabbitMQ" /></a>
  <a href="https://k6.io/" target="_blank"><img src="https://img.shields.io/badge/k6-%237F583F.svg?style=flat-square&logo=k6&logoColor=white" alt="k6" /></a>
</p>

---

## 🚨 El Problema: Cuellos de Botella en Producción

Durante picos de alta demanda las aplicaciones web tradicionales con una sola instancia experimentan graves problemas de escalabilidad:

- **Saturación del Event Loop**: La CPU se satura procesando peticiones complejas o bloqueos de E/S.
- **Encolamiento de Sockets**: Las solicitudes entrantes se encolan a nivel de red, incrementando drásticamente el tiempo de respuesta.
- **Caída de Conexiones**: Aparecen timeouts y errores críticos del servidor (502 / 504 Bad Gateway).

---

## ⚡ La Solución: Arquitectura Escalada y Desacoplada

Este proyecto trata de solventar estos cuellos de botella mediante una arquitectura moderna y elástica de microservicios:

- **Balanceo Dinámico con Traefik**: Traefik escucha el socket de Docker para autodetectar nuevas réplicas en caliente, distribuyendo el tráfico web a través de un esquema Round-Robin.
- **Stateless APIs (Express)**: Las réplicas del backend no almacenan estado en memoria local, lo que les permite crearse y destruirse dinámicamente de forma transparente para los clientes.
- **Desacoplamiento con RabbitMQ**: Los procesos costosos son despachados asíncronamente como mensajes en una cola de RabbitMQ y resueltos por workers en segundo plano.
- **Capa de Caché Inteligente con Redis**: Las peticiones redundantes son interceptadas y respondidas de inmediato por la memoria caché con un TTL (Time to Live) controlado, evitando consultas costosas repetitivas.
- **Apagado Ordenado (Graceful Shutdown)**: Captura de señales SIGTERM/SIGINT para garantizar el procesamiento de peticiones en curso y liberar conexiones del backend antes del apagado.

---

## 🏗️ Arquitectura de Flujo

```text
                       ┌─────────────────┐
                       │     Traefik     │ (Port 80)
                       │  Load Balancer  │
                       └───────┬─────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
             API-1          API-2          API-N (Port 3000)
             (Server)       (Server)       (Server)
                │              │              │
                ├──────────────┴──────────────┤
                ▼                             ▼
         ┌──────────────┐              ┌──────────────┐
         │    Redis     │              │   RabbitMQ   │
         │ (Cache Layer)│              │ (Task Queue) │
         └──────▲───────┘              └──────┬───────┘
                │                             │
                └──────────────┬──────────────┘
                               ▼
                        Worker Integrado
```

---

## 📦 Estructura del Proyecto

```text
HighTraffic/
│
├── app/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js        # Servidor Express, Worker y Cierre Ordenado
│
├── autoscaler/
│   ├── Dockerfile
│   └── server.js        # Webhook de autoescalado (Alertmanager → docker service scale)
│
├── telegraf/
│   └── telegraf.conf    # Recolector de métricas (Docker API → Prometheus)
│
├── prometheus/
│   ├── alert.rules      # Reglas de alerta CPU > 70% / < 25%
│   └── prometheus.yml
│
├── alertmanager/
│   └── alertmanager.yml  # Webhook apunta a http://autoscaler:9099/webhook
│
├── traefik/
│   └── traefik.yml      # Configuración de Entrypoints y API
│
├── docker-compose.yaml  # Orquestación de API, Redis, RabbitMQ y Traefik
├── stress.js            # Script de pruebas de carga con k6
└── README.md
```

---

## 🚀 Guía de Uso Rápido (Despliegue con Docker Swarm)

### 1. Iniciar el Clúster de Swarm y Desplegar la Pila

Sigue estos pasos en tu terminal para inicializar el clúster local y desplegar los servicios:

```bash
# A) Inicializar Docker Swarm (solo se requiere hacer una vez)
docker swarm init

# B) Compilar la imagen local del backend
docker compose build

# C) Desplegar el stack en Swarm (Traefik, Redis, RabbitMQ y APIs)
docker stack deploy -c docker-compose.yaml hightraffic
```

### 2. Escalar el Backend Dinámicamente

Puedes modificar la cantidad de réplicas de la API en caliente sin reiniciar los demás servicios:

```bash
docker service scale hightraffic_api=10
```

### 3. Remover el clúster de servicios

Para detener la pila y limpiar los contenedores:

```bash
docker stack rm hightraffic
```

### 2. Panel de Control y URLs Locales

- **Endpoint del Servidor**: [http://localhost](http://localhost)
- **Web Panel de Control**: [http://localhost:9099](http://localhost:9099) (Panel unificado de monitoreo y escalado)
- **Dashboard de Traefik**: [http://localhost:8081](http://localhost:8081)
- **Panel de RabbitMQ**: [http://localhost:15672](http://localhost:15672) (Usuario: `guest` / Contraseña: `guest`)

### 3. Ejecutar Prueba de Estrés (k6)

El script `stress.js` simula una avalancha de usuarios concurrentes contra el endpoint público (`http://127.0.0.1`, puerto 80) para forzar el autoescalado y validar el comportamiento elástico del clúster.

**¿Qué hace el test?**

- **Curva de carga en 3 etapas**: rampa de subida hasta el máximo de VUs (usuarios virtuales), sostiene la carga para disparar el escalado y, finalmente, rampa de bajada. Los valores se ajustan en `stress.js` → `options.stages`.
- **Tráfico mixto 50/50**: la mitad de las peticiones usan `?nocache=` (fuerzan un *cache miss* → respuesta `202 Accepted` y encolamiento en RabbitMQ) y la otra mitad van a la URL plana `/` (resuelven desde caché → `200 OK`). Esto reproduce tráfico realista de usuarios nuevos vs. recurrentes.
- **Lotes por iteración**: cada iteración envía 2 peticiones concurrentes, maximizando el RPS del host.
- **Validación automática**: verifica que cada respuesta sea `200` (cache hit) o `202` (encolada), y marca el test como fallido si la tasa de errores supera el umbral configurado (`http_req_failed`).

Para iniciar la simulación:

```bash
k6 run stress.js
```

Durante la ejecución puedes observar en el [Web Panel](http://localhost:9099) cómo suben las réplicas, el consumo de CPU, el tráfico de red de Traefik y el crecimiento de la cola de RabbitMQ.

> **Nota:** si vas a lanzar el test desde Windows (Docker Desktop), ajusta el `target` de VUs a un valor moderado (ej. 300-600) para no saturar el daemon local. Consulta las recomendaciones por hardware en el [DEPLOYMENT.md](file:///d:/Users/windows/Proyectos/HighTraffic/DEPLOYMENT.md).

---

## 🔄 Flujo Lógico y Ciclo de Vida de Peticiones

1. **Cache Miss & Enqueue (202 Accepted)**:
   Al entrar una solicitud a la API, si el resultado no se encuentra en Redis, el servidor publica la tarea en la cola de RabbitMQ y responde al cliente de inmediato con un estado `202 Accepted`.
2. **Procesamiento de Worker**:
   El worker integrado consume la tarea desde RabbitMQ, realiza el procesamiento simulado de 2 segundos, y escribe el resultado final en Redis con un TTL de 10 segundos.
3. **Cache Hit (200 OK)**:
   Las peticiones idénticas enviadas en el rango de los 10 segundos de la caché son capturadas por Redis y respondidas en milisegundos (`200 OK`), descargando de procesamiento al backend y a la cola.

## 📈 Autoescalado Dinámico y Elástico (Estilo Kubernetes en Swarm)

Para responder de manera inteligente ante picos inesperados de tráfico sin desperdiciar recursos de hardware, hemos diseñado e implementado una arquitectura de **Autoescalado Dinámico Automatizado** combinando **Telegraf**, **Prometheus**, **Alertmanager** y un **Autoscaler Webhook** ligero (servicio Node.js propio que ejecuta `docker service scale` directamente sobre el socket de Docker).

### Cualidades y Características Clave

1. **Parametrización por Entorno (Zero Hardcoding)**:
   Todos los límites de réplicas y políticas de escala se configuran mediante el archivo [.env](file:///d:/Users/windows/Proyectos/HighTraffic/.env). Esto permite ajustar el comportamiento del clúster en segundos sin modificar el archivo de infraestructura.

2. **Detección Rápida de Sobrecarga (Scale Up)**:
   Si el uso de CPU promedio de los contenedores de la API supera el **70%** durante un intervalo continuo de **30 segundos**, el clúster escalará el servicio de inmediato sumando `SCALE_UP_BY` réplicas adicionales para absorber la carga.

3. **Prevención Estricta de Flapping (Políticas de Estabilización)**:
   - **Retardo Asimétrico**: Para evitar el apagado y encendido continuo de contenedores ("flapping"), el desescalado es sumamente cauteloso. Solo se reduce el número de réplicas si el consumo de CPU cae por debajo del **25%** de forma continua durante **5 minutos**.
   - **Tiempo de Enfriamiento (Cooldown)**: Después de cualquier escalado en caliente, el Autoscaler ignora nuevas alertas durante un período definido por `SCALE_COOLDOWN` (default: `120s`), permitiendo que el clúster distribuya el tráfico y estabilice las conexiones.
   - **Suelo de Alta Disponibilidad**: La infraestructura garantiza un mínimo de `API_REPLICAS_MIN` (5 réplicas) en ejecución en todo momento, asegurando tolerancia a fallos básica estable.

4. **Monitoreo en Tiempo Real**:
   El stack incluye paneles de visualización para depurar y optimizar el rendimiento:
   - **Prometheus** (Puerto `9090`): Para evaluar las métricas de consumo de CPU y estados de las alertas.
   - **Alertmanager** (Puerto `9093`): Para rastrear la entrega de notificaciones de escala al autoscaler.
   - **Telegraf** (Puerto `9273`): Recolector de métricas de contenedores; expone `/metrics` en formato Prometheus.
   - **Autoscaler Webhook** (Puerto `9099`): Endpoints de diagnóstico — `GET /health` (estado del servicio y réplicas actuales) y `POST /scale/up|down` (escalado manual).

---

## 🖥️ Web Panel de Control y Monitoreo

El proyecto incluye un **panel web unificado** (servido por el propio Autoscaler en el puerto `9099`) que centraliza la observabilidad y el control del clúster en una sola interfaz, sin necesidad de herramientas externas. Se actualiza automáticamente cada 3 segundos y está diseñado para seguir siendo legible incluso bajo carga extrema.

### Características y Bondades

1. **Tarjetas de Métricas Globales**:
   - **Réplicas del Servicio**: instancias activas vs. límite máximo configurado.
   - **CPU Promedio**: uso real de CPU expresado como **% del host** (normalizado por núcleos), veraz y coherente entre el card superior, el gráfico y los contenedores individuales.
   - **Tránsito de Red (Traefik)**: throughput del gateway en `KB/s` medido en tiempo real.

2. **Histórico de Carga de CPU**: gráfico de líneas en vivo (Chart.js) con la evolución del consumo, útil para visualizar picos y la respuesta del autoescalado.

3. **Visor de Contenedores por Réplica**:
   - Cards individuales para cada **réplica de la API** y cada **módulo de sistema** (Traefik, Redis, RabbitMQ, Prometheus, Alertmanager, Telegraf, Autoscaler).
   - Barras de **CPU**, **memoria** (con referencia visual por servicio) y **tránsito de red I/O** (entrada/salida) por contenedor.
   - Modal de detalle con el nombre técnico (Swarm), ID e imagen de cada contenedor.

4. **Acciones de Escalado Manual**: botones para escalar (`+SCALE_UP_BY`) y desescalar (`-SCALE_DOWN_BY`) en caliente, con un **indicador visual de cooldown** (barra + cuenta regresiva) que refleja el estado real del autoscaler.

5. **Monitor de Colas de RabbitMQ**: mensajes totales, listos (ready), no confirmados (unacked) y tasas de entrada/salida por cola.

6. **Feed de Alertas Persistente**: historial de alertas de Alertmanager que **sobrevive a refrescos del navegador**, mostrando estado (activa/resuelta), severidad, resumen y marca temporal.

7. **Parámetros de Configuración (.env)**: visualización en vivo de los límites min/max y los pasos de escalado actuales.

8. **Resiliencia Operativa**: ante fallos transitorios del daemon de Docker bajo carga (respuestas vacías o caídas de `/api/metrics`), el panel **conserva el último estado renderizado** en lugar de parpadear con "sin contenedores", manteniendo la operación estable.

> El panel es totalmente **compatible con Windows (Docker Desktop) y Linux nativo**: todas sus métricas provienen de fuentes multiplataforma (`os.cpus()`, la API de Docker vía `docker stats` y Telegraf).

---

## ⚖️ Docker Swarm vs Kubernetes: Decisiones de DevOps

Esta arquitectura está diseñada para ser ágil y ligera (**"Light"**), utilizando **Docker Swarm**. A continuación se detalla la comparativa técnica para evaluar cuándo mantener este enfoque o migrar a Kubernetes:

| Característica            | Enfoque "Light" (Docker Swarm)                                                                    | Enfoque "Enterprise" (Kubernetes)                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------- |
| **Complejidad Base**      | **Extremadamente Baja**. Curva de aprendizaje mínima para desarrolladores.                        | **Alta**. Requiere un equipo o rol especializado de Platform / DevOps.                    |
| **Uso de Recursos (RAM)** | **Mínimo (~50MB)**. No consume casi recursos del sistema en reposo.                               | **Alto (~1.5GB a 2GB)** de consumo de base para el plano de control (Kubelet, API, etc.). |
| **Escalado Dinámico**     | **Automático y Elástico** (mediante Prometheus + Autoscaler Webhook con políticas anti-flapping). | **Automático y Reactivo** (HPA basado en CPU/RAM o longitud de colas con KEDA).           |
| **Health Checks**         | **Básico** (Verifica el estado del servicio en el host).                                          | **Avanzado** (Readiness/Liveness Probes, retira pods inestables de inmediato).            |
| **Entornos**              | Excelente para servidores dedicados individuales o clústeres pequeños-medianos.                   | Estándar para nubes públicas multi-nodo con servicios gestionados (EKS, GKE, AKS).        |

### Conclusión de Implementación

El enfoque **High Traffic Light** con Docker Swarm es ideal para proyectos donde se busca el máximo rendimiento de hardware con el mínimo esfuerzo de administración. Al incorporar el autoescalado dinámico automatizado mediante un Autoscaler Webhook ligero y la parametrización por medio del archivo `.env`, se obtiene el balance perfecto: la simplicidad y el bajísimo consumo de recursos de Swarm junto con la elasticidad reactiva ante picos de demanda característica de Kubernetes.
