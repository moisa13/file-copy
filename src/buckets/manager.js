const { EventEmitter } = require('events');
const database = require('../queue/database');
const WorkerPool = require('../workers');
const logger = require('../logger');

class BucketManager extends EventEmitter {
  constructor() {
    super();
    this.pools = new Map();
  }

  init() {
    const buckets = database.getAllBuckets();
    for (const bucket of buckets) {
      this._createPool(bucket);
    }
    logger.system(`BucketManager inicializado com ${buckets.length} bucket(s)`);
  }

  restoreState() {
    const buckets = database.getAllBuckets();
    for (const bucket of buckets) {
      if (bucket.status === 'running') {
        const pool = this.pools.get(bucket.id);
        if (pool) {
          pool.start();
          logger.system(`Bucket "${bucket.name}" retomado automaticamente (estado anterior: running)`);
        }
      }
    }
  }

  _createPool(bucket) {
    const pool = new WorkerPool(bucket.id, bucket.worker_count);

    pool.on('status-change', (data) => {
      this.emit('status-change', data);
    });

    pool.on('service-change', (data) => {
      this.emit('service-change', data);
    });

    pool.on('copy-progress', (data) => {
      this.emit('copy-progress', data);
    });

    this.pools.set(bucket.id, pool);
    return pool;
  }

  createBucket(data) {
    const bucket = database.createBucket(data);
    this._createPool(bucket);
    this.emit('bucket-update', { action: 'created', bucket });
    logger.system(`Bucket criado: "${bucket.name}" (id=${bucket.id})`);
    return bucket;
  }

  updateBucket(id, data) {
    const pool = this.pools.get(id);
    if (pool && pool.status !== 'stopped') {
      if (data.sourceFolders || data.destinationFolder) {
        throw new Error('Bucket deve estar parado para alterar pastas de origem ou destino');
      }
    }

    const bucket = database.updateBucket(id, data);

    if (data.workerCount && pool) {
      pool.workerCount = data.workerCount;
    }

    this.emit('bucket-update', { action: 'updated', bucket });
    logger.system(`Bucket atualizado: "${bucket.name}" (id=${bucket.id})`);
    return bucket;
  }

  deleteBucket(id) {
    const bucket = database.getBucket(id);
    const pool = this.pools.get(id);

    if (pool) {
      if (pool.status !== 'stopped') {
        throw new Error('Bucket deve estar parado para ser excluído');
      }
      pool.removeAllListeners();
      this.pools.delete(id);
    }

    database.deleteBucket(id);
    this.emit('bucket-update', { action: 'deleted', bucketId: id });
    logger.system(`Bucket excluído: "${bucket ? bucket.name : id}" (id=${id})`);
  }

  getBucket(id) {
    return database.getBucket(id);
  }

  getAllBuckets() {
    return database.getAllBuckets();
  }

  startBucket(id) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    pool.start();
  }

  pauseBucket(id) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    pool.pause();
  }

  resumeBucket(id) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    pool.resume();
  }

  async stopBucket(id) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    await pool.stop();
  }

  setWorkerCount(id, n) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    return pool.setWorkerCount(n);
  }

  getBucketStatus(id) {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Bucket ${id} não encontrado`);
    const bucket = database.getBucket(id);
    return {
      ...pool.getStatus(),
      name: bucket ? bucket.name : null,
    };
  }

  async stopAll() {
    const promises = [];
    for (const [, pool] of this.pools) {
      promises.push(pool.stop());
    }
    await Promise.all(promises);
  }
}

module.exports = new BucketManager();
