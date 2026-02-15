const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB, createMockBucketManager } = require('../helpers/setup');
const { makeBucketData, makeFileRecords } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const BucketService = require('../../src/services/bucket-service');
const { NotFoundError, ValidationError } = require('../../src/errors');

describe('BucketService', () => {
  let db, mgr, service;

  beforeEach(() => {
    db = createTestDB();
    mgr = createMockBucketManager();

    mock.method(database, 'getStatsByBucket', (id) => db.getStatsByBucket(id));
    mock.method(database, 'getStatsByBucketGroupedByFolder', (id) => db.getStatsByBucketGroupedByFolder(id));
    mock.method(database, 'getFilesByStatusForBucket', (id, s, l, o) => db.getFilesByStatusForBucket(id, s, l, o));
    mock.method(database, 'getRecentActivityForBucket', (id, l) => db.getRecentActivityForBucket(id, l));

    service = new BucketService(mgr);
  });

  it('getAllBuckets returns buckets with poolStatus', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getAllBuckets.mock.mockImplementation(() => [bucket]);
    const result = service.getAllBuckets();
    assert.ok(Array.isArray(result));
    assert.ok('poolStatus' in result[0]);
  });

  it('getBucket returns bucket with poolStatus', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const result = service.getBucket(bucket.id);
    assert.ok('poolStatus' in result);
  });

  it('getBucket throws NotFoundError if not found', () => {
    mgr.getBucket.mock.mockImplementation(() => null);
    assert.throws(() => service.getBucket(999), (err) => err instanceof NotFoundError);
  });

  it('createBucket delegates to bucketManager', () => {
    const data = makeBucketData();
    const bucket = { id: 1, ...data };
    mgr.createBucket.mock.mockImplementation(() => bucket);
    const result = service.createBucket(data);
    assert.equal(result.id, 1);
    assert.equal(mgr.createBucket.mock.calls.length, 1);
  });

  it('createBucket converts error to ValidationError', () => {
    mgr.createBucket.mock.mockImplementation(() => { throw new Error('dup'); });
    assert.throws(() => service.createBucket(makeBucketData()), (err) => err instanceof ValidationError);
  });

  it('updateBucket verifies existence first', () => {
    mgr.getBucket.mock.mockImplementation(() => null);
    assert.throws(() => service.updateBucket(999, { name: 'x' }), (err) => err instanceof NotFoundError);
  });

  it('updateBucket delegates on success', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    mgr.updateBucket.mock.mockImplementation((id, data) => ({ ...bucket, ...data }));
    const result = service.updateBucket(bucket.id, { name: 'new' });
    assert.equal(result.name, 'new');
  });

  it('deleteBucket verifies existence first', () => {
    mgr.getBucket.mock.mockImplementation(() => null);
    assert.throws(() => service.deleteBucket(999), (err) => err instanceof NotFoundError);
  });

  it('deleteBucket returns { deleted: true }', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    mgr.deleteBucket.mock.mockImplementation(() => {});
    const result = service.deleteBucket(bucket.id);
    assert.deepEqual(result, { deleted: true });
  });

  it('getStats verifies existence', () => {
    mgr.getBucket.mock.mockImplementation(() => null);
    assert.throws(() => service.getStats(999), (err) => err instanceof NotFoundError);
  });

  it('getStats returns stats', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const stats = service.getStats(bucket.id);
    assert.ok('pending' in stats);
  });

  it('getFolders returns array', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const result = service.getFolders(bucket.id);
    assert.ok(Array.isArray(result));
  });

  it('getFiles verifies existence and delegates', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const files = service.getFiles(bucket.id, 'pending', 100, 0);
    assert.equal(files.length, 3);
  });

  it('getActivity verifies existence and delegates', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const activity = service.getActivity(bucket.id, 10);
    assert.ok(Array.isArray(activity));
  });

  it('exportFiles verifies existence', () => {
    const bucket = db.createBucket(makeBucketData());
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const result = service.exportFiles(bucket.id, 'all');
    assert.ok(Array.isArray(result));
  });
});
