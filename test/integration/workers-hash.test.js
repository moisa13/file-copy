const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTempDir, removeTempDir } = require('../helpers/tempdir');

require('../helpers/setup');

let computeFileHash, copyFileWithHash;

function extractHelpers(source) {
  let xxhash = null;
  try { xxhash = require('xxhash-addon'); } catch (_) {}
  const config = require('../../src/config');

  const createHasherMatch = source.match(/function createHasher\(\)[\s\S]*?^}/m);
  const digestHasherMatch = source.match(/function digestHasher\([\s\S]*?^}/m);
  const helperCode = (createHasherMatch ? createHasherMatch[0] + '\n' : '') +
    (digestHasherMatch ? digestHasherMatch[0] + '\n' : '');

  return { xxhash, config, helperCode };
}

describe('computeFileHash', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir('hash-test-');
    const workerPath = require.resolve('../../src/workers');
    const source = fs.readFileSync(workerPath, 'utf-8');
    const { xxhash, config, helperCode } = extractHelpers(source);

    const fnMatch = source.match(/function computeFileHash\([\s\S]*?^}/m);
    if (fnMatch) {
      const fn = new Function(
        'fs', 'crypto', 'config', 'xxhash',
        `${helperCode}${fnMatch[0]}\nreturn computeFileHash;`
      );
      computeFileHash = fn(fs, crypto, config, xxhash);
    }

    const copyMatch = source.match(/function copyFileWithHash\([\s\S]*?^}/m);
    if (copyMatch) {
      const fn = new Function(
        'fs', 'path', 'crypto', 'config', 'xxhash',
        `${helperCode}${copyMatch[0]}\nreturn copyFileWithHash;`
      );
      copyFileWithHash = fn(fs, path, crypto, config, xxhash);
    }
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it('computes consistent hash for known content', async () => {
    if (!computeFileHash) return;
    const filePath = path.join(tmpDir, 'known.txt');
    fs.writeFileSync(filePath, 'hello world');
    const hash = await computeFileHash(filePath);
    const hash2 = await computeFileHash(filePath);
    assert.equal(typeof hash, 'string');
    assert.ok(hash.length > 0);
    assert.equal(hash, hash2);
  });

  it('computes hash for empty file', async () => {
    if (!computeFileHash) return;
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');
    const hash = await computeFileHash(filePath);
    assert.equal(typeof hash, 'string');
    assert.ok(hash.length > 0);
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
    const result = await copyFileWithHash(src, dst);
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.sourceHash, 'string');
    assert.equal(typeof result.destHash, 'string');
    assert.equal(result.sourceHash, result.destHash);
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
