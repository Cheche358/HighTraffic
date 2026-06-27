import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "10s", target: 1500 },  // Rampa de subida progresiva a 400 VUs
    { duration: "20s", target: 1500 },  // Sostener tráfico para gatillar sobrecarga de CPU
    { duration: "10s", target: 0 },    // Rampa de bajada
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],    // Permitir hasta un 5% de fallos bajo estrés extremo local
  },
};

export default function () {
  const res = http.get("http://127.0.0.1");
  
  // Verificamos que sea 200 (Cache Hit) o 202 (Encolado)
  check(res, {
    "status es 200 o 202": (r) => r.status === 200 || r.status === 202,
  });

  // Pausa ligera entre iteraciones para no ahogar los sockets locales de Windows
  sleep(0.15);
}


