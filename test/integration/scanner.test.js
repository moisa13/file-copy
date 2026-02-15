const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, removeTempDir, populateTempDir } = require('../helpers/tempdir');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const logger = require('../../src/logger');

describe('scanner', () => {
  let tmpDir, destDir, db;

  before(() => {
    tmpDir = createTempDir('scanner-test-');
    destDir = createTempDir('scanner-dest-');

    mock.method(logger, 'log', () => {});
    mock.method(logger, 'system', () => {});
  });

  after(() => {
    removeTempDir(tmpDir);
    removeTempDir(destDir);
  });

  beforeEach(() => {
    db = createTestDB();
    mock.method(database, 'addFilesForBucket', (bucketId, files) => db.addFilesForBucket(bucketId, files));
    mock.method(database, 'getAllBuckets', () => db.getAllBuckets());
    mock.method(database, 'createBucket', (data) => db.createBucket(data));
    mock.method(database, 'getBucket', (id) => db.getBucket(id));
  });

  const { scanBucket, scanAll } = require('../../src/scanner');

  it('scanBucket finds files in source folders', async () => {
    const sourceDir = path.join(tmpDir, 'src-' + Date.now());
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '12345678.pdf'), 'content');

    const bucket = db.createBucket(makeBucketData({
      sourceFolders: [sourceDir],
      destinationFolder: destDir,
    }));
    const result = await scanBucket(bucket);
    assert.ok(result.found >= 1);
    assert.ok(result.added >= 1);
  });

  it('scanBucket returns { found, added }', async () => {
    const sourceDir = path.join(tmpDir, 'shape-' + Date.now());
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '12345678.pdf'), 'a');

    const bucket = db.createBucket(makeBucketData({
      sourceFolders: [sourceDir],
      destinationFolder: destDir,
    }));
    const result = await scanBucket(bucket);
    assert.ok('found' in result);
    assert.ok('added' in result);
  });

  it('scanBucket ignores nonexistent source folder', async () => {
    const bucket = db.createBucket(makeBucketData({
      sourceFolders: ['/nonexistent/path/12345678'],
      destinationFolder: destDir,
    }));
    const result = await scanBucket(bucket);
    assert.equal(result.found, 0);
  });

  it('scanBucket deduplication returns added=0 on second scan', async () => {
    const sourceDir = path.join(tmpDir, 'dedup-' + Date.now());
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '12345678.pdf'), 'dup');

    const bucket = db.createBucket(makeBucketData({
      sourceFolders: [sourceDir],
      destinationFolder: destDir,
    }));
    await scanBucket(bucket);
    const result2 = await scanBucket(bucket);
    assert.equal(result2.added, 0);
  });

  it('scanBucket scans recursively', async () => {
    const sourceDir = path.join(tmpDir, 'recursive-' + Date.now());
    populateTempDir(sourceDir, {
      '12345678': {
        '12345678.pdf': 'nested file',
      },
    });

    const bucket = db.createBucket(makeBucketData({
      sourceFolders: [sourceDir],
      destinationFolder: destDir,
    }));
    const result = await scanBucket(bucket);
    assert.ok(result.found >= 1);
  });

  it('scanBucket valid file gets status pending', async () => {
    const sourceDir = path.join(tmpDir, 'valid-' + Date.now());
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '12345678.pdf'), 'valid');

    const bucket = db.createBucket(makeBucketData({
      sourceFolders: [sourceDir],
      destinationFolder: destDir,
    }));
    await scanBucket(bucket);
    const stats = db.getStatsByBucket(bucket.id);
    assert.ok(stats.pending.count >= 1);
  });

  it('scanAll scans all buckets', async () => {
    const src1 = path.join(tmpDir, 'all1-' + Date.now());
    const src2 = path.join(tmpDir, 'all2-' + Date.now());
    fs.mkdirSync(src1, { recursive: true });
    fs.mkdirSync(src2, { recursive: true });
    fs.writeFileSync(path.join(src1, '12345678.pdf'), 'a');
    fs.writeFileSync(path.join(src2, '87654321.pdf'), 'b');

    db.createBucket(makeBucketData({ sourceFolders: [src1], destinationFolder: destDir }));
    db.createBucket(makeBucketData({ sourceFolders: [src2], destinationFolder: destDir }));

    const result = await scanAll();
    assert.ok(result.totalFound >= 2);
    assert.ok(result.totalAdded >= 2);
    assert.ok(result.buckets);
  });
});
