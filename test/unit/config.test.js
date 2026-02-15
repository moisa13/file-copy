const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function reloadConfig() {
  const key = require.resolve('../../src/config');
  delete require.cache[key];
  return require('../../src/config');
}

describe('config', () => {
  const savedEnv = {};
  const envKeys = [
    'PORT', 'HOST', 'WORKER_DEFAULT_COUNT', 'WORKER_MAX_COUNT',
    'LOG_DIR', 'LOG_MAX_SIZE', 'LOG_MAX_FILES', 'DB_PATH',
    'HASH_ALGORITHM', 'SCANNER_RECURSIVE', 'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX', 'REQUEST_LOG_FORMAT',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) {
        process.env[k] = savedEnv[k];
      } else {
        delete process.env[k];
      }
    }
  });

  it('has expected top-level keys', () => {
    const cfg = reloadConfig();
    assert.ok(cfg.workers);
    assert.ok(cfg.logging);
    assert.ok(cfg.database);
    assert.ok(cfg.server);
    assert.ok(cfg.scanner);
    assert.ok(cfg.rateLimit);
    assert.ok(cfg.requestLog);
    assert.ok(cfg.hashAlgorithm);
  });

  it('defaults port to 3020', () => {
    const cfg = reloadConfig();
    assert.equal(cfg.server.port, 3020);
  });

  it('defaults defaultCount to 4', () => {
    const cfg = reloadConfig();
    assert.equal(cfg.workers.defaultCount, 4);
  });

  it('defaults maxCount to 16', () => {
    const cfg = reloadConfig();
    assert.equal(cfg.workers.maxCount, 16);
  });

  it('defaults hashAlgorithm to sha256', () => {
    const cfg = reloadConfig();
    assert.equal(cfg.hashAlgorithm, 'sha256');
  });

  it('defaults scanner.recursive to true', () => {
    const cfg = reloadConfig();
    assert.equal(cfg.scanner.recursive, true);
  });

  it('overrides port via env var', () => {
    process.env.PORT = '9999';
    const cfg = reloadConfig();
    assert.equal(cfg.server.port, 9999);
  });

  it('uses fallback for invalid integer env var', () => {
    process.env.PORT = 'abc';
    const cfg = reloadConfig();
    assert.equal(cfg.server.port, 3020);
  });

  it('envBool reads false string as false', () => {
    process.env.SCANNER_RECURSIVE = 'false';
    const cfg = reloadConfig();
    assert.equal(cfg.scanner.recursive, false);
  });

  it('envBool reads "1" as true', () => {
    process.env.SCANNER_RECURSIVE = '1';
    const cfg = reloadConfig();
    assert.equal(cfg.scanner.recursive, true);
  });

  it('has ignorePatterns array', () => {
    const cfg = reloadConfig();
    assert.ok(Array.isArray(cfg.scanner.ignorePatterns));
    assert.ok(cfg.scanner.ignorePatterns.includes('.DS_Store'));
  });
});
