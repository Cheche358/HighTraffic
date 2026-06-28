# 📘 Manual de Implementación y Despliegue en Arquitectura Horizontal

Este documento sirve como guía genérica de referencia para desarrolladores (Devs) y administradores de sistemas (DevOps) que requieran empaquetar, configurar y desplegar cualquier aplicación web dentro de un stack de escalado horizontal con balanceo de carga dinámico.

---

## 🗺️ 1. Principios de Diseño: Aplicaciones Stateless (Sin Estado)

Para que una aplicación pueda ejecutarse en múltiples instancias concurrentes (réplicas) de manera segura y transparente detrás de un balanceador de carga, debe cumplir con las directrices de una **12-Factor App**:

1. **Sin Estado Local (Stateless)**: Ningún contenedor debe almacenar archivos, imágenes subidas o sesiones en su disco local. Si un contenedor se destruye, los datos se pierden.
   - **Archivos/Media**: Deben guardarse en un almacenamiento persistente centralizado (ej. AWS S3, Google Cloud Storage, o MinIO).
   - **Sesiones de Usuario**: Deben centralizarse en una base de datos en memoria rápida como **Redis** para que cualquier réplica pueda validar la sesión.
2. **Configuración en el Entorno**: Las credenciales, puertos y direcciones IP de bases de datos no deben estar escritas en el código (hardcoded). Deben leerse dinámicamente a través de variables de entorno de la máquina.

---

## 📦 2. Paso 1: Containerización (Dockerfile)

Toda aplicación del stack debe poseer un `Dockerfile` en su directorio raíz para empaquetar la aplicación en una imagen inmutable.

### Plantilla Estándar del Dockerfile

```dockerfile
# 1. Imagen base optimizada y liviana
FROM node:22-alpine AS base

# 2. Configurar directorio de trabajo
WORKDIR /usr/src/app

# 3. Copiar manifiestos de dependencias primero (Aprovecha caché de capas de Docker)
COPY package*.json ./

# 4. Instalar solo dependencias necesarias para producción
RUN npm ci --only=production

# 5. Copiar el código fuente del proyecto
COPY . .

# 6. Definir variables y exponer el puerto interno de la aplicación
ENV PORT=3000
EXPOSE 3000

# 7. Ejecutar con permisos no-root por seguridad
USER node

# 8. Comando de arranque de la aplicación
CMD ["node", "server.js"]
```

_(Nota: Ajusta los comandos `npm` u otras dependencias para stacks como Python, Go, Java, PHP, etc., siguiendo el mismo patrón de caché de capas)._

---

## 🔌 3. Paso 2: Manejo de Conexiones y Variables de Entorno

Asegura que tu aplicación se conecte de forma dinámica a la infraestructura. A continuación se muestran ejemplos genéricos de inicialización de clientes:

### Ejemplo de Configuración Dinámica (JavaScript)

```javascript
// Leer puertos y URLs desde las variables definidas por el orquestador
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

// Lógica de reconexión/reintentos ante retraso de arranque de base de datos
async function connectWithRetry() {
  let connected = false;
  while (!connected) {
    try {
      await db.connect(DATABASE_URL);
      connected = true;
      console.log("Conectado a la base de datos con éxito.");
    } catch (err) {
      console.error(
        "Fallo al conectar a la DB, reintentando en 3 segundos...",
        err.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
```

---

## 🛑 4. Paso 3: Cierre Ordenado (Graceful Shutdown)

Cuando el balanceador escala hacia abajo (destruye instancias) o se actualiza la versión del código, el sistema operativo envía una señal de terminación (`SIGTERM`) al contenedor. La aplicación debe capturar esta señal para finalizar transacciones activas de forma segura.

### Implementación del Apagado Seguro

