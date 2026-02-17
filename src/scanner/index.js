const fs = require('fs');
const path = require('path');
const config = require('../config');
const database = require('../queue/database');
const logger = require('../logger');

const BATCH_SIZE = 5000;
const DIR_CONCURRENCY = 8;

function shouldIgnore(filename) {
  return config.scanner.ignorePatterns.some((pattern) => filename === pattern);
}

async function parallelMap(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanDirectory(dirPath, sourceFolder, destinationFolder, ctx) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logger.log('error', {
      sourcePath: dirPath,
      sourceFolder,
      message: `Erro ao ler diretorio: ${err.message}`,
    });
    return;
  }

  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    if (entry.isDirectory() && config.scanner.recursive) {
      dirs.push(path.join(dirPath, entry.name));
    } else if (entry.isFile()) {
      files.push(path.join(dirPath, entry.name));
    }
  }

  for (const fullPath of files) {
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (err) {
      logger.log('error', {
        sourcePath: fullPath,
        sourceFolder,
        message: `Erro ao obter stat: ${err.message}`,
      });
      continue;
    }

    const relativePath = path.relative(sourceFolder, fullPath);
    const destinationPath = path.join(destinationFolder, relativePath);

    ctx.buffer.push({
      sourcePath: fullPath,
      sourceFolder,
      relativePath,
      destinationPath,
      fileSize: stat.size,
      status: 'pending',
      errorMessage: null,
    });

    if (ctx.buffer.length >= BATCH_SIZE) {
      ctx.flush();
    }
  }

  if (dirs.length > 0) {
    await parallelMap(dirs, (dir) => scanDirectory(dir, sourceFolder, destinationFolder, ctx), DIR_CONCURRENCY);
  }
}

async function scanBucket(bucket, onBatch) {
  let totalFound = 0;
  let totalAdded = 0;

  const ctx = {
    buffer: [],
    flush() {
      const batch = ctx.buffer.splice(0);
      if (batch.length === 0) return;

      const added = database.addFilesForBucket(bucket.id, batch);
      totalFound += batch.length;
      totalAdded += added;

      for (const file of batch) {
        logger.log('pending', {
          bucketName: bucket.name,
          sourcePath: file.sourcePath,
          sourceFolder: file.sourceFolder,
          fileSize: file.fileSize,
          message: 'Arquivo adicionado a fila',
        });
      }

      if (onBatch) onBatch({ found: totalFound, added: totalAdded });
    },
  };

  for (const folder of bucket.source_folders) {
    const resolved = path.resolve(folder);

    try {
      await fs.promises.access(resolved);
    } catch {
      logger.system(`[Bucket:${bucket.name}] Pasta de origem não encontrada: ${resolved}`);
      continue;
    }

    await scanDirectory(resolved, resolved, bucket.destination_folder, ctx);
  }

  ctx.flush();

  logger.system(
    `[Bucket:${bucket.name}] Varredura concluida: ${totalFound} arquivo(s) encontrado(s), ${totalAdded} novo(s) adicionado(s) a fila`,
  );

  return { found: totalFound, added: totalAdded };
}

async function scanAll(onBatch) {
  const buckets = database.getAllBuckets();
  const results = {};
  let totalFound = 0;
  let totalAdded = 0;

  for (const bucket of buckets) {
    const result = await scanBucket(bucket, onBatch ? (partial) => onBatch(bucket.id, partial) : null);
    results[bucket.id] = { name: bucket.name, ...result };
    totalFound += result.found;
    totalAdded += result.added;
  }

  logger.system(
    `Varredura global concluida: ${buckets.length} bucket(s), ${totalFound} arquivo(s) encontrado(s), ${totalAdded} novo(s)`,
  );

  return { buckets: results, totalFound, totalAdded };
}

module.exports = { scanBucket, scanAll };
