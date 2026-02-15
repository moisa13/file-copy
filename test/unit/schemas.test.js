const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/setup');
const {
  VALID_STATUSES,
  VALID_ACTIONS,
  bucketParamsSchema,
  fileParamsSchema,
  statusParamsSchema,
  bucketStatusParamsSchema,
  bucketCreateSchema,
  bucketUpdateSchema,
  workerCountSchema,
  conflictResolutionSchema,
  paginationSchema,
  activityQuerySchema,
} = require('../../src/validation/schemas');

describe('VALID_STATUSES', () => {
  it('contains expected statuses', () => {
    assert.deepEqual(VALID_STATUSES, ['pending', 'in_progress', 'completed', 'error', 'conflict']);
  });
});

describe('VALID_ACTIONS', () => {
  it('contains overwrite and skip', () => {
    assert.deepEqual(VALID_ACTIONS, ['overwrite', 'skip']);
  });
});

describe('bucketParamsSchema', () => {
  it('coerces string to number', () => {
    const result = bucketParamsSchema.safeParse({ id: '5' });
    assert.ok(result.success);
    assert.equal(result.data.id, 5);
  });

  it('accepts positive integer', () => {
    const result = bucketParamsSchema.safeParse({ id: 1 });
    assert.ok(result.success);
  });

  it('rejects zero', () => {
    const result = bucketParamsSchema.safeParse({ id: 0 });
    assert.ok(!result.success);
  });

  it('rejects negative', () => {
    const result = bucketParamsSchema.safeParse({ id: -1 });
    assert.ok(!result.success);
  });

  it('rejects non-numeric string', () => {
    const result = bucketParamsSchema.safeParse({ id: 'abc' });
    assert.ok(!result.success);
  });
});

describe('fileParamsSchema', () => {
  it('validates id and fileId', () => {
    const result = fileParamsSchema.safeParse({ id: '1', fileId: '2' });
    assert.ok(result.success);
    assert.equal(result.data.id, 1);
    assert.equal(result.data.fileId, 2);
  });

  it('rejects missing fileId', () => {
    const result = fileParamsSchema.safeParse({ id: '1' });
    assert.ok(!result.success);
  });

  it('rejects missing id', () => {
    const result = fileParamsSchema.safeParse({ fileId: '1' });
    assert.ok(!result.success);
  });
});

describe('statusParamsSchema', () => {
  for (const status of VALID_STATUSES) {
    it(`accepts "${status}"`, () => {
      const result = statusParamsSchema.safeParse({ status });
      assert.ok(result.success);
    });
  }

  it('accepts "all"', () => {
    const result = statusParamsSchema.safeParse({ status: 'all' });
    assert.ok(result.success);
  });

  it('rejects unknown status', () => {
    const result = statusParamsSchema.safeParse({ status: 'unknown' });
    assert.ok(!result.success);
  });
});

describe('bucketStatusParamsSchema', () => {
  it('combines id and status', () => {
    const result = bucketStatusParamsSchema.safeParse({ id: '1', status: 'pending' });
    assert.ok(result.success);
    assert.equal(result.data.id, 1);
    assert.equal(result.data.status, 'pending');
  });

  it('rejects invalid status', () => {
    const result = bucketStatusParamsSchema.safeParse({ id: '1', status: 'bad' });
    assert.ok(!result.success);
  });
});

describe('bucketCreateSchema', () => {
  it('accepts valid data with all fields', () => {
    const result = bucketCreateSchema.safeParse({
      name: 'test',
      sourceFolders: ['/a'],
      destinationFolder: '/b',
      workerCount: 4,
    });
    assert.ok(result.success);
  });

  it('name is required', () => {
    const result = bucketCreateSchema.safeParse({ destinationFolder: '/b' });
    assert.ok(!result.success);
  });

  it('destinationFolder is required', () => {
    const result = bucketCreateSchema.safeParse({ name: 'test' });
    assert.ok(!result.success);
  });

  it('sourceFolders omitted fails due to min(1) on default([])', () => {
    const result = bucketCreateSchema.safeParse({ name: 'test', destinationFolder: '/b' });
    assert.ok(!result.success);
  });

  it('workerCount is optional', () => {
    const result = bucketCreateSchema.safeParse({ name: 'test', destinationFolder: '/b', sourceFolders: ['/a'] });
    assert.ok(result.success);
    assert.equal(result.data.workerCount, undefined);
  });

  it('rejects workerCount of 0', () => {
    const result = bucketCreateSchema.safeParse({
      name: 'test', destinationFolder: '/b', workerCount: 0,
    });
    assert.ok(!result.success);
  });

  it('rejects workerCount exceeding maxCount', () => {
    const result = bucketCreateSchema.safeParse({
      name: 'test', destinationFolder: '/b', workerCount: 999,
    });
    assert.ok(!result.success);
  });

  it('rejects empty name', () => {
    const result = bucketCreateSchema.safeParse({ name: '', destinationFolder: '/b' });
    assert.ok(!result.success);
  });

  it('rejects empty destinationFolder', () => {
    const result = bucketCreateSchema.safeParse({ name: 'test', destinationFolder: '' });
    assert.ok(!result.success);
  });

  it('rejects empty sourceFolders element', () => {
    const result = bucketCreateSchema.safeParse({
      name: 'test', destinationFolder: '/b', sourceFolders: [''],
    });
    assert.ok(!result.success);
  });
});

