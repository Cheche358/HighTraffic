const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const DB_PATH = path.join(__dirname, "data", "alerts-history.json");

// Asegurar que la carpeta de la base de datos local JSON existe
try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
} catch (err) {
  console.error("[ERROR] No se pudo crear directorio de base de datos:", err.message);
}

// ─── Configuración desde Variables de Entorno ───
const PORT = parseInt(process.env.SCALER_PORT || "9099", 10);
const SERVICE_NAME = process.env.SCALE_SERVICE || "hightraffic_api";
const MIN_REPLICAS = parseInt(process.env.API_REPLICAS_MIN || "5", 10);
const MAX_REPLICAS = parseInt(process.env.API_REPLICAS_MAX || "15", 10);
const SCALE_UP_BY = parseInt(process.env.SCALE_UP_BY || "2", 10);
const SCALE_DOWN_BY = parseInt(process.env.SCALE_DOWN_BY || "1", 10);
const COOLDOWN_SECONDS = parseInt(process.env.SCALE_COOLDOWN || "120", 10);

let lastScaleTime = 0;

// Helper para consultar Prometheus desde la red interna de Swarm
function queryPrometheus(query) {
  return new Promise((resolve) => {
    const url = `http://prometheus:9090/api/v1/query?query=${encodeURIComponent(query)}`;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.status === "success") {
            resolve(parsed.data.result);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => {
      resolve([]);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve([]);
    });
  });
}

// Helper para consultar la API de RabbitMQ
function queryRabbitMQ() {
  return new Promise((resolve) => {
    const auth = 'Basic ' + Buffer.from('guest:guest').toString('base64');
    const options = {
      hostname: 'rabbitmq',
      port: 15672,
      path: '/api/queues',
      method: 'GET',
      headers: {
        'Authorization': auth
      },
      timeout: 2000
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            const queues = parsed.map(q => ({
              name: q.name,
              messages: q.messages || 0,
              messages_ready: q.messages_ready || 0,
              messages_unacknowledged: q.messages_unacknowledged || 0,
              publish_rate: q.message_stats && q.message_stats.publish_details ? q.message_stats.publish_details.rate : 0,
              deliver_rate: q.message_stats && q.message_stats.deliver_details ? q.message_stats.deliver_details.rate : 0
            }));
            resolve(queues);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });

    req.on("error", () => {
      resolve([]);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

// Helper para consultar la API de Alertmanager
function queryAlertmanager() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'alertmanager',
      port: 9093,
      path: '/api/v2/alerts',
      method: 'GET',
      timeout: 2000
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            const alerts = parsed.map(a => ({
              name: a.labels.alertname,
              state: a.status.state,
              severity: a.labels.severity || 'warning',
              summary: a.annotations.summary || '',
              startsAt: a.startsAt
            }));
            resolve(alerts);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });

    req.on("error", () => {
      resolve([]);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

let cachedContainers = [];

// Actualizar estadísticas de contenedores de forma asíncrona no bloqueante
async function updateDockerStatsCache() {
  try {
    // 1. Obtener ID e Imagen desde docker ps (con timeout para no colgarse si la Docker API tarda)
    const { stdout: psOutput } = await execPromise(
      `docker ps --no-trunc --format "{{.Names}}|{{.ID}}|{{.Image}}"`,
      { timeout: 5000 }
    );
    
    const containerMap = {};
    if (psOutput) {
      psOutput.trim().split("\n").forEach(line => {
        const parts = line.split("|");
        const names = parts[0];
        const id = parts[1];
        const image = parts[2];
        if (names) {
          const primaryName = names.split(",")[0].trim();
          containerMap[primaryName] = {
            id: id ? id.substring(0, 12) : "unknown",
            fullId: id || "unknown",
            image: image || "unknown"
          };
        }
      });
    }

    // 2. Obtener CPU, Memoria y Red desde docker stats
    const { stdout: statsOutput } = await execPromise(
      `docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}"`,
      { timeout: 7000 }
    );

    if (!statsOutput) {
      cachedContainers = [];
      return;
    }

    cachedContainers = statsOutput.trim().split("\n").map(line => {
      const parts = line.split("|");
      const name = parts[0] || "unknown";
      const info = containerMap[name] || { id: "unknown", fullId: "unknown", image: "unknown" };
      return {
        name: name,
        id: info.id,
        fullId: info.fullId,
        image: info.image,
        cpu: parts[1] || "0.00%",
        memory: parts[2] || "0.00MiB / 0.00MiB",
        net: parts[3] || "0.00B / 0.00B"
      };
    }).filter(c => c.name.startsWith("hightraffic_"));
  } catch (err) {
    console.error(`[ERROR Cache Stats] Fallo al actualizar métricas:`, err.message);
  }
}

// Iniciar bucle de caché cada 5 segundos de forma asíncrona
setInterval(updateDockerStatsCache, 5000);
// Disparar la primera carga asíncrona
updateDockerStatsCache();

// ─── Obtener Réplicas Actuales ───
function getCurrentReplicas() {
  try {
    const output = execSync(
      `docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' ${SERVICE_NAME}`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    return parseInt(output, 10) || MIN_REPLICAS;
  } catch (err) {
    console.error(`[ERROR] No se pudo inspeccionar ${SERVICE_NAME}:`, err.message);
    return MIN_REPLICAS;
  }
}

// ─── Escalar el Servicio ───
function scaleService(direction) {
  const now = Date.now();
  const elapsed = (now - lastScaleTime) / 1000;

  if (elapsed < COOLDOWN_SECONDS && lastScaleTime > 0) {
    console.log(`[COOLDOWN] Esperando ${Math.ceil(COOLDOWN_SECONDS - elapsed)}s antes de escalar de nuevo.`);
    return { status: "cooldown", remaining: Math.ceil(COOLDOWN_SECONDS - elapsed) };
  }

  const current = getCurrentReplicas();
  let target;

  if (direction === "up") {
    target = Math.min(current + SCALE_UP_BY, MAX_REPLICAS);
  } else {
    target = Math.max(current - SCALE_DOWN_BY, MIN_REPLICAS);
  }

  if (target === current) {
    console.log(`[LIMIT] Ya en el límite: ${current} réplicas (min=${MIN_REPLICAS}, max=${MAX_REPLICAS}).`);
    return { status: "at_limit", current, min: MIN_REPLICAS, max: MAX_REPLICAS };
  }

  try {
    console.log(`[SCALE ${direction.toUpperCase()}] ${SERVICE_NAME}: ${current} → ${target} réplicas`);
    execSync(`docker service scale ${SERVICE_NAME}=${target}`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    lastScaleTime = Date.now();
    return { status: "scaled", direction, from: current, to: target };
  } catch (err) {
    console.error(`[ERROR] Fallo al escalar:`, err.message);
    return { status: "error", message: err.message };
  }
}

let alertHistoryLog = [];

// Cargar historial de alertas desde disco al arrancar
function loadAlertsFromDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, "utf-8");
      alertHistoryLog = JSON.parse(raw) || [];
      console.log(`[DB LOADED] Cargadas ${alertHistoryLog.length} alertas desde el historial persistido.`);
    }
  } catch (err) {
    console.error("[DB ERROR] Fallo al cargar historial de alertas:", err.message);
    alertHistoryLog = [];
  }
}

// Persistir historial de alertas a disco
function saveAlertsToDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(alertHistoryLog, null, 2), "utf-8");
  } catch (err) {
    console.error("[DB ERROR] Fallo al persistir historial de alertas:", err.message);
  }
}

