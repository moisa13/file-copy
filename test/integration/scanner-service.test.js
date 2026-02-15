const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createMockBucketManager } = require('../helpers/setup');

const scanner = require('../../src/scanner');
const ScannerService = require('../../src/services/scanner-service');
const { NotFoundError } = require('../../src/errors');

describe('ScannerService', () => {
  let mgr, service, broadcastCalls;

  beforeEach(() => {
    mgr = createMockBucketManager();
    broadcastCalls = [];
    const broadcast = (event, data) => broadcastCalls.push({ event, data });
    mock.method(scanner, 'scanBucket', async () => ({ found: 5, added: 3, invalid: 1 }));
    mock.method(scanner, 'scanAll', async () => ({ buckets: {}, totalFound: 10, totalAdded: 8 }));
    service = new ScannerService(mgr, broadcast);
  });

  it('scanBucket returns scanning status and delegates to scanner', () => {
    const bucket = { id: 1, name: 'test', source_folders: [] };
    mgr.getBucket.mock.mockImplementation(() => bucket);
    const result = service.scanBucket(1);
    assert.equal(result.status, 'scanning');
    assert.equal(scanner.scanBucket.mock.callCount(), 1);
  });

  it('scanBucket throws NotFoundError if bucket not found', () => {
    mgr.getBucket.mock.mockImplementation(() => null);
    assert.throws(() => service.scanBucket(999), (err) => err instanceof NotFoundError);
  });

  it('scanAll returns scanning status and delegates to scanner', () => {
    const result = service.scanAll();
    assert.equal(result.status, 'scanning');
    assert.equal(scanner.scanAll.mock.callCount(), 1);
  });
});
