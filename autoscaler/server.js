const http = require("http");
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
const server = http.createServer((req, res) => {
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
  // Responde 200 inmediatamente y escala de forma asincrona para que
  // Alertmanager no agote el timeout ni reintente la notificacion.
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

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  🚀 Autoscaler Webhook Server");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Puerto:          ${PORT}`);
  console.log(`  Servicio:        ${SERVICE_NAME}`);
  console.log(`  Réplicas:        ${MIN_REPLICAS} (min) → ${MAX_REPLICAS} (max)`);
  console.log(`  Scale Up:        +${SCALE_UP_BY} réplicas`);
  console.log(`  Scale Down:      -${SCALE_DOWN_BY} réplicas`);
  console.log(`  Cooldown:        ${COOLDOWN_SECONDS}s`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  Endpoints:");
  console.log("    GET  /health       → Estado del servicio");
  console.log("    POST /webhook      → Alertmanager webhook");
  console.log("    POST /scale/up     → Escalar manualmente");
  console.log("    POST /scale/down   → Desescalar manualmente");
  console.log("═══════════════════════════════════════════════════════");
});
