# 🛒 High Traffic Load Balancer (Optimizado con Caché y Colas)

Simulación de un problema real de producción y su solución mediante escalado horizontal, procesamiento asíncrono y almacenamiento en caché.

Este proyecto demuestra cómo una arquitectura tradicional saturada puede optimizarse utilizando contenedores, un balanceador de carga, desacoplamiento por colas de mensajería (**RabbitMQ**) y almacenamiento en caché en memoria (**Redis**).

---

# 🚨 Problema Inicial

Durante picos de alta demanda, las aplicaciones tradicionales con una sola instancia experimentan:

- Saturación del hilo principal (Event Loop) y la CPU.
- Retrasos acumulativos por encolamiento de sockets (latencia de respuesta alta).
- Errores de Timeout (502 / 504 Bad Gateway).
- Colapso del servicio ante picos de tráfico.

---

# ✅ Solución Arquitectónica

La solución actual de este proyecto combina:

- **Traefik (v2.11)**: Balanceador de carga y proxy inverso con descubrimiento dinámico de servicios.
- **Node.js + Express (API)**: Varias réplicas stateless que responden de inmediato (200 OK si el dato está en caché, o 202 Accepted si se encola la tarea).
- **RabbitMQ**: Cola de mensajería (AMQP) para delegar y procesar tareas lentas de fondo de forma asíncrona.
- **Redis (v7)**: Capa de caché en memoria de alta velocidad (TTL de 10s) que intercepta peticiones repetitivas evitando sobrecargar al backend.
- **Graceful Shutdown**: Mecanismo que asegura que los contenedores procesen las peticiones activas y liberen conexiones de red de forma limpia al detenerse o desescalarse.

---

# 🏗️ Arquitectura del Sistema

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

# ⚙️ Tecnologías Utilizadas

- **Node.js** & **Express**
- **Docker** & **Docker Compose**
- **Traefik** (Load Balancer & Reverse Proxy)
- **Redis** (Caching)
- **RabbitMQ** (Message Broker)
- **k6** (Pruebas de Estrés)

---

# 📦 Estructura del Proyecto

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

# 🚀 Cómo Ejecutar el Proyecto

## 1) Levantar múltiples instancias

Desde la raíz del proyecto, levanta todo el stack escalando la API a 10 réplicas:

```bash
docker compose up --build --scale api=10 -d
```

---

## 2) 🌐 Accesos Locales

### Aplicación (API)

```text
http://localhost
```

### Dashboard de Traefik (Estado de Réplicas)

```text
http://localhost:8081
```

### Dashboard de RabbitMQ (Monitoreo de Colas)

```text
http://localhost:15672
(Usuario: guest | Contraseña: guest)
```

---

## 3) 📈 Ejecutar Stress Test (k6)

Para iniciar la simulación de carga masiva de usuarios en Windows con k6:

```bash
k6 run stress.js
```

---

# 🔥 Escenario Simulado y Flujo Lógico

1. **Cache Miss & Enqueue (202 Accepted)**:
   Cuando entra una petición a la API y el resultado no está en caché, la API publica la tarea en la cola de RabbitMQ y responde instantáneamente al cliente con un `202 Accepted`.
2. **Procesamiento en Segundo Plano (Worker)**:
   El worker recibe la tarea de la cola, realiza el procesamiento pesado (simulación de 2 segundos) y guarda el resultado procesado en Redis con un TTL (tiempo de vida) de 10 segundos.
3. **Cache Hit (200 OK)**:
   Cualquier petición subsiguiente dentro del margen de 10 segundos de expiración recibirá de forma instantánea el resultado procesado desde la caché de Redis (`200 OK` en ~5ms) sin encolar ni sobrecargar el sistema.
