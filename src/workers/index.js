const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('../config');
const database = require('../queue/database');
const logger = require('../logger');

let xxhash = null;
try {
  xxhash = require('xxhash-addon');
} catch (_) {}

function createHasher() {
  const algo = config.hashAlgorithm;
  if (algo === 'xxhash64' && xxhash) {
    return new xxhash.XXHash64(Buffer.alloc(8));
  }
  if (algo === 'xxhash3' && xxhash) {
    return new xxhash.XXHash3(Buffer.alloc(8));
  }
  const nativeAlgo = algo.startsWith('xxhash') ? 'sha256' : algo;
  return crypto.createHash(nativeAlgo);
}

function digestHasher(hasher) {
  if (typeof hasher.digest === 'function') {
    const result = hasher.digest();
    if (Buffer.isBuffer(result)) return result.toString('hex');
    return result;
  }
  return hasher.digest('hex');
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHasher();
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(digestHasher(hash)));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });
}

function copyFileWithHash(sourcePath, destinationPath, onProgress) {
  const dir = path.dirname(destinationPath);
  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const sourceHash = createHasher();
    const destHash = createHasher();
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(destinationPath);
    let destroyed = false;
    let bytesCopied = 0;

    function cleanup(err) {
      if (destroyed) return;
      destroyed = true;
      readStream.destroy();
      writeStream.destroy();
      try {
        fs.unlinkSync(destinationPath);
      } catch (_) {}
      reject(err);
    }

    readStream.on('data', (chunk) => {
      sourceHash.update(chunk);
      destHash.update(chunk);
      bytesCopied += chunk.length;
      if (onProgress) onProgress(bytesCopied);
    });
    readStream.on('error', cleanup);
    writeStream.on('error', cleanup);
    readStream.pipe(writeStream);
    writeStream.on('finish', () => {
      if (!destroyed) {
        resolve({
          sourceHash: digestHasher(sourceHash),
          destHash: digestHasher(destHash),
        });
      }
    });
  });
}

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

    try {
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

      const destExists = fs.existsSync(file.destination_path);

      if (destExists) {
        const sourceHash = await computeFileHash(file.source_path);
        const destHash = await computeFileHash(file.destination_path);

        if (sourceHash === destHash) {
          database.updateStatus(file.id, 'completed', {
            sourceHash,
            destinationHash: destHash,
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
            sourceHash,
            workerId,
            message: 'Arquivo identico ja existe no destino',
          });
          return;
        }

        database.updateStatus(file.id, 'conflict', {
          sourceHash,
          destinationHash: destHash,
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
          sourceHash,
          workerId,
          message: `Conflito: hash origem=${sourceHash.slice(0, 12)}... destino=${destHash.slice(0, 12)}...`,
        });
        return;
      }

      let lastProgressEmit = 0;
      const onProgress = (bytesCopied) => {
        const now = Date.now();
        if (now - lastProgressEmit < 500) return;
        lastProgressEmit = now;
        this.emit('copy-progress', {
          bucketId: this.bucketId,
          fileId: file.id,
          bytesCopied,
          fileSize: file.file_size,
          percent: file.file_size > 0 ? Math.round((bytesCopied / file.file_size) * 100) : 100,
        });
      };

      const { sourceHash, destHash } = await copyFileWithHash(file.source_path, file.destination_path, onProgress);

      if (sourceHash !== destHash) {
        try {
          fs.unlinkSync(file.destination_path);
        } catch (_) {}
        database.updateStatus(file.id, 'error', {
          sourceHash,
          destinationHash: destHash,
          errorMessage: 'Falha de integridade: hash pós-cópia não confere',
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
          sourceHash,
          workerId,
          message: 'Falha de integridade: hash pós-cópia não confere',
        });
        return;
      }

      database.updateStatus(file.id, 'completed', {
        sourceHash,
        destinationHash: destHash,
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
        sourceHash,
        workerId,
        message: 'Copia finalizada com sucesso',
      });
    } catch (err) {
      database.updateStatus(file.id, 'error', {
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