```javascript
function registerGracefulShutdown(server, dbConnection, cacheConnection) {
  const shutdown = async (signal) => {
    console.log(`Recibida señal ${signal}. Iniciando apagado seguro...`);

    // 1. Dejar de aceptar nuevas peticiones HTTP
    server.close(async () => {
      console.log("Servidor HTTP cerrado. Procesando peticiones restantes...");

      try {
        // 2. Cerrar pools de bases de datos
        if (dbConnection) await dbConnection.close();

        // 3. Cerrar conexiones de caché
        if (cacheConnection) await cacheConnection.disconnect();

        console.log("Apagado ordenado completo. Saliendo.");
        process.exit(0);
      } catch (err) {
        console.error("Error al cerrar recursos:", err.message);
        process.exit(1);
      }
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

---

## 🎛️ 5. Paso 4: Orquestación e Integración con Traefik (Docker Compose)

En la raíz del repositorio principal que engloba a tu aplicación, define el archivo `docker-compose.yaml`. Este archivo levanta el balanceador de carga Traefik, tu aplicación parametrizada y los servicios de soporte.

### Plantilla Genérica de `docker-compose.yaml`

```yaml
services:
  # 1. Reverse Proxy & Load Balancer
  traefik:
    image: traefik:v2.11
    ports:
      - "80:80" # Puerto público HTTP de tu sistema
      - "8081:8080" # Puerto de acceso al Dashboard de administración
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/traefik.yml:/etc/traefik/traefik.yml:ro

  # 2. Almacenamiento en Caché y Sesiones Compartidas
  cache:
    image: redis:7-alpine

  # 3. Base de Datos del Sistema (Ejemplo PostgreSQL)
  database:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=app_db
      - POSTGRES_USER=admin_user
      - POSTGRES_PASSWORD=secure_pass
    volumes:
      - db_data:/var/lib/postgresql/data

  # 4. Tu Aplicación Web Replicada
  web-app:
    build:
      context: ./path-to-app-source # Ubicación del Dockerfile
    environment:
      - PORT=3000
      - DATABASE_URL=postgres://admin_user:secure_pass@database:5432/app_db
      - REDIS_URL=redis://cache:6379
    depends_on:
      - database
      - cache
    labels:
      - "traefik.enable=true"
      # Enruta todo el tráfico HTTP que llega al puerto 80 del host hacia este servicio
      - "traefik.http.routers.web-app.rule=PathPrefix(`/`)"
      # Puerto interno en el que la app escucha dentro del contenedor
      - "traefik.http.services.web-app.loadbalancer.server.port=3000"

volumes:
  db_data:
```

---

## 📈 6. Paso 5: Operaciones de Despliegue y Escalado

Una vez configurado el entorno, utiliza la CLI de Docker para gestionar tus servicios en desarrollo o servidores locales:

### Levantar y Compilar el Stack

```bash
docker compose up --build -d
```

### Escalar Horizontalmente el Servicio Web

Para aumentar la capacidad del servidor de forma instantánea a 5 réplicas:

```bash
docker compose up --scale web-app=5 -d
```

_Traefik detectará automáticamente las 5 instancias y distribuirá el tráfico de forma equitativa (Round Robin) entre ellas de inmediato._

### Monitorear Consumos de Recursos en Tiempo Real

Para visualizar la memoria RAM y CPU consumida por cada contenedor activo:

```bash
docker stats
```

---

## ⚙️ 7. Orquestación Elástica con Docker Swarm

Cuando se requiere desplegar la aplicación en producción distribuida (múltiples servidores físicos o máquinas virtuales) sin la alta complejidad de Kubernetes, **Docker Swarm** es la solución de orquestación nativa recomendada.

### Diferencias Clave con Docker Compose Local

1. **Ubicación de Labels**: En Docker Swarm, Traefik monitoriza las etiquetas declaradas exclusivamente bajo la sección `deploy.labels` del servicio en lugar del bloque `labels` raíz del contenedor.
2. **Ubicación del Proxy (Placement Constraints)**: El contenedor de Traefik debe estar restringido al nodo **Manager** del clúster (`node.role == manager`) para tener los privilegios del socket del clúster Swarm.
3. **Escalado Declarativo**: Las réplicas y políticas de despliegue se declaran en el bloque `deploy:` del servicio en lugar de usar parámetros en línea de comandos.

### Plantilla Genérica compatible con Docker Swarm (`docker-compose.yml`)

```yaml
version: "3.8"

