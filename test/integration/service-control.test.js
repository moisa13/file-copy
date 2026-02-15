const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createMockBucketManager } = require('../helpers/setup');

const ServiceControlService = require('../../src/services/service-control-service');
const { NotFoundError, ValidationError } = require('../../src/errors');

describe('ServiceControlService', () => {
  let mgr, service;
  const mockStatus = { bucketId: 1, status: 'running', workerCount: 4, activeWorkers: 0, name: 'test' };

  beforeEach(() => {
    mgr = createMockBucketManager();
    mgr.getBucketStatus.mock.mockImplementation(() => mockStatus);
    mgr.startBucket.mock.mockImplementation(() => {});
    mgr.pauseBucket.mock.mockImplementation(() => {});
    mgr.resumeBucket.mock.mockImplementation(() => {});
    mgr.stopBucket.mock.mockImplementation(async () => {});
    mgr.setWorkerCount.mock.mockImplementation(() => 4);
    service = new ServiceControlService(mgr);
  });

  it('getStatus delegates to getBucketStatus', () => {
    const result = service.getStatus(1);
    assert.deepEqual(result, mockStatus);
  });

  it('start calls startBucket and returns status', () => {
    const result = service.start(1);
    assert.equal(mgr.startBucket.mock.calls.length, 1);
    assert.deepEqual(result, mockStatus);
  });

  it('pause calls pauseBucket and returns status', () => {
    const result = service.pause(1);
    assert.equal(mgr.pauseBucket.mock.calls.length, 1);
    assert.deepEqual(result, mockStatus);
  });

  it('resume calls resumeBucket and returns status', () => {
    const result = service.resume(1);
    assert.equal(mgr.resumeBucket.mock.calls.length, 1);
    assert.deepEqual(result, mockStatus);
  });

  it('stop calls stopBucket and returns status', async () => {
    const result = await service.stop(1);
    assert.equal(mgr.stopBucket.mock.calls.length, 1);
    assert.deepEqual(result, mockStatus);
  });

  it('setWorkerCount calls setWorkerCount and returns status', () => {
    const result = service.setWorkerCount(1, 8);
    assert.equal(mgr.setWorkerCount.mock.calls.length, 1);
    assert.deepEqual(result, mockStatus);
  });

  it('throws NotFoundError when message contains "não encontrado"', () => {
    mgr.getBucketStatus.mock.mockImplementation(() => {
      throw new Error('Bucket 99 não encontrado');
    });
    assert.throws(() => service.getStatus(99), (err) => err instanceof NotFoundError);
  });

  it('throws ValidationError for other errors', () => {
    mgr.startBucket.mock.mockImplementation(() => {
      throw new Error('Bucket deve estar parado');
    });
    assert.throws(() => service.start(1), (err) => err instanceof ValidationError);
  });
});