describe('bucketUpdateSchema', () => {
  it('accepts name only', () => {
    const result = bucketUpdateSchema.safeParse({ name: 'new' });
    assert.ok(result.success);
  });

  it('accepts workerCount only', () => {
    const result = bucketUpdateSchema.safeParse({ workerCount: 8 });
    assert.ok(result.success);
  });

  it('accepts destinationFolder only', () => {
    const result = bucketUpdateSchema.safeParse({ destinationFolder: '/new' });
    assert.ok(result.success);
  });

  it('rejects empty object', () => {
    const result = bucketUpdateSchema.safeParse({});
    assert.ok(!result.success);
  });

  it('rejects workerCount exceeding maxCount', () => {
    const result = bucketUpdateSchema.safeParse({ workerCount: 999 });
    assert.ok(!result.success);
  });
});

describe('workerCountSchema', () => {
  it('accepts valid count', () => {
    const result = workerCountSchema.safeParse({ count: 4 });
    assert.ok(result.success);
  });

  it('accepts count of 1', () => {
    const result = workerCountSchema.safeParse({ count: 1 });
    assert.ok(result.success);
  });

  it('rejects count of 0', () => {
    const result = workerCountSchema.safeParse({ count: 0 });
    assert.ok(!result.success);
  });

  it('rejects count exceeding maxCount', () => {
    const result = workerCountSchema.safeParse({ count: 999 });
    assert.ok(!result.success);
  });
});

describe('conflictResolutionSchema', () => {
  it('accepts overwrite', () => {
    const result = conflictResolutionSchema.safeParse({ action: 'overwrite' });
    assert.ok(result.success);
  });

  it('accepts skip', () => {
    const result = conflictResolutionSchema.safeParse({ action: 'skip' });
    assert.ok(result.success);
  });

  it('rejects other action', () => {
    const result = conflictResolutionSchema.safeParse({ action: 'delete' });
    assert.ok(!result.success);
  });

  it('rejects missing action', () => {
    const result = conflictResolutionSchema.safeParse({});
    assert.ok(!result.success);
  });
});

describe('paginationSchema', () => {
  it('defaults limit to 100', () => {
    const result = paginationSchema.safeParse({});
    assert.ok(result.success);
    assert.equal(result.data.limit, 100);
  });

  it('defaults offset to 0', () => {
    const result = paginationSchema.safeParse({});
    assert.ok(result.success);
    assert.equal(result.data.offset, 0);
  });

  it('coerces string limit', () => {
    const result = paginationSchema.safeParse({ limit: '50' });
    assert.ok(result.success);
    assert.equal(result.data.limit, 50);
  });

  it('rejects limit of 0', () => {
    const result = paginationSchema.safeParse({ limit: 0 });
    assert.ok(!result.success);
  });

  it('rejects limit above 10000', () => {
    const result = paginationSchema.safeParse({ limit: 10001 });
    assert.ok(!result.success);
  });

  it('rejects negative offset', () => {
    const result = paginationSchema.safeParse({ offset: -1 });
    assert.ok(!result.success);
  });
});

describe('activityQuerySchema', () => {
  it('defaults limit to 50', () => {
    const result = activityQuerySchema.safeParse({});
    assert.ok(result.success);
    assert.equal(result.data.limit, 50);
  });

  it('accepts custom limit', () => {
    const result = activityQuerySchema.safeParse({ limit: '20' });
    assert.ok(result.success);
    assert.equal(result.data.limit, 20);
  });

  it('rejects limit of 0', () => {
    const result = activityQuerySchema.safeParse({ limit: 0 });
    assert.ok(!result.success);
  });

  it('rejects limit above 10000', () => {
    const result = activityQuerySchema.safeParse({ limit: 10001 });
    assert.ok(!result.success);
  });
});
