const path = require('path');

function env(key, fallback) {
  return process.env[key] !== undefined ? process.env[key] : fallback;
}

function envInt(key, fallback) {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function envBool(key, fallback) {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

module.exports = {
  workers: {
    defaultCount: envInt('WORKER_DEFAULT_COUNT', 4),
    maxCount: envInt('WORKER_MAX_COUNT', 16),
  },

  logging: {
    directory: env('LOG_DIR', path.join(__dirname, '..', 'logs')),
    maxFileSize: env('LOG_MAX_SIZE', '10M'),
    maxFiles: envInt('LOG_MAX_FILES', 50),
  },

  database: {
    path: env('DB_PATH', path.join(__dirname, '..', 'data', 'queue.db')),
  },

  server: {
    port: envInt('PORT', 3020),
    host: env('HOST', '0.0.0.0'),
  },

  hashAlgorithm: env('HASH_ALGORITHM', 'xxhash64'),

  scanner: {
    recursive: envBool('SCANNER_RECURSIVE', true),
    ignorePatterns: ['.DS_Store', 'Thumbs.db', '.gitkeep'],
  },

  rateLimit: {
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
    max: envInt('RATE_LIMIT_MAX', 200),
  },

  requestLog: {
    format: env('REQUEST_LOG_FORMAT', 'short'),
  },
};
