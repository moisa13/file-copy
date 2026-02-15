let counter = 0;

const validBucketData = {
  name: 'test-bucket',
  sourceFolders: ['/tmp/source1', '/tmp/source2'],
  destinationFolder: '/tmp/dest',
  workerCount: 2,
};

const validFileRecord = {
  sourcePath: '/tmp/source1/12345678.pdf',
  sourceFolder: '/tmp/source1',
  relativePath: '12345678.pdf',
  destinationPath: '/tmp/dest/12345678.pdf',
  fileSize: 1024,
  status: 'pending',
  errorMessage: null,
};

function makeBucketData(overrides = {}) {
  counter++;
  return {
    name: `bucket-${counter}-${Date.now()}`,
    sourceFolders: ['/tmp/src-' + counter],
    destinationFolder: '/tmp/dst-' + counter,
    workerCount: 2,
    ...overrides,
  };
}

function makeFileRecords(n, overrides = {}) {
  const records = [];
  for (let i = 0; i < n; i++) {
    counter++;
    records.push({
      sourcePath: `/tmp/source/${counter}/1000000${counter}.pdf`,
      sourceFolder: overrides.sourceFolder || '/tmp/source',
      relativePath: `${counter}/1000000${counter}.pdf`,
      destinationPath: `/tmp/dest/${counter}/1000000${counter}.pdf`,
      fileSize: 1024 * (i + 1),
      status: 'pending',
      errorMessage: null,
      ...overrides,
    });
  }
  return records;
}

module.exports = { validBucketData, validFileRecord, makeBucketData, makeFileRecords };
