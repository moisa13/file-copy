const http = require('http');
const config = require('./config');
const database = require('./queue/database');
const logger = require('./logger');
const bucketManager = require('./buckets/manager');
const threadPool = require('./workers/thread-pool');
const { createServer } = require('./api');

async function main() {
  console.log('File Copy Manager - Iniciando...');

  logger.system('Sistema iniciando');

  bucketManager.init();
  const buckets = bucketManager.getAllBuckets();
  console.log(`Buckets carregados: ${buckets.length}`);

  const { app, wss, startStatsTimer, close: closeApi } = createServer(bucketManager);

  const server = http.createServer(app);

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, () => {
      console.log(`Servidor rodando em http://${config.server.host}:${config.server.port}`);
      logger.system(`Servidor iniciado na porta ${config.server.port}`);
      resolve();
    });
  });

  startStatsTimer();

  bucketManager.restoreState();

  logger.system('Sistema pronto');
  console.log('Sistema pronto. Dashboard disponivel.');

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} recebido. Encerrando...`);
    logger.system(`Shutdown iniciado (${signal})`);

    const stopTimeout = setTimeout(() => {
      console.log('Timeout de shutdown (30s). Forcando encerramento.');
      process.exit(1);
    }, 30000);

    try {
      await bucketManager.stopAll();
      threadPool.shutdown();
      console.log('Workers e threads encerrados.');
    } catch (err) {
      console.error('Erro ao parar workers:', err.message);
    }

    closeApi();

    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 5000);
    });
    console.log('Servidor HTTP encerrado.');

    logger.system('Sistema encerrado');
    logger.close();
    database.close();

    clearTimeout(stopTimeout);
    console.log('Encerramento completo.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Erro fatal na inicializacao:', err);
  process.exit(1);
});