services:
  # Traefik (Debe ejecutarse en el Manager)
  traefik:
    image: traefik:v2.11
    ports:
      - "80:80"
      - "8081:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    deploy:
      placement:
        constraints:
          - node.role == manager

  cache:
    image: redis:7-alpine

  # Aplicación Replicada
  web-app:
    image: tu-registro-privado.com/web-app:latest
    environment:
      - REDIS_URL=redis://cache:6379
    deploy:
      replicas: 5
      update_config:
        parallelism: 2
        delay: 10s
        order: start-first
      restart_policy:
        condition: on-failure
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.web-app.rule=PathPrefix(`/`)"
        - "traefik.http.services.web-app.loadbalancer.server.port=3000"
```

### Comandos de Operación en Producción Swarm

- **Inicializar el clúster (solo en el Manager inicial)**:

  ```bash
  docker swarm init
  ```

- **Unir otros servidores al clúster (Workers/Managers)**:

  ```bash
  docker swarm join --token <token_generado> <IP_del_Manager>:2377
  ```

- **Desplegar o Actualizar la Pila de Servicios (Stack)** (interpolando variables del `.env`):

  ```bash
  # En Linux, las variables de .env se exportan automáticamente o se leen al desplegar
  export $(cat .env | xargs) && docker stack deploy -c docker-compose.yaml hightraffic
  ```

- **Escalar en caliente un Servicio manualmente**:

  ```bash
  docker service scale hightraffic_api=10
  ```

- **Monitorear los servicios del clúster**:

  ```bash
  docker service ls
  docker service ps hightraffic_api
  ```

---

## 📈 8. Autoescalado Dinámico Automatizado (Evitando el Flapping)

Para entornos Linux de producción real, hemos incorporado una solución elástica compuesta por:

1. **Telegraf** (InfluxData): Recolecta métricas de uso de CPU/RAM de los contenedores Swarm en tiempo real consultando la API de Docker (`/containers/stats`). A diferencia de cAdvisor, funciona tanto en Linux como en Docker Desktop y está activamente mantenido.
2. **Prometheus**: Consume las métricas, calcula promedios y evalúa reglas de alerta.
3. **Alertmanager**: Recibe alertas de sobrecarga o infrautilización y envía peticiones webhook HTTP POST.
4. **Autoscaler Webhook** (`./autoscaler`): Servicio ligero Node.js que escucha el webhook de Alertmanager en `/webhook` y ejecuta `docker service scale` directamente sobre el socket local de Docker para redimensionar el número de réplicas en caliente.

> **Nota de diseño:** Este componente reemplaza a [Orbiter](https://github.com/orbiterhost/orbiter), que se retiró por un bug de diseño insalvable: su modo `autodetect` registra el autoscaler con una key que contiene `/` (`autoswarm/hightraffic_api`), lo que rompe el enrutamiento de gorilla/mux; además el flag `--config` no existe, impidiendo cargar configuración estática. El webhook Node.js actual replica su funcionalidad sin esa dependencia.

### ⚙️ Variables de Entorno del Autoscaler

El archivo [.env](file:///d:/Users/windows/Proyectos/HighTraffic/.env) centraliza todos los parámetros que gobiernan el autoescalado dinámico:

- `API_REPLICAS_MIN`: El límite de réplicas mínimo garantizado (default: `5`). El clúster nunca bajará de este número.
- `API_REPLICAS_MAX`: El límite máximo seguro para resguardar recursos del hardware (default: `15`).
- `SCALE_UP_BY`: Cantidad de contenedores a agregar al detectar sobrecarga (default: `2`).
- `SCALE_DOWN_BY`: Cantidad de contenedores a remover al detectar baja carga (default: `1`).
- `SCALE_COOLDOWN`: Tiempo de enfriamiento (cooldown) tras un comando de escalado (default: `120s` / 2 minutos). En este intervalo se ignora cualquier nueva señal de escala para estabilizar las conexiones.

### 🛡️ Políticas de Prevención de Flapping

Para evitar inestabilidades y fluctuaciones constantes de red en producción, se implementan tres niveles de amortiguación:

1. **Retardo Asimétrico**: El escalado ascendente (Up) se dispara en **30 segundos** ante un pico de CPU > 70% para salvaguardar la experiencia del usuario. En cambio, el desescalado (Down) requiere que la CPU caiga por debajo del 25% de forma continua durante **5 minutos** completos antes de retirar réplicas.
2. **Período de Enfriamiento**: El Autoscaler Webhook bloquea cualquier nuevo cambio de escala durante el `SCALE_COOLDOWN` (default: `120s`) después de cada escalado.
3. **Suelo de Contención**: La escala nunca caerá por debajo de `API_REPLICAS_MIN` (5 réplicas base de alta disponibilidad).

---

## 🖥️ 9. Web Panel de Control y Monitoreo (Puerto `9099`)

El Autoscaler expone además un **panel web unificado** accesible en el **puerto `9099`** (`http://<servidor>:9099`) que funciona como centro de observabilidad y control del clúster. Se sirve como aplicación estática desde el propio servicio del Autoscaler y se actualiza automáticamente cada 3 segundos consultando el endpoint `/api/metrics`.

