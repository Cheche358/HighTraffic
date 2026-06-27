import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  discardResponseBodies: true,         // Evita almacenar en memoria local los cuerpos de respuesta (maximiza RPS del host)
  stages: [
    { duration: "10s", target: 1000 },  // Rampa de subida rápida a 1500 VUs
    { duration: "25s", target: 1000 },  // Sostener tráfico pesado para forzar el autoescalado
    { duration: "10s", target: 0 },     // Rampa de bajada
  ],
  thresholds: {
    http_req_failed: ["rate<0.10"],    // Permitir hasta un 10% de fallos bajo estrés extremo local
  },
};

export default function () {
  // Evitamos Cache Hits de Traefik/Redis inyectando query params aleatorios (Cache Busting)
  const url = `http://127.0.0.1/?nocache=${Math.random()}`;
  
  // Enviamos un lote de 2 peticiones concurrentes por iteración agrupadas bajo una métrica única (Root)
  // para evitar la advertencia de alta cardinalidad en el ingester de k6.
  const responses = http.batch([
    { method: "GET", url: url, params: { tags: { name: "Root" } } },
    { method: "GET", url: url, params: { tags: { name: "Root" } } }
  ]);

  // Validamos respuestas del batch
  check(responses[0], {
    "status es 200 o 202": (r) => r.status === 200 || r.status === 202,
  });

  // Delay de 80ms para proteger la tabla de sockets locales de Windows contra la saturación inmediata.
  // Permite un flujo sumamente agresivo (~900+ RPS) sin colapsar la red del host local.
  sleep(0.08);
}


