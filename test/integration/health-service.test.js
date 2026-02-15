const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDB } = require('../helpers/setup');

const database = require('../../src/queue/database');
const HealthService = require('../../src/services/health-service');

describe('HealthService', () => {
  let db, service;

  function createPoolMock(status, workerCount, activeWorkers) {
    return { status, workerCount, activeWorkers };
  }

  beforeEach(() => {
    db = createTestDB();
    mock.method(database, 'getStats', () => db.getStats());

    const mgr = {
      pools: new Map(),
    };
    service = new HealthService(mgr);
  });

  describe('getHealth', () => {
    it('returns healthy when DB is accessible', () => {
      const health = service.getHealth();
      assert.equal(health.status, 'healthy');
      assert.equal(health.database.connected, true);
    });

    it('returns unhealthy when DB fails', () => {
      mock.method(database, 'getStats', () => { throw new Error('db fail'); });
      const health = service.getHealth();
      assert.equal(health.status, 'unhealthy');
      assert.equal(health.database.connected, false);
    });

    it('returns degraded when pools running but 0 active workers', () => {
      service.bucketManager.pools.set(1, createPoolMock('running', 4, 0));
      const health = service.getHealth();
      assert.equal(health.status, 'degraded');
    });

    it('includes uptime', () => {
      const health = service.getHealth();
      assert.ok(typeof health.uptime === 'number');
      assert.ok(health.uptime >= 0);
    });

    it('includes version', () => {
      const health = service.getHealth();
      assert.ok(typeof health.version === 'string');
    });

    it('includes memory info', () => {
      const health = service.getHealth();
      assert.ok('heapUsed' in health.memory);
      assert.ok('heapTotal' in health.memory);
      assert.ok('rss' in health.memory);
    });

    it('includes buckets info', () => {
      const health = service.getHealth();
      assert.ok('total' in health.buckets);
      assert.ok('active' in health.buckets);
    });
  });

  describe('getMetrics', () => {
    it('returns files stats', () => {
      const metrics = service.getMetrics();
      assert.ok('files' in metrics);
      assert.ok('pending' in metrics.files);
    });

    it('returns queue depth and size', () => {
      const metrics = service.getMetrics();
      assert.ok('queue' in metrics);
      assert.ok('depth' in metrics.queue);
      assert.ok('size' in metrics.queue);
    });

    it('returns workers info', () => {
      const metrics = service.getMetrics();
      assert.ok('workers' in metrics);
      assert.ok('total' in metrics.workers);
      assert.ok('active' in metrics.workers);
      assert.ok('utilization' in metrics.workers);
    });

    it('utilization is 0 when no workers', () => {
      const metrics = service.getMetrics();
      assert.equal(metrics.workers.utilization, 0);
    });
  });
});
