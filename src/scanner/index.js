const fs = require('fs');
const path = require('path');
const config = require('../config');
const database = require('../queue/database');
const logger = require('../logger');

function shouldIgnore(filename) {
  return config.scanner.ignorePatterns.some((pattern) => filename === pattern);
}

async function scanDirectory(dirPath, sourceFolder, destinationFolder, files) {
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

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory() && config.scanner.recursive) {
      await scanDirectory(fullPath, sourceFolder, destinationFolder, files);
    } else if (entry.isFile()) {
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

      files.push({
        sourcePath: fullPath,
        sourceFolder,
        relativePath,
        destinationPath,
        fileSize: stat.size,
        status: 'pending',
        errorMessage: null,
      });
    }
  }
}

async function scanBucket(bucket) {
  const allFiles = [];

  for (const folder of bucket.source_folders) {
    const resolved = path.resolve(folder);

    try {
      await fs.promises.access(resolved);
    } catch {
      logger.system(`[Bucket:${bucket.name}] Pasta de origem não encontrada: ${resolved}`);
      continue;
    }

    await scanDirectory(resolved, resolved, bucket.destination_folder, allFiles);
  }

  let added = 0;
  if (allFiles.length > 0) {
    added = database.addFilesForBucket(bucket.id, allFiles);
  }

  logger.system(
    `[Bucket:${bucket.name}] Varredura concluida: ${allFiles.length} arquivo(s) encontrado(s), ${added} novo(s) adicionado(s) a fila`,
  );

  for (const file of allFiles) {
    logger.log('pending', {
      bucketName: bucket.name,
      sourcePath: file.sourcePath,
      sourceFolder: file.sourceFolder,
      fileSize: file.fileSize,
      message: 'Arquivo adicionado a fila',
    });
  }

  return { found: allFiles.length, added };
}

async function scanAll() {
  const buckets = database.getAllBuckets();
  const results = {};
  let totalFound = 0;
  let totalAdded = 0;

  for (const bucket of buckets) {
    const result = await scanBucket(bucket);
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
