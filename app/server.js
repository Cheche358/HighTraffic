const express = require("express");
const os = require("os");
const redis = require("redis");
const amqp = require("amqplib");

const app = express();
const PORT = 3000;

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const QUEUE_NAME = "process-requests";
const CACHE_KEY = "blackfriday:status";

let redisClient;
let amqpConn;
let amqpChannel;
let server;

// Función de ayuda para esperar
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Conexión robusta con reintentos al inicio
async function connectServices() {
  // Conectar a Redis
  let redisConnected = false;
  while (!redisConnected) {
    try {
      console.log("Intentando conectar a Redis...");
      redisClient = redis.createClient({ url: REDIS_URL });
      redisClient.on("error", (err) => console.error("Error en cliente Redis:", err));
      await redisClient.connect();
      redisConnected = true;
      console.log("Conectado a Redis exitosamente.");
    } catch (err) {
      console.error("Fallo al conectar a Redis, reintentando en 2s...", err.message);
      await delay(2000);
    }
  }

  // Conectar a RabbitMQ
  let amqpConnected = false;
  while (!amqpConnected) {
    try {
      console.log("Intentando conectar a RabbitMQ...");
      amqpConn = await amqp.connect(RABBITMQ_URL);
      amqpChannel = await amqpConn.createChannel();
      await amqpChannel.assertQueue(QUEUE_NAME, { durable: false });
      amqpConnected = true;
      console.log("Conectado a RabbitMQ exitosamente.");
    } catch (err) {
      console.error("Fallo al conectar a RabbitMQ, reintentando en 2s...", err.message);
      await delay(2000);
    }
  }
}

// Inicializar el Worker / Consumidor integrado
async function startWorker() {
  console.log("Iniciando Worker en segundo plano...");
  amqpChannel.consume(QUEUE_NAME, async (msg) => {
    if (msg !== null) {
      const content = JSON.parse(msg.content.toString());
      console.log(`[Worker ${os.hostname()}] Tarea recibida:`, content);

      // Simulamos procesamiento pesado de 2 segundos
      await delay(2000);

      const result = {
        message: "Black Friday API (Resultado Procesado)",
        handledBy: os.hostname(),
        processedAt: new Date(),
        originalRequest: content
      };

      // Guardar el resultado en caché Redis con TTL de 10 segundos
      try {
        await redisClient.set(CACHE_KEY, JSON.stringify(result), {
          EX: 10 // Expira en 10 segundos para demostrar la dinámica alternante
        });
        console.log(`[Worker ${os.hostname()}] Resultado guardado en caché.`);
      } catch (err) {
        console.error("Error al escribir en Redis desde el Worker:", err.message);
      }

      amqpChannel.ack(msg);
    }
  });
}

// Ruta API principal
app.get("/", async (req, res) => {
  try {
    // 1. Intentar leer de la caché de Redis (a menos que el cliente fuerce un
    //    miss con ?nocache=, útil para pruebas de carga con tráfico mixto).
    const forceMiss = "nocache" in req.query;
    if (!forceMiss) {
      const cachedData = await redisClient.get(CACHE_KEY);
      if (cachedData) {
        console.log(`[Server ${os.hostname()}] Cache HIT!`);
        return res.status(200).json({
          source: "cache",
          data: JSON.parse(cachedData)
        });
      }
    }

    // 2. Si no hay caché (Cache MISS), encolar la tarea
    console.log(`[Server ${os.hostname()}] Cache MISS${forceMiss ? " (forzado por ?nocache)" : ""}! Encolando tarea...`);
    const taskPayload = {
      requestId: Math.random().toString(36).substring(7),
      requestedBy: os.hostname(),
      timestamp: new Date()
    };

    amqpChannel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(taskPayload)));

    return res.status(202).json({
      source: "queue",
      message: "Tu petición está en cola para procesamiento masivo.",
      requestId: taskPayload.requestId
    });

  } catch (err) {
    console.error("Error en el manejador de peticiones:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Inicializar el servicio completo
async function start() {
  await connectServices();
  await startWorker();

  server = app.listen(PORT, () => {
    console.log(`API running on port ${PORT} y escuchando eventos.`);
  });
}

start();

// Implementación de Graceful Shutdown (Cierre Ordenado)
function gracefulShutdown(signal) {
  console.log(`Recibida señal ${signal}. Iniciando apagado ordenado...`);

  if (server) {
    server.close(async () => {
      console.log("Servidor HTTP cerrado. No se aceptarán más conexiones.");

      try {
        // Cerrar RabbitMQ
        if (amqpChannel) await amqpChannel.close();
        if (amqpConn) await amqpConn.close();
        console.log("Conexión con RabbitMQ cerrada de forma segura.");

        // Cerrar Redis
        if (redisClient) await redisClient.disconnect();
        console.log("Conexión con Redis cerrada de forma segura.");

        console.log("Apagado ordenado completo. Saliendo del proceso.");
        process.exit(0);
      } catch (err) {
        console.error("Error durante el cierre ordenado de conexiones:", err.message);
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

