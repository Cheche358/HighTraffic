import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "5s", target: 2500 },  // Rampa de subida rápida
    { duration: "10s", target: 2500 }, // Sostener tráfico de 1000 usuarios
    { duration: "5s", target: 0 },     // Rampa de bajada
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],    // La tasa de error debe ser inferior al 1%
  },
};

export default function () {
  const res = http.get("http://127.0.0.1");
  
  // Verificamos que sea 200 (Cache Hit) o 202 (Encolado)
  check(res, {
    "status es 200 o 202": (r) => r.status === 200 || r.status === 202,
  });

  // Pausa ligera entre iteraciones
  sleep(0.1);
}

