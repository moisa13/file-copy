const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const WorkerPool = require('../../src/workers');

describe('WorkerPool', () => {
  let db, bucket;

  beforeEach(() => {
    db = createTestDB();
    mock.method(database, 'updateBucketStatus', () => {});
    mock.method(database, 'updateBucket', () => {});
    mock.method(database, 'getBucket', (id) => db.getBucket(id));
    mock.method(database, 'getActiveFolderCounts', (id) => db.getActiveFolderCounts(id));
    mock.method(database, 'getNextPendingForBucketAndFolder', () => []);

    bucket = db.createBucket(makeBucketData());
  });

  it('constructor sets status to stopped', () => {
    const pool = new WorkerPool(bucket.id, 4);
    assert.equal(pool.status, 'stopped');
  });

  it('constructor sets activeWorkers to 0', () => {
    const pool = new WorkerPool(bucket.id, 4);
    assert.equal(pool.activeWorkers, 0);
  });

  it('start sets status to running', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    assert.equal(pool.status, 'running');
    pool.stop();
  });

  it('start emits service-change', () => {
    const pool = new WorkerPool(bucket.id, 4);
    let emitted = false;
    pool.on('service-change', () => { emitted = true; });
    pool.start();
    assert.ok(emitted);
    pool.stop();
  });

  it('start when already running is no-op', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    let count = 0;
    pool.on('service-change', () => { count++; });
    pool.start();
    assert.equal(count, 0);
    pool.stop();
  });

  it('pause sets status to paused', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    pool.pause();
    assert.equal(pool.status, 'paused');
  });

  it('pause emits service-change', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    let emitted = false;
    pool.on('service-change', () => { emitted = true; });
    pool.pause();
    assert.ok(emitted);
  });

  it('pause when not running is no-op', () => {
    const pool = new WorkerPool(bucket.id, 4);
    let count = 0;
    pool.on('service-change', () => { count++; });
    pool.pause();
    assert.equal(count, 0);
  });

  it('resume sets paused to running', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    pool.pause();
    pool.resume();
    assert.equal(pool.status, 'running');
    pool.stop();
  });

  it('resume emits service-change', () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    pool.pause();
    let emitted = false;
    pool.on('service-change', () => { emitted = true; });
    pool.resume();
    assert.ok(emitted);
    pool.stop();
  });

  it('resume when not paused is no-op', () => {
    const pool = new WorkerPool(bucket.id, 4);
    let count = 0;
    pool.on('service-change', () => { count++; });
    pool.resume();
    assert.equal(count, 0);
  });

  it('stop returns a promise and sets status to stopped', async () => {
    const pool = new WorkerPool(bucket.id, 4);
    pool.start();
    await pool.stop();
    assert.equal(pool.status, 'stopped');
  });

  it('stop when already stopped resolves immediately', async () => {
    const pool = new WorkerPool(bucket.id, 4);
    await pool.stop();
    assert.equal(pool.status, 'stopped');
  });

  it('setWorkerCount clamps between 1 and maxCount', () => {
    const pool = new WorkerPool(bucket.id, 4);
    const result1 = pool.setWorkerCount(0);
    assert.equal(result1, 1);
    const result2 = pool.setWorkerCount(999);
    assert.equal(result2, 16);
  });

  it('getStatus returns correct shape', () => {
    const pool = new WorkerPool(bucket.id, 4);
    const status = pool.getStatus();
    assert.equal(status.bucketId, bucket.id);
    assert.equal(status.status, 'stopped');
    assert.equal(status.workerCount, 4);
    assert.equal(status.activeWorkers, 0);
  });
});