### 📊 Funcionalidades

1. **Métricas Globales en Tiempo Real**:
   - Réplicas activas vs. máximo (`API_REPLICAS_MAX`).
   - CPU promedio como **% del host** (normalizado por la cantidad de núcleos, para una escala veraz 0-100%).
   - Tasa de tráfico de red del gateway Traefik en `KB/s`.

2. **Gráfico Histórico de CPU**: evolución del consumo en vivo para detectar picos y verificar la respuesta elástica del clúster.

3. **Cards por Contenedor**: estado individual de cada réplica de la API y de cada módulo del sistema (Traefik, Redis, RabbitMQ, Prometheus, Alertmanager, Telegraf, Autoscaler), con barras de **CPU**, **memoria** y **tránsito de red I/O**.

4. **Control de Escalado Manual**: botones para escalar/desescalar en caliente, sincronizados con el cooldown real del Autoscaler (barra de progreso + cuenta regresiva).

5. **Monitor de Colas RabbitMQ**: profundidad de cola y tasas de publicación/consumo.

6. **Feed de Alertas Persistente**: historial de alertas de Alertmanager almacenado en disco (`autoscaler/data/alerts-history.json`), de modo que **persiste entre reinicios y refrescos del navegador**.

7. **Visor de Parámetros (.env)**: límites y pasos de escalado configurados actualmente.

### 🛡️ Consideraciones de Diseño

- **Resiliencia**: ante una saturación temporal del daemon de Docker (respuestas vacías o caídas de `/api/metrics` bajo carga extrema), el panel conserva el último render válido y no muestra estados intermitentes de "sin contenedores".
- **Cálculo de CPU veraz**: el consumo se normaliza dividiendo el `% por núcleo` (reportado por `docker stats` y Telegraf) entre el número de núcleos del host, de forma que toda la interfaz usa una escala coherente de **% del host (0-100%)**.
- **Multiplataforma**: funciona idéntico en Linux nativo y en Docker Desktop (Windows/Mac), ya que todas las fuentes de datos (`os.cpus()`, API de Docker y Telegraf) son compatibles con ambos entornos.

---

## 🧪 10. Pruebas de Estrés (k6): Consideraciones y Recomendaciones

El script `stress.js` (ejecutable con `k6 run stress.js`) genera una carga masiva de usuarios virtuales (VUs) contra el endpoint público para forzar y validar el autoescalado. Antes de lanzarlo en producción, conviene calibrar la intensidad del test al hardware disponible para obtener mediciones realistas sin colapsar el entorno.

### ⚙️ Parámetros clave a ajustar (en `stress.js`)

