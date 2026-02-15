const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData, makeFileRecords } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const FileService = require('../../src/services/file-service');

describe('FileService', () => {
  let db, service;

  beforeEach(() => {
    db = createTestDB();

    mock.method(database, 'getStats', () => db.getStats());
    mock.method(database, 'getFilesByStatus', (s, l, o) => db.getFilesByStatus(s, l, o));
    mock.method(database, 'resolveConflict', (id, a) => db.resolveConflict(id, a));
    mock.method(database, 'resolveAllConflicts', (a) => db.resolveAllConflicts(a));
    mock.method(database, 'resolveAllConflictsForBucket', (bid, a) => db.resolveAllConflictsForBucket(bid, a));
    mock.method(database, 'retryError', (id) => db.retryError(id));
    mock.method(database, 'retryAllErrors', () => db.retryAllErrors());
    mock.method(database, 'retryAllErrorsForBucket', (bid) => db.retryAllErrorsForBucket(bid));

    service = new FileService();
  });

  it('getGlobalStats returns stats', () => {
    const stats = service.getGlobalStats();
    assert.ok('pending' in stats);
    assert.ok('completed' in stats);
  });

  it('getFilesByStatus delegates correctly', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
    const result = service.getFilesByStatus('pending', 100, 0);
    assert.equal(result.length, 3);
  });

  it('resolveConflict delegates with id and action', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
    const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
    db.updateStatus(file.id, 'conflict', { sourceHash: 'a', destinationHash: 'b' });
    const result = service.resolveConflict(file.id, 'skip');
    assert.ok(result.changes >= 1);
  });

  it('resolveAllConflicts delegates with action', () => {
    const result = service.resolveAllConflicts('overwrite');
    assert.ok('changes' in result);
  });

  it('resolveConflictForBucket delegates', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
    const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
    db.updateStatus(file.id, 'conflict', { sourceHash: 'a', destinationHash: 'b' });
    const result = service.resolveConflictForBucket(bucket.id, file.id, 'overwrite');
    assert.ok(result.changes >= 1);
  });

  it('resolveAllConflictsForBucket delegates with bucketId', () => {
    const bucket = db.createBucket(makeBucketData());
    const result = service.resolveAllConflictsForBucket(bucket.id, 'skip');
    assert.ok('changes' in result);
  });

  it('retryError delegates', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
    const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
    db.updateStatus(file.id, 'error', { errorMessage: 'fail' });
    const result = service.retryError(file.id);
    assert.ok(result.changes >= 1);
  });

  it('retryAllErrors delegates', () => {
    const result = service.retryAllErrors();
    assert.ok('changes' in result);
  });

  it('retryAllErrorsForBucket delegates', () => {
    const bucket = db.createBucket(makeBucketData());
    const result = service.retryAllErrorsForBucket(bucket.id);
    assert.ok('changes' in result);
  });

  it('exportFiles returns files array', () => {
    const bucket = db.createBucket(makeBucketData());
    db.addFilesForBucket(bucket.id, makeFileRecords(2, { sourceFolder: '/tmp/src' }));
    const result = service.exportFiles('pending');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
  });
});
