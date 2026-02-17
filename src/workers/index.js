const path = require('path');
const { EventEmitter } = require('events');
const config = require('../config');
const database = require('../queue/database');
const logger = require('../logger');
const threadPool = require('./thread-pool');

class WorkerPool extends EventEmitter {
  constructor(bucketId, workerCount) {
    super();
    this.bucketId = bucketId;
    this.status = 'stopped';
    this.workerCount = workerCount || config.workers.defaultCount;
    this.activeWorkers = 0;
    this._loopTimer = null;
    this._stopping = false;
    this._workerIdCounter = 0;
    this._cachedBucket = null;
    this._cachedBucketName = null;
    this._cachedFolderCounts = null;
    this._folderCountsTimestamp = 0;
    this._hadWorkLastLoop = false;
  }

  _refreshBucketCache() {
    const bucket = database.getBucket(this.bucketId);
    this._cachedBucket = bucket;
    this._cachedBucketName = bucket ? bucket.name : String(this.bucketId);
  }

  start() {
    if (this.status === 'running') return;
    this.status = 'running';
    this._stopping = false;
    this._refreshBucketCache();
    database.updateBucketStatus(this.bucketId, 'running');
    this._scheduleLoop();
    this.emit('service-change', { bucketId: this.bucketId });
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    database.updateBucketStatus(this.bucketId, 'paused');
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }
    this.emit('service-change', { bucketId: this.bucketId });
  }

  resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this._refreshBucketCache();
    database.updateBucketStatus(this.bucketId, 'running');
    this._scheduleLoop();
    this.emit('service-change', { bucketId: this.bucketId });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.status === 'stopped') return resolve();
      this.status = 'stopped';
      this._stopping = true;
      database.updateBucketStatus(this.bucketId, 'stopped');

      if (this._loopTimer) {
        clearTimeout(this._loopTimer);
        this._loopTimer = null;
      }

      this.emit('service-change', { bucketId: this.bucketId });

      const check = () => {
        if (this.activeWorkers === 0) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
  }

  setWorkerCount(n) {
    const count = Math.max(1, Math.min(n, config.workers.maxCount));
    this.workerCount = count;
    this._refreshBucketCache();
    database.updateBucket(this.bucketId, { workerCount: count });
    this.emit('service-change', { bucketId: this.bucketId });
    return count;
  }

  getStatus() {
    return {
      bucketId: this.bucketId,
      status: this.status,
      workerCount: this.workerCount,
      activeWorkers: this.activeWorkers,
    };
  }

  _scheduleLoop() {
    if (this._loopTimer) return;
    const interval = this._hadWorkLastLoop || this.activeWorkers > 0 ? 200 : 1000;
    this._loopTimer = setTimeout(() => {
      this._loopTimer = null;
      this._processLoop();
    }, interval);
  }

  _processLoop() {
    if (this.status !== 'running') return;

    const bucket = this._cachedBucket;
    if (!bucket || !bucket.source_folders || bucket.source_folders.length === 0) {
      this._hadWorkLastLoop = false;
      this._scheduleLoop();
      return;
    }

    const now = Date.now();
    if (!this._cachedFolderCounts || now - this._folderCountsTimestamp > 10000) {
      this._cachedFolderCounts = database.getActiveFolderCounts(this.bucketId);
      this._folderCountsTimestamp = now;
    }
    const activeCounts = this._cachedFolderCounts;
    let targetFolder = null;

    for (const folder of bucket.source_folders) {
      const resolved = path.resolve(folder);
      const counts = activeCounts[resolved];
      if (counts && (counts.pending > 0 || counts.inProgress > 0)) {
        targetFolder = resolved;
        break;
      }
    }

    if (targetFolder) {
      const counts = activeCounts[targetFolder];
      if (counts && counts.pending > 0) {
        const slots = this.workerCount - this.activeWorkers;
        if (slots > 0) {
          const files = database.getNextPendingForBucketAndFolder(
            this.bucketId,
            targetFolder,
            slots,
            ++this._workerIdCounter,
          );
          if (files.length > 0) {
            this._cachedFolderCounts = null;
          }
          this._hadWorkLastLoop = files.length > 0;
          for (const file of files) {
            this.activeWorkers++;
            this._processFile(file, file.worker_id).finally(() => {
              this.activeWorkers--;
              this.emit('service-change', { bucketId: this.bucketId });
            });
          }
          this._scheduleLoop();
          return;
        }
      }
    }

    this._hadWorkLastLoop = false;
    this._scheduleLoop();
  }

  async _processFile(file, workerId) {
    const bucketName = this._cachedBucketName || String(this.bucketId);

    this.emit('status-change', {
      bucketId: this.bucketId,
      fileId: file.id,
      status: 'in_progress',
      sourcePath: file.source_path,
    });
    logger.log('in_progress', {
      bucketName,
      sourcePath: file.source_path,
      sourceFolder: file.source_folder,
      fileSize: file.file_size,
      workerId,
      message: 'Inicio da copia',
    });

    const onProgress = (bytesCopied) => {
      this.emit('copy-progress', {
        bucketId: this.bucketId,
        fileId: file.id,
        bytesCopied,
        fileSize: file.file_size,
        percent: file.file_size > 0 ? Math.round((bytesCopied / file.file_size) * 100) : 100,
      });
    };

    try {
      const result = await threadPool.processFile(
        {
          sourcePath: file.source_path,
          destinationPath: file.destination_path,
          fileSize: file.file_size,
        },
        onProgress,
      );

      if (result.result === 'error') {
        database.updateStatusWithMeta(file.id, 'error', this.bucketId, 'in_progress', file.file_size, {
          errorMessage: result.message,
        });
        this.emit('status-change', {
          bucketId: this.bucketId,
          fileId: file.id,
          status: 'error',
          sourcePath: file.source_path,
        });
        logger.log('error', {
          bucketName,
          sourcePath: file.source_path,
          sourceFolder: file.source_folder,
          fileSize: file.file_size,
          workerId,
          message: `Erro: ${result.message}`,
        });
        return;
      }

      if (result.result === 'identical') {
        database.updateStatusWithMeta(file.id, 'completed', this.bucketId, 'in_progress', file.file_size, {
          sourceHash: result.sourceHash,
          destinationHash: result.destHash,
          completedAt: new Date().toISOString(),
        });
        this.emit('status-change', {
          bucketId: this.bucketId,
          fileId: file.id,
          status: 'completed',
          sourcePath: file.source_path,
        });
        logger.log('completed', {
          bucketName,
          sourcePath: file.source_path,
          sourceFolder: file.source_folder,
          fileSize: file.file_size,
          sourceHash: result.sourceHash,
          workerId,
          message: 'Arquivo identico ja existe no destino',
        });
        return;
      }

      if (result.result === 'conflict') {
        database.updateStatusWithMeta(file.id, 'conflict', this.bucketId, 'in_progress', file.file_size, {
          sourceHash: result.sourceHash,
          destinationHash: result.destHash,
        });
        this.emit('status-change', {
          bucketId: this.bucketId,
          fileId: file.id,
          status: 'conflict',
          sourcePath: file.source_path,
        });
        logger.log('conflict', {
          bucketName,
          sourcePath: file.source_path,
          sourceFolder: file.source_folder,
          fileSize: file.file_size,
          sourceHash: result.sourceHash,
          workerId,
          message: `Conflito: hash origem=${result.sourceHash.slice(0, 12)}... destino=${result.destHash.slice(0, 12)}...`,
        });
        return;
      }

      if (result.result === 'integrity_error') {
        database.updateStatusWithMeta(file.id, 'error', this.bucketId, 'in_progress', file.file_size, {
          sourceHash: result.sourceHash,
          destinationHash: result.destHash,
          errorMessage: 'Falha de integridade: hash pos-copia nao confere',
        });
        this.emit('status-change', {
          bucketId: this.bucketId,
          fileId: file.id,
          status: 'error',
          sourcePath: file.source_path,
        });
        logger.log('error', {
          bucketName,
          sourcePath: file.source_path,
          sourceFolder: file.source_folder,
          fileSize: file.file_size,
          sourceHash: result.sourceHash,
          workerId,
          message: 'Falha de integridade: hash pos-copia nao confere',
        });
        return;
      }

      database.updateStatusWithMeta(file.id, 'completed', this.bucketId, 'in_progress', file.file_size, {
        sourceHash: result.sourceHash,
        destinationHash: result.destHash,
        completedAt: new Date().toISOString(),
      });
      this.emit('status-change', {
        bucketId: this.bucketId,
        fileId: file.id,
        status: 'completed',
        sourcePath: file.source_path,
      });
      logger.log('completed', {
        bucketName,
        sourcePath: file.source_path,
        sourceFolder: file.source_folder,
        fileSize: file.file_size,
        sourceHash: result.sourceHash,
        workerId,
        message: 'Copia finalizada com sucesso',
      });
    } catch (err) {
      database.updateStatusWithMeta(file.id, 'error', this.bucketId, 'in_progress', file.file_size, {
        errorMessage: err.message,
      });
      this.emit('status-change', {
        bucketId: this.bucketId,
        fileId: file.id,
        status: 'error',
        sourcePath: file.source_path,
      });
      logger.log('error', {
        bucketName,
        sourcePath: file.source_path,
        sourceFolder: file.source_folder,
        fileSize: file.file_size,
        workerId,
        message: `Erro: ${err.message}`,
      });
    }
  }
}

module.exports = WorkerPool;
