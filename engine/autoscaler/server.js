// =============================================================================
// SwarmAutoscaler — HTTP server + Web Panel
// Orquesta el motor (engine.js), expone la API del panel y sirve la UI.
// =============================================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const { CPU_CORES, managed, POLL_INTERVAL } = require("./scaler");
const engine = require("./engine");
const { queryPrometheus, events } = engine;

const PORT = parseInt(process.env.SCALER_PORT || "9099", 10);

// ─── Cache de stats por contenedor (para la vista detallada del panel) ───
let cachedContainers = [];
let lastTraefikNetBytes = null;
let lastTraefikNetTimestamp = null;
let localTrafficRateKb = 0;

function parseNetBytes(netStr) {
  if (!netStr) return 0;
  const parts = netStr.split("/");
  if (parts.length < 2) return 0;
  const toBytes = (str) => {
    const m = str.trim().match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
    if (!m) return 0;
    const v = parseFloat(m[1]) || 0;
    const u = m[2].toUpperCase();
    if (u.startsWith("G")) return v * 1073741824;
    if (u.startsWith("M")) return v * 1048576;
    if (u.startsWith("K")) return v * 1024;
    return v;
  };
  return toBytes(parts[0]) + toBytes(parts[1]);
}

async function updateDockerStatsCache() {
  try {
    const { stdout: psOutput } = await execPromise(
      `docker ps --no-trunc --format "{{.Names}}|{{.ID}}|{{.Image}}"`, { timeout: 5000 });
    const containerMap = {};
    if (psOutput) psOutput.trim().split("\n").forEach((line) => {
      const [names, id, image] = line.split("|");
      if (names) containerMap[names.split(",")[0].trim()] = {
        id: id ? id.substring(0, 12) : "unknown", fullId: id || "unknown", image: image || "unknown" };
    });

    const { stdout: statsOutput } = await execPromise(
      `docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}"`, { timeout: 8000 });
    if (!statsOutput || !statsOutput.trim()) return;

    const processed = statsOutput.trim().split("\n").map((line) => {
      const [name, cpu, memory, net] = line.split("|");
      const info = containerMap[name] || { id: "unknown", fullId: "unknown", image: "unknown" };
      return { name, id: info.id, fullId: info.fullId, image: info.image,
        cpu: cpu || "0.00%", memory: memory || "0B", net: net || "0B" };
    }).filter((c) => c.name && c.name.indexOf("_") !== -1);

    if (processed.length > 0) {
      cachedContainers = processed;
      const traefik = processed.find((c) => /traefik/i.test(c.name));
      if (traefik) {
        const cur = parseNetBytes(traefik.net);
        const now = Date.now();
        if (lastTraefikNetBytes !== null && lastTraefikNetTimestamp !== null) {
          const dt = (now - lastTraefikNetTimestamp) / 1000;
          if (dt > 0) localTrafficRateKb = Math.max(0, (cur - lastTraefikNetBytes)) / 1024 / dt;
        }
        lastTraefikNetBytes = cur;
        lastTraefikNetTimestamp = now;
      }
    }
  } catch (err) {
    console.error("[CACHE] fallo stats:", err.message);
  }
}

setInterval(updateDockerStatsCache, 5000);
updateDockerStatsCache();

