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
FROM node:20-alpine AS base

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

- **Desplegar o Actualizar la Pila de Servicios (Stack)**:

  ```bash
  docker stack deploy -c docker-compose.yaml mi_proyecto
  ```

- **Escalar en caliente un Servicio**:

  ```bash
  docker service scale mi_proyecto_web-app=15
  ```

- **Monitorear los servicios del clúster**:

  ```bash
  docker service ls
  docker service ps mi_proyecto_web-app
  ```
