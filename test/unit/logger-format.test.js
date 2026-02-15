const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/setup');
const { formatSize } = require('../../src/logger');

describe('formatSize', () => {
  it('formats 0 bytes', () => {
    assert.equal(formatSize(0), '0 B');
  });

  it('formats bytes below 1 KB', () => {
    assert.equal(formatSize(500), '500.00 B');
  });

  it('formats exactly 1 KB', () => {
    assert.equal(formatSize(1024), '1.00 KB');
  });

  it('formats 1.5 KB', () => {
    assert.equal(formatSize(1536), '1.50 KB');
  });

  it('formats exactly 1 MB', () => {
    assert.equal(formatSize(1048576), '1.00 MB');
  });

  it('formats exactly 1 GB', () => {
    assert.equal(formatSize(1073741824), '1.00 GB');
  });

  it('formats exactly 1 TB', () => {
    assert.equal(formatSize(1099511627776), '1.00 TB');
  });

  it('formats fractional MB', () => {
    assert.equal(formatSize(1572864), '1.50 MB');
  });
});
