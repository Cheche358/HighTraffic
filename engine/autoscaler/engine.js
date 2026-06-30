// =============================================================================
// SwarmAutoscaler — Control loop: discovery, evaluacion y escalado
// =============================================================================
const http = require("http");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const {
  POLL_INTERVAL, PROMETHEUS_URL, managed, parsePolicy,
} = require("./scaler");

// Eventos de escalado (para el feed del panel). Reemplaza el feed de Alertmanager.
const events = [];
const MAX_EVENTS = 50;

function pushEvent(name, direction, from, to, reason) {
  events.unshift({ name, direction, from, to, reason, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  console.log(`[SCALE ${direction.toUpperCase()}] ${name}: ${from} → ${to} (${reason})`);
}

// Consulta instantanea a Prometheus
function queryPrometheus(query) {
  return new Promise((resolve) => {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed && parsed.status === "success" ? parsed.data.result : []);
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(3000, () => { req.destroy(); resolve([]); });
  });
}

async function metricFor(name, metric) {
  // Metrica soportada por ahora: cpu (docker_container_cpu_usage_percent de Telegraf)
  const q = `avg(docker_container_cpu_usage_percent{com_docker_swarm_service_name="${name}"})`;
  const r = await queryPrometheus(q);
  return r.length && r[0].value ? parseFloat(r[0].value[1]) || 0 : null;
}

// Discovery: lista servicios con la label y reconstruye el mapa conservando estado
async function discover() {
  let names = [];
  try {
    const { stdout } = await execPromise(
      `docker service ls --filter label=${process.env.DISCOVERY_LABEL || "swarm-autoscaler.enable"}=true --format "{{.Name}}"`,
      { timeout: 6000 }
    );
    names = stdout.trim().split("\n").filter(Boolean);
  } catch (err) {
    console.error("[DISCOVERY] fallo:", err.message);
    return;
  }

  const next = new Map();
  for (const name of names) {
    try {
      const { stdout: insp } = await execPromise(
        `docker service inspect ${name} --format "{{.Spec.Mode.Replicated.Replicas}}|{{json .Spec.Labels}}"`,
        { timeout: 6000 }
      );
      const [repStr, labelsJson] = insp.trim().split("|");
      let labels = {};
      try { labels = JSON.parse(labelsJson); } catch {}
      const policy = parsePolicy(labels);
      if (!policy) continue;
      const prev = managed.get(name);
      next.set(name, {
        policy,
        replicas: parseInt(repStr, 10) || policy.min,
        cooldownUntil: prev ? prev.cooldownUntil : 0,
        upSince: prev ? prev.upSince : 0,
        downSince: prev ? prev.downSince : 0,
        cpu: prev ? prev.cpu : 0,
      });
    } catch (err) {
      console.error(`[DISCOVERY] inspect ${name} fallo:`, err.message);
    }
  }
  // Reemplazo atomico conservando estado de los que ya estaban
  managed.clear();
  for (const [k, v] of next) managed.set(k, v);
}

// Escala un servicio respetando su politica
async function scale(name, svc, direction, reason) {
  const cur = svc.replicas;
  let target;
  if (direction === "up") target = Math.min(cur + svc.policy.stepUp, svc.policy.max);
  else target = Math.max(cur - svc.policy.stepDown, svc.policy.min);
  if (target === cur) {
    pushEvent(name, direction, cur, cur, `limite alcanzado (${direction})`);
    return;
  }
  try {
    await execPromise(`docker service scale ${name}=${target}`, { timeout: 45000 });
    svc.replicas = target;
    svc.cooldownUntil = Date.now() + svc.policy.cooldownSec * 1000;
    svc.upSince = 0; svc.downSince = 0;
    pushEvent(name, direction, cur, target, reason);
  } catch (err) {
    console.error(`[SCALE] fallo escalando ${name}:`, err.message);
  }
}

// Evaluacion: aplica umbrales con ventana y cooldown
async function evaluate() {
  const now = Date.now();
  for (const [name, svc] of managed) {
    if (now < svc.cooldownUntil) {
      svc.status = "cooldown";
      continue;
    }
    const cpu = await metricFor(name, svc.policy.metric);
    if (cpu === null) { svc.status = "no-metrics"; svc.upSince = 0; svc.downSince = 0; continue; }
    svc.cpu = cpu;

    if (cpu > svc.policy.thresholdUp) {
      svc.status = "hot";
      if (!svc.upSince) svc.upSince = now;
      if (now - svc.upSince >= svc.policy.windowSec * 1000) {
        await scale(name, svc, "up", `CPU ${cpu.toFixed(0)}% > ${svc.policy.thresholdUp}%`);
      }
    } else if (cpu < svc.policy.thresholdDown) {
      svc.status = "cold";
      if (!svc.downSince) svc.downSince = now;
      if (now - svc.downSince >= svc.policy.downWindowSec * 1000) {
        await scale(name, svc, "down", `CPU ${cpu.toFixed(0)}% < ${svc.policy.thresholdDown}%`);
      }
    } else {
      svc.status = "stable";
      svc.upSince = 0; svc.downSince = 0;
    }
  }
}

// Escalado manual por servicio (panel / API)
async function manualScale(name, direction) {
  const svc = managed.get(name);
  if (!svc) return { status: "not-managed" };
  if (Date.now() < svc.cooldownUntil) {
    return { status: "cooldown", remaining: Math.ceil((svc.cooldownUntil - Date.now()) / 1000) };
  }
  const before = svc.replicas;
  await scale(name, svc, direction, "manual");
  return { status: "scaled", name, direction, from: before, to: svc.replicas };
}

async function loop() {
  await discover();
  await evaluate();
}

let timer = null;
function start() {
  loop();
  timer = setInterval(loop, POLL_INTERVAL * 1000);
}
function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, loop, discover, evaluate, manualScale, queryPrometheus, events };
