const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const logger = require('../../src/logger');

describe('BucketManager', () => {
  let db;

  function createManager() {
    delete require.cache[require.resolve('../../src/buckets/manager')];
    return require('../../src/buckets/manager');
  }

  beforeEach(() => {
    db = createTestDB();

    mock.method(database, 'getAllBuckets', () => db.getAllBuckets());
    mock.method(database, 'createBucket', (data) => db.createBucket(data));
    mock.method(database, 'getBucket', (id) => db.getBucket(id));
    mock.method(database, 'updateBucket', (id, data) => db.updateBucket(id, data));
    mock.method(database, 'updateBucketStatus', (id, status) => db.updateBucketStatus(id, status));
    mock.method(database, 'deleteBucket', (id) => db.deleteBucket(id));
    mock.method(database, 'getActiveFolderCounts', () => ({}));
    mock.method(database, 'getNextPendingForBucketAndFolder', () => []);
    mock.method(logger, 'system', () => {});
    mock.method(logger, 'log', () => {});
  });

  it('init creates pools for existing buckets', () => {
    db.createBucket(makeBucketData());
    db.createBucket(makeBucketData());
    const mgr = createManager();
    mgr.init();
    assert.equal(mgr.pools.size, 2);
  });

  it('createBucket creates in DB and creates pool', () => {
    const mgr = createManager();
    mgr.init();
    const data = makeBucketData();
    const bucket = mgr.createBucket(data);
    assert.ok(bucket.id > 0);
    assert.ok(mgr.pools.has(bucket.id));
  });

  it('createBucket emits bucket-update', () => {
    const mgr = createManager();
    mgr.init();
    let emitted = false;
    mgr.on('bucket-update', (e) => {
      if (e.action === 'created') emitted = true;
    });
    mgr.createBucket(makeBucketData());
    assert.ok(emitted);
  });

  it('updateBucket blocks path changes if bucket is running', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    assert.throws(() => {
      mgr.updateBucket(bucket.id, { sourceFolders: ['/new'] });
    });
    mgr.stopBucket(bucket.id);
  });

  it('updateBucket allows workerCount while running', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    assert.doesNotThrow(() => {
      mgr.updateBucket(bucket.id, { workerCount: 8 });
    });
    mgr.stopBucket(bucket.id);
  });

  it('deleteBucket throws if pool is not stopped', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    assert.throws(() => mgr.deleteBucket(bucket.id));
    mgr.stopBucket(bucket.id);
  });

  it('deleteBucket removes pool and deletes from DB', async () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.deleteBucket(bucket.id);
    assert.ok(!mgr.pools.has(bucket.id));
    assert.equal(db.getBucket(bucket.id), null);
  });

  it('startBucket delegates to pool', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    const pool = mgr.pools.get(bucket.id);
    assert.equal(pool.status, 'running');
    pool.stop();
  });

  it('pauseBucket delegates to pool', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    mgr.pauseBucket(bucket.id);
    const pool = mgr.pools.get(bucket.id);
    assert.equal(pool.status, 'paused');
    pool.stop();
  });

  it('resumeBucket delegates to pool', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    mgr.pauseBucket(bucket.id);
    mgr.resumeBucket(bucket.id);
    const pool = mgr.pools.get(bucket.id);
    assert.equal(pool.status, 'running');
    pool.stop();
  });

  it('stopBucket delegates to pool', async () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(bucket.id);
    await mgr.stopBucket(bucket.id);
    const pool = mgr.pools.get(bucket.id);
    assert.equal(pool.status, 'stopped');
  });

  it('pool not found throws error', () => {
    const mgr = createManager();
    mgr.init();
    assert.throws(() => mgr.startBucket(9999));
  });

  it('stopAll stops all pools', async () => {
    const mgr = createManager();
    const b1 = db.createBucket(makeBucketData());
    const b2 = db.createBucket(makeBucketData());
    mgr.init();
    mgr.startBucket(b1.id);
    mgr.startBucket(b2.id);
    await mgr.stopAll();
    assert.equal(mgr.pools.get(b1.id).status, 'stopped');
    assert.equal(mgr.pools.get(b2.id).status, 'stopped');
  });

  it('getBucketStatus returns correct shape', () => {
    const mgr = createManager();
    const bucket = db.createBucket(makeBucketData());
    mgr.init();
    const status = mgr.getBucketStatus(bucket.id);
    assert.ok('status' in status);
    assert.ok('workerCount' in status);
    assert.ok('activeWorkers' in status);
    assert.ok('name' in status);
  });
});
