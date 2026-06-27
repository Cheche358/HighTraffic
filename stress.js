import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  discardResponseBodies: true,         // Evita almacenar en memoria local los cuerpos de respuesta (maximiza RPS del host)
  stages: [
    { duration: "10s", target: 1500 },  // Rampa de subida rápida a 1000 VUs
    { duration: "25s", target: 1500 },  // Sostener tráfico pesado para forzar el autoescalado
    { duration: "10s", target: 0 },     // Rampa de bajada
  ],
  thresholds: {
    http_req_failed: ["rate<0.10"],    // Permitir hasta un 10% de fallos bajo estrés extremo local
  },
};

export default function () {
  // Mezcla 50/50 de tráfico: la mitad de las peticiones llevan cache-busting
  // (?nocache=) y la otra mitad van a la URL plana (/) que puede resolver
  // desde caché. La selección es aleatoria por petición para simular tráfico
  // realista de usuarios nuevos vs. recurrentes.
  const makeUrl = () =>
    Math.random() < 0.5
      ? `http://127.0.0.1/?nocache=${Math.random()}`
      : "http://127.0.0.1/";

  // Enviamos un lote de 2 peticiones concurrentes por iteración agrupadas bajo una métrica única (Root)
  // para evitar la advertencia de alta cardinalidad en el ingester de k6.
  const responses = http.batch([
    { method: "GET", url: makeUrl(), params: { tags: { name: "Root" } } },
    { method: "GET", url: makeUrl(), params: { tags: { name: "Root" } } }
  ]);

  // Validamos respuestas del batch
  check(responses[0], {
    "status es 200 o 202": (r) => r.status === 200 || r.status === 202,
  });

  // Delay de 80ms para proteger la tabla de sockets locales de Windows contra la saturación inmediata.
  // Permite un flujo sumamente agresivo (~900+ RPS) sin colapsar la red del host local.
  sleep(0.08);
}


