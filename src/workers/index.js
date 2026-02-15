const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('../config');
const database = require('../queue/database');
const logger = require('../logger');

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(config.hashAlgorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
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
    const hash = crypto.createHash(config.hashAlgorithm);
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
      hash.update(chunk);
      bytesCopied += chunk.length;
      if (onProgress) onProgress(bytesCopied);
    });
    readStream.on('error', cleanup);
    writeStream.on('error', cleanup);
    readStream.pipe(writeStream);
    writeStream.on('finish', () => {
      if (!destroyed) resolve(hash.digest('hex'));
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
  }

  start() {
    if (this.status === 'running') return;
    this.status = 'running';
    this._stopping = false;
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
    this._loopTimer = setTimeout(() => {
      this._loopTimer = null;
      this._processLoop();
    }, 200);
  }

  _processLoop() {
    if (this.status !== 'running') return;

    const bucket = database.getBucket(this.bucketId);
    if (!bucket || !bucket.source_folders || bucket.source_folders.length === 0) {
      this._scheduleLoop();
      return;
    }

    const activeCounts = database.getActiveFolderCounts(this.bucketId);
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
          for (const file of files) {
            this.activeWorkers++;
            this._processFile(file, file.worker_id).finally(() => {
              this.activeWorkers--;
              this.emit('service-change', { bucketId: this.bucketId });
            });
          }
        }
      }
    }

    this._scheduleLoop();
  }

  async _processFile(file, workerId) {
    const bucket = database.getBucket(this.bucketId);
    const bucketName = bucket ? bucket.name : String(this.bucketId);

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

      const sourceHash = await copyFileWithHash(file.source_path, file.destination_path, onProgress);
      const destHash = await computeFileHash(file.destination_path);

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
