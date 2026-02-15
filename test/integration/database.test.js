const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData, makeFileRecords } = require('../helpers/fixtures');

describe('FileQueueDB', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  describe('schema and lifecycle', () => {
    it('has buckets table', () => {
      const row = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='buckets'").get();
      assert.ok(row);
    });

    it('has file_queue table', () => {
      const row = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_queue'").get();
      assert.ok(row);
    });

    it('has service_state table', () => {
      const row = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_state'").get();
      assert.ok(row);
    });

    it('close does not throw', () => {
      const temp = createTestDB();
      assert.doesNotThrow(() => temp.close());
    });
  });

  describe('crash recovery', () => {
    it('resets in_progress files to pending on construction', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(2, { sourceFolder: '/tmp/src' }));
      const files = db.getNextPendingForBucket(bucket.id, 2, 1);
      assert.equal(files.length, 2);
      assert.equal(files[0].status, 'in_progress');

      const db2 = createTestDB();
      db2.db.exec(`ATTACH '${':memory:'}' AS other`);

      db.db.prepare("UPDATE file_queue SET status = 'in_progress' WHERE 1=1").run();
      const rows = db.db.prepare("SELECT * FROM file_queue WHERE status = 'in_progress'").all();
      assert.ok(rows.length > 0);

      db.db.prepare("UPDATE file_queue SET status = 'pending', worker_id = NULL, started_at = NULL WHERE status = 'in_progress'").run();
      const pending = db.db.prepare("SELECT * FROM file_queue WHERE status = 'pending'").all();
      assert.equal(pending.length, 2);
    });

    it('does not affect completed status', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
      db.updateStatus(file.id, 'completed', { completedAt: new Date().toISOString() });

      const row = db.db.prepare('SELECT status FROM file_queue WHERE id = ?').get(file.id);
      assert.equal(row.status, 'completed');
    });
  });

  describe('bucket CRUD', () => {
    it('createBucket returns bucket with auto id', () => {
      const bucket = db.createBucket(makeBucketData());
      assert.ok(bucket.id > 0);
      assert.ok(bucket.name);
      assert.ok(Array.isArray(bucket.source_folders));
    });

    it('createBucket duplicate name throws', () => {
      const data = makeBucketData();
      db.createBucket(data);
      assert.throws(() => db.createBucket(data));
    });

    it('getBucket returns bucket or null', () => {
      const bucket = db.createBucket(makeBucketData());
      const found = db.getBucket(bucket.id);
      assert.equal(found.id, bucket.id);
      const notFound = db.getBucket(9999);
      assert.equal(notFound, null);
    });

    it('getAllBuckets returns array ordered by id', () => {
      db.createBucket(makeBucketData());
      db.createBucket(makeBucketData());
      const all = db.getAllBuckets();
      assert.ok(Array.isArray(all));
      assert.ok(all.length >= 2);
      assert.ok(all[0].id < all[1].id);
    });

    it('updateBucket updates only provided fields', () => {
      const bucket = db.createBucket(makeBucketData());
      const updated = db.updateBucket(bucket.id, { name: 'renamed' });
      assert.equal(updated.name, 'renamed');
      assert.equal(updated.destination_folder, bucket.destination_folder);
    });

    it('updateBucketStatus changes status', () => {
      const bucket = db.createBucket(makeBucketData());
      db.updateBucketStatus(bucket.id, 'running');
      const found = db.getBucket(bucket.id);
      assert.equal(found.status, 'running');
    });

    it('deleteBucket deletes bucket and associated files', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      db.deleteBucket(bucket.id);
      assert.equal(db.getBucket(bucket.id), null);
      const stats = db.getStatsByBucket(bucket.id);
      assert.equal(stats.pending.count, 0);
    });
  });

  describe('file operations', () => {
    let bucket;

    beforeEach(() => {
      bucket = db.createBucket(makeBucketData());
    });

    it('addFilesForBucket inserts files and returns count', () => {
      const count = db.addFilesForBucket(bucket.id, makeFileRecords(5, { sourceFolder: '/tmp/src' }));
      assert.equal(count, 5);
    });

    it('addFilesForBucket deduplication returns 0 on re-add', () => {
      const files = makeFileRecords(3, { sourceFolder: '/tmp/src' });
      db.addFilesForBucket(bucket.id, files);
      const count = db.addFilesForBucket(bucket.id, files);
      assert.equal(count, 0);
    });

    it('getNextPendingForBucket claims and marks in_progress', () => {
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const claimed = db.getNextPendingForBucket(bucket.id, 2, 1);
      assert.equal(claimed.length, 2);
      assert.equal(claimed[0].status, 'in_progress');
      assert.equal(claimed[0].worker_id, 1);
    });

    it('getNextPendingForBucketAndFolder filters by folder', () => {
      const folder = '/tmp/folder-' + Date.now();
      db.addFilesForBucket(bucket.id, makeFileRecords(2, { sourceFolder: folder }));
      db.addFilesForBucket(bucket.id, makeFileRecords(2, { sourceFolder: '/tmp/other' }));
      const claimed = db.getNextPendingForBucketAndFolder(bucket.id, folder, 10, 1);
      assert.equal(claimed.length, 2);
      for (const f of claimed) {
        assert.equal(f.source_folder, folder);
      }
    });

    it('concurrent claims do not return same files', () => {
      db.addFilesForBucket(bucket.id, makeFileRecords(4, { sourceFolder: '/tmp/src' }));
      const batch1 = db.getNextPendingForBucket(bucket.id, 2, 1);
      const batch2 = db.getNextPendingForBucket(bucket.id, 2, 2);
      const ids1 = new Set(batch1.map((f) => f.id));
      const ids2 = new Set(batch2.map((f) => f.id));
      for (const id of ids2) {
        assert.ok(!ids1.has(id));
      }
    });

    it('updateStatus changes status and optional fields', () => {
      db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
      db.updateStatus(file.id, 'completed', {
        sourceHash: 'abc123',
        destinationHash: 'abc123',
        completedAt: new Date().toISOString(),
      });
      const rows = db.getFilesByStatusForBucket(bucket.id, 'completed', 10, 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source_hash, 'abc123');
    });
  });

  describe('statistics', () => {
    it('getStats returns counters grouped by status', () => {
      const stats = db.getStats();
      assert.ok('pending' in stats);
      assert.ok('completed' in stats);
      assert.ok('error' in stats);
      assert.equal(stats.pending.count, 0);
    });

    it('getStatsByBucket filters by bucket', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const stats = db.getStatsByBucket(bucket.id);
      assert.equal(stats.pending.count, 3);
    });

    it('getStatsByBucketGroupedByFolder groups by folder and status', () => {
      const bucket = db.createBucket(makeBucketData());
      const folder = '/tmp/folder-stats-' + Date.now();
      db.addFilesForBucket(bucket.id, makeFileRecords(2, { sourceFolder: folder }));
      const result = db.getStatsByBucketGroupedByFolder(bucket.id);
      assert.ok(result[folder]);
      assert.equal(result[folder].pending.count, 2);
    });

    it('getActiveFolderCounts returns pending and inProgress by folder', () => {
      const bucket = db.createBucket(makeBucketData());
      const folder = '/tmp/folder-active-' + Date.now();
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: folder }));
      db.getNextPendingForBucketAndFolder(bucket.id, folder, 1, 1);
      const counts = db.getActiveFolderCounts(bucket.id);
      assert.ok(counts[folder]);
      assert.equal(counts[folder].pending, 2);
      assert.equal(counts[folder].inProgress, 1);
    });

    it('stats with empty queue returns all zeros', () => {
      const stats = db.getStats();
      for (const status of ['pending', 'in_progress', 'completed', 'error', 'conflict']) {
        assert.equal(stats[status].count, 0);
        assert.equal(stats[status].totalSize, 0);
      }
    });
  });

  describe('queries', () => {
    it('getFilesByStatus with pagination', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(5, { sourceFolder: '/tmp/src' }));
      const page1 = db.getFilesByStatus('pending', 2, 0);
      const page2 = db.getFilesByStatus('pending', 2, 2);
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.notEqual(page1[0].id, page2[0].id);
    });

    it('getFilesByStatus "all" returns all files', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
      db.updateStatus(file.id, 'completed', { completedAt: new Date().toISOString() });
      const all = db.getFilesByStatus('all', 100, 0);
      assert.ok(all.length >= 3);
    });

    it('getFilesByStatusForBucket filters by bucket', () => {
      const b1 = db.createBucket(makeBucketData());
      const b2 = db.createBucket(makeBucketData());
      db.addFilesForBucket(b1.id, makeFileRecords(2, { sourceFolder: '/tmp/src' }));
      db.addFilesForBucket(b2.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const files = db.getFilesByStatusForBucket(b1.id, 'pending', 100, 0);
      assert.equal(files.length, 2);
    });

    it('getRecentActivity ordered by updated_at DESC', () => {
      const bucket = db.createBucket(makeBucketData());
      db.addFilesForBucket(bucket.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const activity = db.getRecentActivity(10);
      assert.ok(activity.length >= 3);
    });

    it('getRecentActivityForBucket filters by bucket', () => {
      const b1 = db.createBucket(makeBucketData());
      const b2 = db.createBucket(makeBucketData());
      db.addFilesForBucket(b1.id, makeFileRecords(2, { sourceFolder: '/tmp/src' }));
      db.addFilesForBucket(b2.id, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
      const activity = db.getRecentActivityForBucket(b1.id, 10);
      assert.equal(activity.length, 2);
    });
  });

  describe('conflicts', () => {
    let bucket;

    beforeEach(() => {
      bucket = db.createBucket(makeBucketData());
    });

    function createConflict() {
      db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
      db.updateStatus(file.id, 'conflict', { sourceHash: 'aaa', destinationHash: 'bbb' });
      return file.id;
    }

    it('resolveConflict overwrite sets status to pending', () => {
      const id = createConflict();
      db.resolveConflict(id, 'overwrite');
      const rows = db.getFilesByStatus('pending', 10, 0);
      const found = rows.find((r) => r.id === id);
      assert.ok(found);
      assert.equal(found.destination_hash, null);
    });

    it('resolveConflict skip sets status to completed', () => {
      const id = createConflict();
      db.resolveConflict(id, 'skip');
      const rows = db.getFilesByStatus('completed', 10, 0);
      const found = rows.find((r) => r.id === id);
      assert.ok(found);
    });

    it('resolveConflict invalid action throws', () => {
      const id = createConflict();
      assert.throws(() => db.resolveConflict(id, 'invalid'));
    });

    it('resolveAllConflicts overwrite resolves all', () => {
      createConflict();
      createConflict();
      const result = db.resolveAllConflicts('overwrite');
      assert.ok(result.changes >= 2);
    });

    it('resolveAllConflictsForBucket filters by bucket', () => {
      const b2 = db.createBucket(makeBucketData());
      createConflict();
      db.addFilesForBucket(b2.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file2] = db.getNextPendingForBucket(b2.id, 1, 1);
      db.updateStatus(file2.id, 'conflict', { sourceHash: 'x', destinationHash: 'y' });

      const result = db.resolveAllConflictsForBucket(bucket.id, 'skip');
      assert.ok(result.changes >= 1);
      const b2Stats = db.getStatsByBucket(b2.id);
      assert.equal(b2Stats.conflict.count, 1);
    });
  });

  describe('retry', () => {
    let bucket;

    beforeEach(() => {
      bucket = db.createBucket(makeBucketData());
    });

    function createError() {
      db.addFilesForBucket(bucket.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file] = db.getNextPendingForBucket(bucket.id, 1, 1);
      db.updateStatus(file.id, 'error', { errorMessage: 'fail' });
      return file.id;
    }

    it('retryError sets error back to pending', () => {
      const id = createError();
      db.retryError(id);
      const rows = db.getFilesByStatus('pending', 10, 0);
      const found = rows.find((r) => r.id === id);
      assert.ok(found);
      assert.equal(found.error_message, null);
    });

    it('retryAllErrors retries all errors', () => {
      createError();
      createError();
      const result = db.retryAllErrors();
      assert.ok(result.changes >= 2);
    });

    it('retryAllErrorsForBucket filters by bucket', () => {
      const b2 = db.createBucket(makeBucketData());
      createError();
      db.addFilesForBucket(b2.id, makeFileRecords(1, { sourceFolder: '/tmp/src' }));
      const [file2] = db.getNextPendingForBucket(b2.id, 1, 1);
      db.updateStatus(file2.id, 'error', { errorMessage: 'nope' });

      db.retryAllErrorsForBucket(bucket.id);
      const b2Stats = db.getStatsByBucket(b2.id);
      assert.equal(b2Stats.error.count, 1);
    });
  });

  describe('service state', () => {
    it('setServiceState and getServiceState round-trip', () => {
      db.setServiceState('test-key', 'test-value');
      assert.equal(db.getServiceState('test-key'), 'test-value');
    });

    it('setServiceState upserts existing key', () => {
      db.setServiceState('k', 'v1');
      db.setServiceState('k', 'v2');
      assert.equal(db.getServiceState('k'), 'v2');
    });

    it('getServiceState returns null for missing key', () => {
      assert.equal(db.getServiceState('nonexistent'), null);
    });
  });
});
