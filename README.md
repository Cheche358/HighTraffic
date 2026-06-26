<p align="center">
  <img src="./banner.png" width="800" alt="High Traffic Light Banner" />
</p>

<h1 align="center">🚀 High Traffic Light</h1>

<p align="center">
  Simulación de un problema real de producción y su resolución mediante escalado horizontal, procesamiento asíncrono y almacenamiento en caché de alta velocidad.
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

Durante picos de alta demanda (como Black Friday, venta de entradas o eventos masivos), las aplicaciones web tradicionales con una sola instancia experimentan graves problemas de escalabilidad:

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
- **Dashboard de Traefik**: [http://localhost:8081](http://localhost:8081)
- **Panel de RabbitMQ**: [http://localhost:15672](http://localhost:15672) (Usuario: `guest` / Contraseña: `guest`)

### 3. Ejecutar Prueba de Estrés (k6)

Para iniciar la simulación de carga masiva de usuarios concurrentes:

```bash
k6 run stress.js
```

---

## 🔄 Flujo Lógico y Ciclo de Vida de Peticiones

1. **Cache Miss & Enqueue (202 Accepted)**:
   Al entrar una solicitud a la API, si el resultado no se encuentra en Redis, el servidor publica la tarea en la cola de RabbitMQ y responde al cliente de inmediato con un estado `202 Accepted`.
2. **Procesamiento de Worker**:
   El worker integrado consume la tarea desde RabbitMQ, realiza el procesamiento simulado de 2 segundos, y escribe el resultado final en Redis con un TTL de 10 segundos.
3. **Cache Hit (200 OK)**:
   Las peticiones idénticas enviadas en el rango de los 10 segundos de la caché son capturadas por Redis y respondidas en milisegundos (`200 OK`), descargando de procesamiento al backend y a la cola.

---

## ⚖️ Docker Swarm vs Kubernetes: Decisiones de DevOps

Esta arquitectura está diseñada para ser ágil y ligera (**"Light"**), utilizando **Docker Swarm**. A continuación se detalla la comparativa técnica para evaluar cuándo mantener este enfoque o migrar a Kubernetes:

| Característica            | Enfoque "Light" (Docker Swarm)                                                  | Enfoque "Enterprise" (Kubernetes)                                                         |
| :------------------------ | :------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------- |
| **Complejidad Base**      | **Extremadamente Baja**. Curva de aprendizaje mínima para desarrolladores.      | **Alta**. Requiere un equipo o rol especializado de Platform / DevOps.                    |
| **Uso de Recursos (RAM)** | **Mínimo (~50MB)**. No consume casi recursos del sistema en reposo.             | **Alto (~1.5GB a 2GB)** de consumo de base para el plano de control (Kubelet, API, etc.). |
| **Escalado Dinámico**     | **Manual/Semimanual** (`docker service scale`).                                 | **Automático y Reactivo** (HPA basado en longitud de colas con KEDA).                     |
| **Health Checks**         | **Básico** (Verifica el estado del servicio en el host).                        | **Avanzado** (Readiness/Liveness Probes, retira pods inestables de inmediato).            |
| **Entornos**              | Excelente para servidores dedicados individuales o clústeres pequeños-medianos. | Estándar para nubes públicas multi-nodo con servicios gestionados (EKS, GKE, AKS).        |

### Conclusión de Implementación

El enfoque **High Traffic Light** con Docker Swarm es ideal para proyectos donde se busca el máximo rendimiento de hardware con el mínimo esfuerzo de administración. Si las demandas de tráfico se vuelven altamente volátiles y requieren autoscaling reactivo automático en la nube, se recomienda migrar el stack hacia Kubernetes.