// ─── RabbitMQ (panel de colas) ───
function queryRabbitMQ() {
  return new Promise((resolve) => {
    const auth = "Basic " + Buffer.from("guest:guest").toString("base64");
    const req = http.request({ hostname: "rabbitmq", port: 15672, path: "/api/queues", method: "GET",
      headers: { Authorization: auth }, timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed.map((q) => ({
            name: q.name, messages: q.messages || 0, messages_ready: q.messages_ready || 0,
            messages_unacknowledged: q.messages_unacknowledged || 0,
            publish_rate: q.message_stats && q.message_stats.publish_details ? q.message_stats.publish_details.rate : 0,
            deliver_rate: q.message_stats && q.message_stats.deliver_details ? q.message_stats.deliver_details.rate : 0,
          })) : []);
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// Servicio "primario" para retrocompatibilidad del panel (el 1er gestionado)
function primaryManaged() {
  for (const [name, svc] of managed) return { name, ...svc };
  return null;
}

// Mapea eventos de escalado al shape que espera el feed del panel
function eventsForPanel() {
  return events.map((e) => ({
    name: e.name,
    severity: e.direction === "up" ? "critical" : "warning",
    summary: `${e.direction === "up" ? "Escalado +" : "Desescalado -"} ${e.name}: ${e.from} → ${e.to} (${e.reason})`,
    startsAt: e.at, resolved: true, resolvedAt: e.at,
  }));
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", managed_services: managed.size, cpu_cores: CPU_CORES }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/metrics") {
    const primary = primaryManaged();
    const managedList = Array.from(managed.entries()).map(([name, s]) => ({
      name, replicas: s.replicas, cpu: s.cpu, status: s.status || "stable",
      min: s.policy.min, max: s.policy.max, cooldown_remaining: Math.max(0, Math.ceil((s.cooldownUntil - Date.now()) / 1000)),
      policy: s.policy,
    }));
    const [rabbit] = await Promise.all([queryRabbitMQ()]);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      // Datos genericos del motor
      managed: managedList,
      events: eventsForPanel(),
      cpu_cores: CPU_CORES,
      containers: cachedContainers,
      queues: rabbit,
      // Retrocompatibilidad del panel existente (servicio primario)
      replicas: primary ? primary.replicas : 0,
      min: primary ? primary.policy.min : 0,
      max: primary ? primary.policy.max : 0,
      cooldown_seconds: primary ? primary.policy.cooldownSec : 0,
      cooldown_remaining: primary ? Math.max(0, Math.ceil((primary.cooldownUntil - Date.now()) / 1000)) : 0,
      cpu_usage: primary ? primary.cpu || 0 : 0,
      traffic_rate_kb: parseFloat(localTrafficRateKb.toFixed(2)),
      scale_up_by: primary ? primary.policy.stepUp : 0,
      scale_down_by: primary ? primary.policy.stepDown : 0,
      alert_status: primary && primary.status === "hot" ? "firing" : "ok",
      alerts: eventsForPanel(),
      service: primary ? primary.name : null,
    }));
    return;
  }

  // Escalado manual: POST /scale/<service>/<up|down>
  const m = req.url.match(/^\/scale\/([^/]+)\/(up|down)$/);
  if (req.method === "POST" && m) {
    const result = await engine.manualScale(m[1], m[2]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // Webhook legacy (Alertmanager) — acepta pero el motor decide por polling
  if (req.method === "POST" && req.url === "/webhook") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", note: "scaling is poll-driven; webhook ignored" }));
    return;
  }

  // Servir el panel (SPA estatica)
  const publicDir = path.join(__dirname, "public");
  let filePath = path.join(publicDir, req.url === "/" ? "index.html" : req.url);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ct = filePath.endsWith(".css") ? "text/css"
      : filePath.endsWith(".js") ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": ct });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════");
  console.log("  🚀 SwarmAutoscaler — engine + panel");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Puerto:        ${PORT}`);
  console.log(`  Cores host:    ${CPU_CORES}`);
  console.log(`  Poll interval: ${POLL_INTERVAL}s`);
  console.log(`  Discovery:     label '${process.env.DISCOVERY_LABEL || "swarm-autoscaler.enable"}'`);
  console.log("───────────────────────────────────────────────");
  console.log("  GET  /             Panel");
  console.log("  GET  /health       Estado del motor");
  console.log("  GET  /api/metrics  Métricas (servicios gestionados)");
  console.log("  POST /scale/<svc>/<up|down>  Escalado manual");
  console.log("═══════════════════════════════════════════════");
});

// Arrancar el control loop del motor
engine.start();
