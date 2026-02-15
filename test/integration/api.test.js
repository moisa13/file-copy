const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');
const { makeBucketData, makeFileRecords } = require('../helpers/fixtures');

const database = require('../../src/queue/database');
const logger = require('../../src/logger');

let db;
let app;
let request;

describe('API', () => {
  before(async () => {
    db = createTestDB();

    mock.method(database, 'getAllBuckets', () => db.getAllBuckets());
    mock.method(database, 'createBucket', (data) => db.createBucket(data));
    mock.method(database, 'getBucket', (id) => db.getBucket(id));
    mock.method(database, 'updateBucket', (id, data) => db.updateBucket(id, data));
    mock.method(database, 'updateBucketStatus', (id, status) => db.updateBucketStatus(id, status));
    mock.method(database, 'deleteBucket', (id) => db.deleteBucket(id));
    mock.method(database, 'getStats', () => db.getStats());
    mock.method(database, 'getStatsByBucket', (id) => db.getStatsByBucket(id));
    mock.method(database, 'getStatsByBucketGroupedByFolder', (id) => db.getStatsByBucketGroupedByFolder(id));
    mock.method(database, 'getFilesByStatus', (s, l, o) => db.getFilesByStatus(s, l, o));
    mock.method(database, 'getFilesByStatusForBucket', (id, s, l, o) => db.getFilesByStatusForBucket(id, s, l, o));
    mock.method(database, 'getRecentActivityForBucket', (id, l) => db.getRecentActivityForBucket(id, l));
    mock.method(database, 'addFilesForBucket', (id, f) => db.addFilesForBucket(id, f));
    mock.method(database, 'getActiveFolderCounts', () => ({}));
    mock.method(database, 'getNextPendingForBucketAndFolder', () => []);
    mock.method(database, 'resolveConflict', (id, a) => db.resolveConflict(id, a));
    mock.method(database, 'resolveAllConflicts', (a) => db.resolveAllConflicts(a));
    mock.method(database, 'resolveAllConflictsForBucket', (bid, a) => db.resolveAllConflictsForBucket(bid, a));
    mock.method(database, 'retryError', (id) => db.retryError(id));
    mock.method(database, 'retryAllErrors', () => db.retryAllErrors());
    mock.method(database, 'retryAllErrorsForBucket', (bid) => db.retryAllErrorsForBucket(bid));
    mock.method(database, 'getNextPendingForBucket', (bid, l, w) => db.getNextPendingForBucket(bid, l, w));
    mock.method(database, 'updateStatus', (id, s, e) => db.updateStatus(id, s, e));
    mock.method(logger, 'system', () => {});
    mock.method(logger, 'log', () => {});

    delete require.cache[require.resolve('../../src/buckets/manager')];
    const bucketManager = require('../../src/buckets/manager');
    bucketManager.init();

    const { createServer } = require('../../src/api');
    const server = createServer(bucketManager);
    app = server.app;

    const supertest = require('supertest');
    request = supertest(app);
  });

  describe('Health and Metrics', () => {
    it('GET /api/health returns 200', async () => {
      const res = await request.get('/api/health');
      assert.equal(res.status, 200);
      assert.ok('status' in res.body);
      assert.ok('uptime' in res.body);
      assert.ok('version' in res.body);
      assert.ok('database' in res.body);
    });

    it('GET /api/metrics returns 200', async () => {
      const res = await request.get('/api/metrics');
      assert.equal(res.status, 200);
      assert.ok('files' in res.body);
      assert.ok('queue' in res.body);
      assert.ok('workers' in res.body);
    });
  });

  describe('Bucket CRUD', () => {
    it('GET /api/buckets returns 200 array', async () => {
      const res = await request.get('/api/buckets');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('POST /api/buckets returns 201 with valid body', async () => {
      const data = makeBucketData();
      const res = await request.post('/api/buckets').send(data);
      assert.equal(res.status, 201);
      assert.ok(res.body.id > 0);
      assert.equal(res.body.name, data.name);
    });

    it('POST /api/buckets returns 400 without name', async () => {
      const res = await request.post('/api/buckets').send({ destinationFolder: '/tmp' });
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    });

    it('POST /api/buckets returns 400 without destinationFolder', async () => {
      const res = await request.post('/api/buckets').send({ name: 'test' });
      assert.equal(res.status, 400);
    });

    it('GET /api/buckets/:id returns 200 for existing', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      const res = await request.get(`/api/buckets/${created.body.id}`);
      assert.equal(res.status, 200);
      assert.ok('poolStatus' in res.body);
    });

    it('GET /api/buckets/:id returns 404 for nonexistent', async () => {
      const res = await request.get('/api/buckets/9999');
      assert.equal(res.status, 404);
    });

    it('PUT /api/buckets/:id returns 200 with valid update', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      const res = await request.put(`/api/buckets/${created.body.id}`).send({ name: 'renamed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'renamed');
    });

    it('DELETE /api/buckets/:id returns 200', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      const res = await request.delete(`/api/buckets/${created.body.id}`);
      assert.equal(res.status, 200);
      assert.ok(res.body.deleted);
    });
  });

  describe('Stats and Files', () => {
    let bucketId;

    before(async () => {
      const data = makeBucketData();
      const res = await request.post('/api/buckets').send(data);
      bucketId = res.body.id;
      db.addFilesForBucket(bucketId, makeFileRecords(3, { sourceFolder: '/tmp/src' }));
    });

    it('GET /api/buckets/:id/stats returns 200', async () => {
      const res = await request.get(`/api/buckets/${bucketId}/stats`);
      assert.equal(res.status, 200);
      assert.ok('pending' in res.body);
    });

    it('GET /api/buckets/:id/folders returns 200', async () => {
      const res = await request.get(`/api/buckets/${bucketId}/folders`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('GET /api/buckets/:id/files/:status returns 200', async () => {
      const res = await request.get(`/api/buckets/${bucketId}/files/pending`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('GET /api/buckets/:id/activity returns 200', async () => {
      const res = await request.get(`/api/buckets/${bucketId}/activity`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('Service control', () => {
    let bucketId;

    before(async () => {
      const data = makeBucketData();
      const res = await request.post('/api/buckets').send(data);
      bucketId = res.body.id;
    });

    it('POST /api/buckets/:id/service/start returns 200', async () => {
      const res = await request.post(`/api/buckets/${bucketId}/service/start`);
      assert.equal(res.status, 200);
      assert.ok('status' in res.body);
    });

    it('POST /api/buckets/:id/service/pause returns 200', async () => {
      const res = await request.post(`/api/buckets/${bucketId}/service/pause`);
      assert.equal(res.status, 200);
    });

    it('POST /api/buckets/:id/service/stop returns 200', async () => {
      const res = await request.post(`/api/buckets/${bucketId}/service/stop`);
      assert.equal(res.status, 200);
    });

    it('POST /api/buckets/:id/service/workers returns 200 with valid count', async () => {
      const res = await request.post(`/api/buckets/${bucketId}/service/workers`).send({ count: 8 });
      assert.equal(res.status, 200);
    });

    it('POST /api/buckets/:id/service/workers returns 400 with invalid count', async () => {
      const res = await request.post(`/api/buckets/${bucketId}/service/workers`).send({ count: 0 });
      assert.equal(res.status, 400);
    });
  });

  describe('Conflicts and Errors', () => {
    it('POST /api/conflicts/resolve-all returns 200', async () => {
      const res = await request.post('/api/conflicts/resolve-all').send({ action: 'skip' });
      assert.equal(res.status, 200);
      assert.ok('changes' in res.body);
    });

    it('POST /api/errors/retry-all returns 200', async () => {
      const res = await request.post('/api/errors/retry-all');
      assert.equal(res.status, 200);
      assert.ok('changes' in res.body);
    });

    it('POST /api/buckets/:id/conflicts/resolve-all returns 200', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      const res = await request.post(`/api/buckets/${created.body.id}/conflicts/resolve-all`).send({ action: 'overwrite' });
      assert.equal(res.status, 200);
      assert.ok('changes' in res.body);
    });

    it('POST /api/buckets/:id/errors/retry-all returns 200', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      const res = await request.post(`/api/buckets/${created.body.id}/errors/retry-all`);
      assert.equal(res.status, 200);
      assert.ok('changes' in res.body);
    });
  });

  describe('Export', () => {
    it('GET /api/buckets/:id/export/:status returns CSV', async () => {
      const created = await request.post('/api/buckets').send(makeBucketData());
      db.addFilesForBucket(created.body.id, makeFileRecords(2, { sourceFolder: '/tmp/src' }));
      const res = await request.get(`/api/buckets/${created.body.id}/export/pending`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/csv'));
      assert.ok(res.headers['content-disposition'].includes('attachment'));
      assert.ok(res.text.includes('id;arquivo'));
    });

    it('GET /api/export/:status returns CSV', async () => {
      const res = await request.get('/api/export/all');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/csv'));
    });
  });

  describe('Validation', () => {
    it('invalid param id returns 400', async () => {
      const res = await request.get('/api/buckets/abc');
      assert.equal(res.status, 400);
    });

    it('invalid body returns 400 with details', async () => {
      const res = await request.post('/api/buckets').send({});
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
      assert.ok(res.body.error.details);
    });
  });

  describe('Global endpoints', () => {
    it('GET /api/stats returns 200', async () => {
      const res = await request.get('/api/stats');
      assert.equal(res.status, 200);
      assert.ok('pending' in res.body);
    });

    it('GET /api/files/:status returns 200', async () => {
      const res = await request.get('/api/files/all');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });
});