| Parámetro | Ubicación | Qué controla |
| :-- | :-- | :-- |
| `target` (VUs máx.) | `options.stages` | Cantidad máxima de usuarios virtuales concurrentes. Es el principal factor de carga. |
| `duration` | `options.stages` | Tiempo de cada etapa (subida / sostenimiento / bajada). El sostenimiento debe durar lo suficiente para disparar el escalado (`for: 30s` de la alerta + cooldown). |
| `http_req_failed` | `options.thresholds` | Tasa máxima de errores tolerada antes de marcar el test como fallido. |
| `sleep(...)` | `default function` | Pausa entre iteraciones; protege la tabla de sockets del host contra la saturación inmediata. |

### 🎚️ Recomendación de VUs máximos según hardware

La capacidad del host (núcleos/RAM) acota cuánta carga puede absorber el clúster antes de saturarse. Usar más VUs de los que el servidor puede procesar solo produce timeouts y mide la saturación de la red local, no el rendimiento real del stack. Valores de referencia:

| Hardware del servidor | VUs máx. sugerido | Observaciones |
| :-- | :-- | :-- |
| **2 cores / 4 GB** | 200 – 400 | Mantén `API_REPLICAS_MAX` bajo (~5-6); el CPU es el cuello de botella. |
| **4 cores / 8 GB** | 500 – 900 | Rango equilibrado; permite ver el escalado completo sin colapsar. |
| **6 cores / 12 GB** | 900 – 1500 | Buen margen de sobresuscripción para trabajo I/O-bound. |
| **8+ cores / 16 GB+** | 1500 – 2500+ | Ajusta `API_REPLICAS_MAX` hacia 12-15 para aprovechar los núcleos. |

> **Regla práctica**: parte con un `target` bajo y sube progresivamente. El óptimo es el valor donde la tasa de error se mantiene por debajo del umbral (`http_req_failed`) y la latencia se estabiliza; si los errores se disparan, estás saturando la red/daemon, no probando la app.

### ⚠️ Consideraciones al ejecutar el test

1. **Entorno local (Docker Desktop / Windows)**: el daemon corre dentro de una VM ligera con recursos limitados y comparte CPU con el host. Usa VUs **moderados (300-600)** y un `sleep` de ~80-150ms para no agotar los sockets locales. Valores altos (1000+) colapsan el daemon y producen timeouts masivos que no reflejan el comportamiento de producción.

2. **Duración del sostenimiento**: la etapa de carga sostenida debe durar **al menos 60-90s** para permitir que la alerta de CPU (>70% durante 30s) se dispare, Alertmanager entregue el webhook y el clúster converja con las nuevas réplicas. Un test demasiado corto puede no gatillar el escalado.

3. **Tráfico mixto cache hit/miss**: el test alterna peticiones `?nocache=` (miss → encolan en RabbitMQ) y `/` plana (hit → cache). Para forzar más carga de CPU/cola, aumenta la proporción de misses; para simular tráfico más "amable", redúcela.

4. **Observación durante el test**: ejecuta el test y vigila simultáneamente el [Web Panel](http://localhost:9099) para confirmar que suben las réplicas, crece la cola de RabbitMQ y aumenta el tráfico de Traefik. Tras el test, verifica que el desescalado automático reduzca las réplicas al mínimo (`API_REPLICAS_MIN`) de forma estable.

5. **No mezcles pruebas con tráfico real**: el test asume que el servidor está dedicado. Si hay otros servicios compitiendo por CPU/RAM, los resultados no serán representativos.

### 🔧 Ajuste conjunto con el autoescalado

El `target` de VUs y `API_REPLICAS_MAX` deben calibrarse juntos: un test que no logra elevar la CPU por encima del umbral de alerta nunca disparará el escalado, mientras que un `MAX` demasiado alto para el hardware genera sobresuscripción y degradación. Valida primero el escalado con un `target` que logre saturar la CPU, y luego confirma que el clúster se estabiliza dentro de los límites configurados.
