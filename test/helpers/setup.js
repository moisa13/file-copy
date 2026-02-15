const path = require('path');
const os = require('os');
const fs = require('fs');
const { mock } = require('node:test');

const tmpBase = path.join(os.tmpdir(), 'fcm-test');
fs.mkdirSync(tmpBase, { recursive: true });

const config = require('../../src/config');
config.database.path = ':memory:';
config.logging.directory = fs.mkdtempSync(path.join(tmpBase, 'logs-'));

const { FileQueueDB } = require('../../src/queue/database');

function createTestDB() {
  return new FileQueueDB();
}

function createMockLogger() {
  return {
    log: mock.fn(),
    system: mock.fn(),
    close: mock.fn(),
  };
}

function createMockBucketManager() {
  return {
    pools: new Map(),
    getBucket: mock.fn(),
    getAllBuckets: mock.fn(() => []),
    createBucket: mock.fn(),
    updateBucket: mock.fn(),
    deleteBucket: mock.fn(),
    startBucket: mock.fn(),
    pauseBucket: mock.fn(),
    resumeBucket: mock.fn(),
    stopBucket: mock.fn(async () => {}),
    setWorkerCount: mock.fn(),
    getBucketStatus: mock.fn(),
    on: mock.fn(),
    emit: mock.fn(),
    removeAllListeners: mock.fn(),
  };
}

module.exports = { config, createTestDB, createMockLogger, createMockBucketManager };
