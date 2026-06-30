// =============================================================================
// SwarmAutoscaler — Motor de autoescalado por discovery de labels
// Descubre servicios con la label `swarm-autoscaler.enable=true`, lee su
// politica de sus labels, consulta Prometheus y escala respetando ventanas
// y cooldown. No depende de un servicio hardcodeado.
// =============================================================================
const os = require("os");

const CPU_CORES = os.cpus().length || 1;

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "10", 10);
const DISCOVERY_LABEL = process.env.DISCOVERY_LABEL || "swarm-autoscaler.enable";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const LABEL_PREFIX = "swarm-autoscaler.";
const DEFAULTS = {
  min: 2, max: 10, stepUp: 1, stepDown: 1, cooldown: 60,
  metric: "cpu", thresholdUp: 70, thresholdDown: 25, windowSec: 30, downMultiplier: 10,
};

// Mapa de servicios gestionados: nombre -> estado en caliente
//   { policy, replicas, cooldownUntil, upSince, downSince, cpu }
let managed = new Map();

function parseWindow(str, fallback) {
  if (!str) return fallback;
  const m = String(str).trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n;
}

// Construye la politica de un servicio a partir de sus labels de Swarm
function parsePolicy(labels) {
  if (!labels) return null;
  const g = (k, d) => (labels[LABEL_PREFIX + k] !== undefined ? labels[LABEL_PREFIX + k] : d);
  if (String(labels[DISCOVERY_LABEL]) !== "true" && String(labels[LABEL_PREFIX + "enable"]) !== "true") {
    return null;
  }
  return {
    min: parseInt(g("min", DEFAULTS.min), 10),
    max: parseInt(g("max", DEFAULTS.max), 10),
    stepUp: parseInt(g("step-up", DEFAULTS.stepUp), 10),
    stepDown: parseInt(g("step-down", DEFAULTS.stepDown), 10),
    cooldownSec: parseInt(g("cooldown", DEFAULTS.cooldown), 10),
    metric: g("metric", DEFAULTS.metric),
    thresholdUp: parseFloat(g("threshold-up", DEFAULTS.thresholdUp)),
    thresholdDown: parseFloat(g("threshold-down", DEFAULTS.thresholdDown)),
    windowSec: parseWindow(g("window", null), DEFAULTS.windowSec),
    downWindowSec: parseWindow(g("down-window", null), 0) || parseWindow(g("window", null), DEFAULTS.windowSec) * DEFAULTS.downMultiplier,
  };
}

module.exports = {
  CPU_CORES, POLL_INTERVAL, DISCOVERY_LABEL, PROMETHEUS_URL, LABEL_PREFIX, DEFAULTS,
  managed, parsePolicy, parseWindow,
};