// Inicializar la carga
loadAlertsFromDB();

// Procesar alertas y mantener el log persistido
function processAlertsHistory(activeAlerts) {
  if (!Array.isArray(activeAlerts)) return;
  
  let changed = false;

  // 1. Añadir nuevas alertas al historial si no existen
  activeAlerts.forEach(a => {
    const exists = alertHistoryLog.find(h => h.name === a.name && h.startsAt === a.startsAt);
    if (!exists) {
      alertHistoryLog.unshift({
        name: a.name,
        severity: a.severity || "warning",
        summary: a.summary || a.description || "Alerta disparada",
        startsAt: a.startsAt || new Date().toISOString(),
        resolved: false,
        resolvedAt: null
      });
      changed = true;
    }
  });

  // 2. Detectar cuáles del historial ya se resolvieron
  alertHistoryLog.forEach(h => {
    if (!h.resolved) {
      const stillActive = activeAlerts.some(a => a.name === h.name && a.startsAt === h.startsAt);
      if (!stillActive) {
        h.resolved = true;
        h.resolvedAt = new Date().toISOString();
        changed = true;
      }
    }
  });

  // 3. Limitar historial a las últimas 50 alertas
  if (alertHistoryLog.length > 50) {
    alertHistoryLog.length = 50;
    changed = true;
  }

  // 4. Guardar cambios si hubo novedades
  if (changed) {
    saveAlertsToDB();
  }
}

