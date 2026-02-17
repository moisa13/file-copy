const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const config = require('../config');
const database = require('../queue/database');
const { validate, errorHandler, asyncHandler } = require('./middleware');
const BucketService = require('../services/bucket-service');
const ServiceControlService = require('../services/service-control-service');
const FileService = require('../services/file-service');
const ScannerService = require('../services/scanner-service');
const HealthService = require('../services/health-service');
const {
  bucketParamsSchema,
  fileParamsSchema,
  statusParamsSchema,
  bucketStatusParamsSchema,
  bucketCreateSchema,
  bucketUpdateSchema,
  workerCountSchema,
  conflictResolutionSchema,
  paginationSchema,
  activityQuerySchema,
} = require('../validation/schemas');

function createServer(bucketManager) {
  const app = express();

  app.use(compression());
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  app.use(
    morgan(config.requestLog.format, {
      skip: (req) => req.url === '/api/health',
    }),
  );

  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Muitas requisições, tente novamente mais tarde' } },
  });
  app.use('/api/', limiter);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const bucketService = new BucketService(bucketManager);
  const serviceControl = new ServiceControlService(bucketManager);
  const fileService = new FileService();
  const scannerService = new ScannerService(bucketManager, broadcast);
  const healthService = new HealthService(bucketManager);

  const openApiSpec = require('./openapi.json');
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
    }),
  );

  app.get('/api/health', (_req, res) => {
    const health = healthService.getHealth();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(health);
  });

  app.get('/api/metrics', (_req, res) => {
    res.json(healthService.getMetrics());
  });

  app.get('/api/buckets', (_req, res) => {
    res.json(bucketService.getAllBuckets());
  });

  app.get(
    '/api/buckets/:id',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      res.json(bucketService.getBucket(req.validated.params.id));
    }),
  );

  app.post(
    '/api/buckets',
    validate(bucketCreateSchema, 'body'),
    asyncHandler(async (req, res) => {
      const bucket = bucketService.createBucket(req.validated.body);
      broadcast('bucket-update', { action: 'created', bucket });
      res.status(201).json(bucket);
    }),
  );

  app.put(
    '/api/buckets/:id',
    validate(bucketParamsSchema, 'params'),
    validate(bucketUpdateSchema, 'body'),
    asyncHandler(async (req, res) => {
      const updated = bucketService.updateBucket(req.validated.params.id, req.validated.body);
      broadcast('bucket-update', { action: 'updated', bucket: updated });
      res.json(updated);
    }),
  );

  app.delete(
    '/api/buckets/:id',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const id = req.validated.params.id;
      const result = bucketService.deleteBucket(id);
      broadcast('bucket-update', { action: 'deleted', bucketId: id });
      res.json(result);
    }),
  );

  app.get(
    '/api/buckets/:id/stats',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      res.json(bucketService.getStats(req.validated.params.id));
    }),
  );

  app.get(
    '/api/buckets/:id/folders',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      res.json(bucketService.getFolders(req.validated.params.id));
    }),
  );

  app.get(
    '/api/buckets/:id/files/:status',
    validate(bucketStatusParamsSchema, 'params'),
    validate(paginationSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { id, status } = req.validated.params;
      const { limit, offset } = req.validated.query;
      res.json(bucketService.getFiles(id, status, limit, offset));
    }),
  );

  app.get(
    '/api/buckets/:id/activity',
    validate(bucketParamsSchema, 'params'),
    validate(activityQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      res.json(bucketService.getActivity(req.validated.params.id, req.validated.query.limit));
    }),
  );

  app.get(
    '/api/buckets/:id/service',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      res.json(serviceControl.getStatus(req.validated.params.id));
    }),
  );

  app.post(
    '/api/buckets/:id/service/start',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const status = serviceControl.start(req.validated.params.id);
      broadcast('service-update', status);
      res.json(status);
    }),
  );

  app.post(
    '/api/buckets/:id/service/pause',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const status = serviceControl.pause(req.validated.params.id);
      broadcast('service-update', status);
      res.json(status);
    }),
  );

  app.post(
    '/api/buckets/:id/service/resume',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const status = serviceControl.resume(req.validated.params.id);
      broadcast('service-update', status);
      res.json(status);
    }),
  );

  app.post(
    '/api/buckets/:id/service/stop',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const status = await serviceControl.stop(req.validated.params.id);
      broadcast('service-update', status);
      res.json(status);
    }),
  );

  app.post(
    '/api/buckets/:id/service/workers',
    validate(bucketParamsSchema, 'params'),
    validate(workerCountSchema, 'body'),
    asyncHandler(async (req, res) => {
      const status = serviceControl.setWorkerCount(req.validated.params.id, req.validated.body.count);
      broadcast('service-update', status);
      res.json(status);
    }),
  );

  app.post(
    '/api/buckets/:id/scan',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const result = scannerService.scanBucket(req.validated.params.id);
      res.status(202).json(result);
    }),
  );

  app.post(
    '/api/buckets/:id/conflicts/:fileId/resolve',
    validate(fileParamsSchema, 'params'),
    validate(conflictResolutionSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { id, fileId } = req.validated.params;
      const result = fileService.resolveConflictForBucket(id, fileId, req.validated.body.action);
      broadcast('stats-update', database.getStatsByBucket(id));
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/buckets/:id/conflicts/resolve-all',
    validate(bucketParamsSchema, 'params'),
    validate(conflictResolutionSchema, 'body'),
    asyncHandler(async (req, res) => {
      const id = req.validated.params.id;
      const result = fileService.resolveAllConflictsForBucket(id, req.validated.body.action);
      broadcast('stats-update', database.getStatsByBucket(id));
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/buckets/:id/errors/:fileId/retry',
    validate(fileParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const { id, fileId } = req.validated.params;
      const result = fileService.retryErrorForBucket(id, fileId);
      broadcast('stats-update', database.getStatsByBucket(id));
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/buckets/:id/errors/retry-all',
    validate(bucketParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const id = req.validated.params.id;
      const result = fileService.retryAllErrorsForBucket(id);
      broadcast('stats-update', database.getStatsByBucket(id));
      res.json({ changes: result.changes });
    }),
  );

  app.get(
    '/api/buckets/:id/export/:status',
    validate(bucketStatusParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const { id, status } = req.validated.params;
      const bucket = bucketService.getBucket(id);
      if (!bucket) return res.status(404).json({ error: 'Bucket não encontrado' });
      const iterator = database.iterateFilesByStatus(status, id);
      sendCsvStream(res, iterator, status);
    }),
  );

  app.get('/api/buckets-summary', (_req, res) => {
    const allBuckets = bucketService.getAllBuckets();
    const summary = allBuckets.map((b) => {
      const stats = database.getStatsByBucket(b.id);
      return { id: b.id, name: b.name, poolStatus: b.poolStatus, stats };
    });
    res.json(summary);
  });

  app.get('/api/stats', (_req, res) => {
    res.json(fileService.getGlobalStats());
  });

  app.get(
    '/api/files/:status',
    validate(statusParamsSchema, 'params'),
    validate(paginationSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { limit, offset } = req.validated.query;
      res.json(fileService.getFilesByStatus(req.validated.params.status, limit, offset));
    }),
  );

  app.post(
    '/api/conflicts/:fileId/resolve',
    validate(conflictResolutionSchema, 'body'),
    asyncHandler(async (req, res) => {
      const fileId = parseInt(req.params.fileId);
      const result = fileService.resolveConflict(fileId, req.validated.body.action);
      broadcast('stats-update-global', fileService.getGlobalStats());
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/conflicts/resolve-all',
    validate(conflictResolutionSchema, 'body'),
    asyncHandler(async (req, res) => {
      const result = fileService.resolveAllConflicts(req.validated.body.action);
      broadcast('stats-update-global', fileService.getGlobalStats());
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/errors/:fileId/retry',
    asyncHandler(async (req, res) => {
      const result = fileService.retryError(parseInt(req.params.fileId));
      broadcast('stats-update-global', fileService.getGlobalStats());
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/errors/retry-all',
    asyncHandler(async (_req, res) => {
      const result = fileService.retryAllErrors();
      broadcast('stats-update-global', fileService.getGlobalStats());
      res.json({ changes: result.changes });
    }),
  );

  app.post(
    '/api/scan',
    asyncHandler(async (_req, res) => {
      const result = scannerService.scanAll();
      res.status(202).json(result);
    }),
  );

  app.get(
    '/api/export/:status',
    validate(statusParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const iterator = database.iterateFilesByStatus(req.validated.params.status);
      sendCsvStream(res, iterator, req.validated.params.status);
    }),
  );

  function sendCsvStream(res, iterator, status) {
    const header =
      'id;arquivo;pasta_origem;caminho_destino;tamanho_bytes;status;hash_origem;hash_destino;erro;criado_em;atualizado_em';
    const filename = `arquivos-${status}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF' + header + '\n');
    for (const f of iterator) {
      const row = [
        f.id,
        f.relative_path,
        f.source_folder,
        f.destination_path,
        f.file_size,
        f.status,
        f.source_hash || '',
        f.destination_hash || '',
        (f.error_message || '').replace(/;/g, ','),
        f.created_at,
        f.updated_at,
      ].join(';');
      res.write(row + '\n');
    }
    res.end();
  }

  app.use(errorHandler(broadcast));

  const wss = new WebSocketServer({ noServer: true });

  function broadcast(event, data) {
    const message = JSON.stringify({ event, data });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }

  const _pendingStatsBuckets = new Set();
  let _pendingGlobalStats = false;
  let _flushStatsTimer = null;
  let _statsDirty = false;

  function scheduleStatsBroadcast(bucketId) {
    if (bucketId) _pendingStatsBuckets.add(bucketId);
    _pendingGlobalStats = true;
    _statsDirty = true;
    if (_flushStatsTimer) return;
    _flushStatsTimer = setTimeout(flushStatsBroadcast, 250);
  }

  function flushStatsBroadcast() {
    _flushStatsTimer = null;
    for (const bid of _pendingStatsBuckets) {
      broadcast('stats-update', database.getStatsByBucket(bid));
    }
    _pendingStatsBuckets.clear();
    if (_pendingGlobalStats) {
      broadcast('stats-update-global', database.getStats());
      _pendingGlobalStats = false;
    }
  }

  bucketManager.on('status-change', (data) => {
    broadcast('status-update', { ...data, timestamp: new Date().toISOString() });
    scheduleStatsBroadcast(data.bucketId);
  });

  const _progressBuffer = new Map();
  let _progressFlushTimer = null;

  function flushProgressBuffer() {
    _progressFlushTimer = null;
    if (_progressBuffer.size === 0) return;
    const batch = Array.from(_progressBuffer.values());
    _progressBuffer.clear();
    broadcast('copy-progress-batch', batch);
  }

  bucketManager.on('copy-progress', (data) => {
    _progressBuffer.set(data.fileId, data);
    if (!_progressFlushTimer) {
      _progressFlushTimer = setTimeout(flushProgressBuffer, 500);
    }
  });

  bucketManager.on('service-change', (data) => {
    if (data.bucketId) {
      try {
        broadcast('service-update', bucketManager.getBucketStatus(data.bucketId));
      } catch (_) {}
    }
  });

  let statsInterval = null;

  function startStatsTimer() {
    statsInterval = setInterval(() => {
      if (!_statsDirty) return;
      _statsDirty = false;
      broadcast('stats-update-global', database.getStats());
    }, 2000);
  }

  function close() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    if (_flushStatsTimer) {
      clearTimeout(_flushStatsTimer);
      _flushStatsTimer = null;
    }
    if (_progressFlushTimer) {
      clearTimeout(_progressFlushTimer);
      _progressFlushTimer = null;
    }
    wss.clients.forEach((client) => client.terminate());
    wss.close();
  }

  return { app, wss, broadcast, startStatsTimer, close };
}

module.exports = { createServer };
