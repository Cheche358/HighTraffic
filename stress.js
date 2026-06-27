import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  discardResponseBodies: true,         // Evita almacenar en memoria local los cuerpos de respuesta (maximiza RPS del host)
  stages: [
    { duration: "10s", target: 1500 },  // Rampa de subida rápida a 1500 VUs
    { duration: "25s", target: 1500 },  // Sostener tráfico pesado para forzar el autoescalado
    { duration: "10s", target: 0 },     // Rampa de bajada
  ],
  thresholds: {
    http_req_failed: ["rate<0.10"],    // Permitir hasta un 10% de fallos bajo estrés extremo local
  },
};

export default function () {
  // Evitamos Cache Hits de Traefik/Redis inyectando query params aleatorios (Cache Busting)
  const url = `http://127.0.0.1/?nocache=${Math.random()}`;
  
  // Enviamos un lote de 2 peticiones concurrentes por iteración por cada VU
  const responses = http.batch([
    ["GET", url],
    ["GET", url]
  ]);

  // Validamos respuestas del batch
  check(responses[0], {
    "status es 200 o 202": (r) => r.status === 200 || r.status === 202,
  });

  // Delay microscópico (10ms) para evitar que Windows sature el pool de sockets locales por TCP port exhaust.
  // Es lo suficientemente bajo para ser sumamente agresivo pero seguro para el kernel.
  sleep(0.01);
}


