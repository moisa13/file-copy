const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let xxhash = null;
try {
  xxhash = require('xxhash-addon');
} catch (_) {}

let hashAlgorithm = 'xxhash64';
let bufferSize = 524288;

function createHasher() {
  const algo = hashAlgorithm;
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
    const stream = fs.createReadStream(filePath, { highWaterMark: bufferSize });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(digestHasher(hash)));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });
}

function copyFileWithHash(id, sourcePath, destinationPath) {
  const dir = path.dirname(destinationPath);
  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const sourceHash = createHasher();
    const readStream = fs.createReadStream(sourcePath, { highWaterMark: bufferSize });
    const writeStream = fs.createWriteStream(destinationPath, { highWaterMark: bufferSize });
    let destroyed = false;
    let bytesCopied = 0;
    let lastProgressSend = 0;

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
      bytesCopied += chunk.length;
      const now = Date.now();
      if (now - lastProgressSend >= 500) {
        lastProgressSend = now;
        parentPort.postMessage({ id, type: 'progress', bytesCopied });
      }
    });
    readStream.on('error', cleanup);
    writeStream.on('error', cleanup);
    readStream.pipe(writeStream);
    writeStream.on('finish', () => {
      if (!destroyed) {
        resolve({ sourceHash: digestHasher(sourceHash) });
      }
    });
  });
}

async function processFile(msg) {
  const { id, sourcePath, destinationPath, fileSize } = msg;

  try {
    const destExists = fs.existsSync(destinationPath);

    if (destExists) {
      const [sourceHash, destHash] = await Promise.all([computeFileHash(sourcePath), computeFileHash(destinationPath)]);

      if (sourceHash === destHash) {
        parentPort.postMessage({
          id,
          type: 'done',
          result: 'identical',
          sourceHash,
          destHash,
        });
        return;
      }

      parentPort.postMessage({
        id,
        type: 'done',
        result: 'conflict',
        sourceHash,
        destHash,
      });
      return;
    }

    const { sourceHash } = await copyFileWithHash(id, sourcePath, destinationPath);

    parentPort.postMessage({
      id,
      type: 'progress',
      bytesCopied: fileSize || 0,
    });

    const destHash = await computeFileHash(destinationPath);

    if (sourceHash !== destHash) {
      try {
        fs.unlinkSync(destinationPath);
      } catch (_) {}
      parentPort.postMessage({
        id,
        type: 'done',
        result: 'integrity_error',
        sourceHash,
        destHash,
      });
      return;
    }

    parentPort.postMessage({
      id,
      type: 'done',
      result: 'copied',
      sourceHash,
      destHash,
    });
  } catch (err) {
    parentPort.postMessage({
      id,
      type: 'done',
      result: 'error',
      message: err.message,
    });
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    hashAlgorithm = msg.algorithm || 'xxhash64';
    bufferSize = msg.bufferSize || 524288;
    return;
  }
  if (msg.type === 'process') {
    processFile(msg);
  }
});
