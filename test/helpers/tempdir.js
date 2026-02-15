const fs = require('fs');
const path = require('path');
const os = require('os');

function createTempDir(prefix = 'fcm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function populateTempDir(baseDir, structure) {
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = path.join(baseDir, name);
    if (typeof content === 'object' && content !== null) {
      fs.mkdirSync(fullPath, { recursive: true });
      populateTempDir(fullPath, content);
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content || '');
    }
  }
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createTempDir, populateTempDir, removeTempDir };
