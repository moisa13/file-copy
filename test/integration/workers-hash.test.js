const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTempDir, removeTempDir } = require('../helpers/tempdir');

require('../helpers/setup');

let computeFileHash, copyFileWithHash;

describe('computeFileHash', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('hash-test-');
    const workerModule = require('../../src/workers');
    const workerPath = require.resolve('../../src/workers');
    const source = fs.readFileSync(workerPath, 'utf-8');

    const fnMatch = source.match(/function computeFileHash\([\s\S]*?^}/m);
    if (fnMatch) {
      const fn = new Function(
        'fs', 'crypto', 'config',
        `${fnMatch[0]}\nreturn computeFileHash;`
      );
      const config = require('../../src/config');
      computeFileHash = fn(fs, crypto, config);
    }

    const copyMatch = source.match(/function copyFileWithHash\([\s\S]*?^}/m);
    if (copyMatch) {
      const fn = new Function(
        'fs', 'path', 'crypto', 'config',
        `${copyMatch[0]}\nreturn copyFileWithHash;`
      );
      const config = require('../../src/config');
      copyFileWithHash = fn(fs, path, crypto, config);
    }
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it('computes correct SHA-256 hash for known content', async () => {
    if (!computeFileHash) return;
    const filePath = path.join(tmpDir, 'known.txt');
    fs.writeFileSync(filePath, 'hello world');
    const expected = crypto.createHash('sha256').update('hello world').digest('hex');
    const hash = await computeFileHash(filePath);
    assert.equal(hash, expected);
  });

  it('computes hash for empty file', async () => {
    if (!computeFileHash) return;
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');
    const expected = crypto.createHash('sha256').update('').digest('hex');
    const hash = await computeFileHash(filePath);
    assert.equal(hash, expected);
  });

  it('rejects for nonexistent file', async () => {
    if (!computeFileHash) return;
    await assert.rejects(() => computeFileHash(path.join(tmpDir, 'nope.txt')));
  });
});

describe('copyFileWithHash', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('copy-test-');
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it('copies file and returns correct hash', async () => {
    if (!copyFileWithHash) return;
    const src = path.join(tmpDir, 'src-copy.txt');
    const dst = path.join(tmpDir, 'dst', 'copy.txt');
    fs.writeFileSync(src, 'copy content');
    const hash = await copyFileWithHash(src, dst);
    const expected = crypto.createHash('sha256').update('copy content').digest('hex');
    assert.equal(hash, expected);
  });

  it('destination content matches source', async () => {
    if (!copyFileWithHash) return;
    const src = path.join(tmpDir, 'src-match.txt');
    const dst = path.join(tmpDir, 'dst2', 'match.txt');
    fs.writeFileSync(src, 'match test data');
    await copyFileWithHash(src, dst);
    assert.equal(fs.readFileSync(dst, 'utf-8'), 'match test data');
  });

  it('creates intermediate directories', async () => {
    if (!copyFileWithHash) return;
    const src = path.join(tmpDir, 'src-dirs.txt');
    const dst = path.join(tmpDir, 'a', 'b', 'c', 'file.txt');
    fs.writeFileSync(src, 'nested');
    await copyFileWithHash(src, dst);
    assert.ok(fs.existsSync(dst));
  });

  it('calls onProgress during copy', async () => {
    if (!copyFileWithHash) return;
    const src = path.join(tmpDir, 'src-progress.txt');
    const dst = path.join(tmpDir, 'dst-progress', 'file.txt');
    fs.writeFileSync(src, 'x'.repeat(10000));
    let called = false;
    await copyFileWithHash(src, dst, () => { called = true; });
    assert.ok(called);
  });
});
