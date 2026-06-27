const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

    // Consultar CPU Promedio y estado de Alertas a Prometheus
    const cpuQuery = `avg(docker_container_cpu_usage_percent{com_docker_swarm_service_name="${SERVICE_NAME}"})`;
    const alertQuery = `ALERTS{alertname="APIOverloaded",alertstate="firing"}`;

    const [cpuResult, alertResult] = await Promise.all([
      queryPrometheus(cpuQuery),
      queryPrometheus(alertQuery)
    ]);

    let cpuUsage = 0;
    if (cpuResult.length > 0 && cpuResult[0].value) {
      cpuUsage = parseFloat(cpuResult[0].value[1]) || 0;
    }

    const isAlertFiring = alertResult.length > 0;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      service: SERVICE_NAME,
      replicas: current,
      min: MIN_REPLICAS,
      max: MAX_REPLICAS,
      cooldown_seconds: COOLDOWN_SECONDS,
      cooldown_remaining: cooldownRemaining,
      cpu_usage: parseFloat(cpuUsage.toFixed(2)),
      alert_status: isAlertFiring ? "firing" : "ok",
      scale_up_by: SCALE_UP_BY,
      scale_down_by: SCALE_DOWN_BY
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
