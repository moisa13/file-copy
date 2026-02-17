const { Worker } = require('worker_threads');
const path = require('path');
const config = require('../config');

const THREAD_SCRIPT = path.join(__dirname, 'file-thread.js');

class ThreadPool {
  constructor() {
    this._workers = [];
    this._nextIndex = 0;
    this._requestId = 0;
    this._pending = new Map();
    this._initialized = false;
  }

  init() {
    if (this._initialized) return;
    this._initialized = true;

    const count = config.threads.count;
    for (let i = 0; i < count; i++) {
      const worker = new Worker(THREAD_SCRIPT);

      worker.postMessage({
        type: 'init',
        algorithm: config.hashAlgorithm,
        bufferSize: config.copyBufferSize,
      });

      worker.on('message', (msg) => this._handleMessage(msg));

      worker.on('error', (err) => {
        for (const [id, entry] of this._pending) {
          if (entry.workerId === i) {
            this._pending.delete(id);
            entry.reject(err);
          }
        }
      });

      this._workers.push(worker);
    }

    console.log(`Thread pool inicializado com ${count} threads`);
  }

  _handleMessage(msg) {
    const entry = this._pending.get(msg.id);
    if (!entry) return;

    if (msg.type === 'progress') {
      if (entry.onProgress) {
        entry.onProgress(msg.bytesCopied);
      }
      return;
    }

    if (msg.type === 'done') {
      this._pending.delete(msg.id);
      entry.resolve(msg);
    }
  }

  processFile({ sourcePath, destinationPath, fileSize }, onProgress) {
    if (!this._initialized) this.init();

    const id = ++this._requestId;
    const workerIndex = this._nextIndex;
    this._nextIndex = (this._nextIndex + 1) % this._workers.length;

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onProgress, workerId: workerIndex });

      this._workers[workerIndex].postMessage({
        type: 'process',
        id,
        sourcePath,
        destinationPath,
        fileSize,
      });
    });
  }

  shutdown() {
    for (const worker of this._workers) {
      worker.terminate();
    }
    this._workers = [];
    this._pending.clear();
    this._initialized = false;
    this._nextIndex = 0;
  }
}

module.exports = new ThreadPool();