// ─── Parsear Alertas de Alertmanager ───
function parseAlertmanagerPayload(body) {
  try {
    const payload = JSON.parse(body);
    if (payload.status !== "firing" || !Array.isArray(payload.alerts)) {
      return null;
    }
    // Buscar la primera alerta con label "scale"
    for (const alert of payload.alerts) {
      const scale = alert.labels && alert.labels.scale;
      if (scale === "up" || scale === "down") {
        return scale;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Servidor HTTP ───
const server = http.createServer(async (req, res) => {
  // Configuración de CORS por si se necesita desarrollo externo
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const current = getCurrentReplicas();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "healthy",
      service: SERVICE_NAME,
      current_replicas: current,
      min: MIN_REPLICAS,
      max: MAX_REPLICAS,
    }));
    return;
  }

  // Endpoint de Métricas Unificado para el Frontend
  if (req.method === "GET" && req.url === "/api/metrics") {
    const current = getCurrentReplicas();
    const now = Date.now();
    const elapsed = (now - lastScaleTime) / 1000;
    const cooldownRemaining = lastScaleTime > 0 ? Math.max(0, Math.ceil(COOLDOWN_SECONDS - elapsed)) : 0;

    // Consultar CPU Promedio y volumen de solicitudes (red) a Prometheus
    const cpuQuery = `avg(docker_container_cpu_usage_percent{com_docker_swarm_service_name="${SERVICE_NAME}"})`;
    
    // Tasa de bytes de red RX+TX del gateway Traefik (label correcto de Telegraf: container_name)
    const trafficQuery = `sum(rate(docker_container_net_rx_bytes{container_name=~"hightraffic_traefik.*"}[1m])) + sum(rate(docker_container_net_tx_bytes{container_name=~"hightraffic_traefik.*"}[1m]))`;

    const [cpuResult, trafficResult, rabbitData, alertData] = await Promise.all([
      queryPrometheus(cpuQuery),
      queryPrometheus(trafficQuery),
      queryRabbitMQ(),
      queryAlertmanager()
    ]);

    let cpuUsage = 0;
    if (cpuResult.length > 0 && cpuResult[0].value) {
      cpuUsage = parseFloat(cpuResult[0].value[1]) || 0;
    }

    let networkTraffic = 0;
    if (trafficResult.length > 0 && trafficResult[0].value) {
      networkTraffic = parseFloat(trafficResult[0].value[1]) || 0; // Bytes/seg
    }

    // Convertir bytes a un formato legible (KB/s)
    const trafficKb = networkTraffic / 1024;

    // Obtener las estadísticas locales de contenedores desde la caché
    const containers = cachedContainers;

    // Procesar alertas y actualizar el historial acumulativo del backend
    processAlertsHistory(alertData);

    // Determinar estado de alerta del badge local
    const isAlertFiring = alertData.some(a => a.name === "APIOverloaded" && a.state === "firing");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      service: SERVICE_NAME,
      replicas: current,
      min: MIN_REPLICAS,
      max: MAX_REPLICAS,
      cooldown_seconds: COOLDOWN_SECONDS,
      cooldown_remaining: cooldownRemaining,
      cpu_usage: parseFloat(cpuUsage.toFixed(2)),
      traffic_rate_kb: parseFloat(trafficKb.toFixed(2)),
      alert_status: isAlertFiring ? "firing" : "ok",
      scale_up_by: SCALE_UP_BY,
      scale_down_by: SCALE_DOWN_BY,
      queues: rabbitData,
      alerts: alertHistoryLog, // Historial persistido en memoria de Node.js
      containers: containers
    }));
    return;
  }

  // Manual scale trigger: POST /scale/up o POST /scale/down
  if (req.method === "POST" && req.url.startsWith("/scale/")) {
    const direction = req.url.split("/scale/")[1];
    if (direction === "up" || direction === "down") {
      const result = scaleService(direction);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
  }

  // Alertmanager webhook: POST /webhook
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const direction = parseAlertmanagerPayload(body);
      if (!direction) {
        console.log("[WEBHOOK] Alerta ignorada (no es firing o sin label scale).");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ignored" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted", direction }));
      setImmediate(() => scaleService(direction));
    });
    return;
  }

  // Servir archivos estáticos del panel (SPA)
  const publicDir = path.join(__dirname, "public");
  let filePath = path.join(publicDir, req.url === "/" ? "index.html" : req.url);

  // Evitar Directory Traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Access denied" }));
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // Si el archivo no existe, responder 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let contentType = "text/html";
    if (filePath.endsWith(".css")) contentType = "text/css";
    if (filePath.endsWith(".js")) contentType = "text/javascript";
    if (filePath.endsWith(".json")) contentType = "application/json";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  🚀 Autoscaler Webhook & Monitor Server");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Puerto:          ${PORT}`);
  console.log(`  Servicio:        ${SERVICE_NAME}`);
  console.log(`  Réplicas:        ${MIN_REPLICAS} (min) → ${MAX_REPLICAS} (max)`);
  console.log(`  Scale Up:        +${SCALE_UP_BY} réplicas`);
  console.log(`  Scale Down:      -${SCALE_DOWN_BY} réplicas`);
  console.log(`  Cooldown:        ${COOLDOWN_SECONDS}s`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  Endpoints:");
  console.log("    GET  /             → Web Panel Dashboard");
  console.log("    GET  /health       → Estado del servicio");
  console.log("    GET  /api/metrics  → Métricas para el Dashboard");
  console.log("    POST /webhook      → Alertmanager webhook");
  console.log("    POST /scale/up     → Escalar manualmente");
  console.log("    POST /scale/down   → Desescalar manualmente");
  console.log("═══════════════════════════════════════════════════════");
});
