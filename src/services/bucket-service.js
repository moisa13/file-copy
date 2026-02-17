const path = require('path');
const database = require('../queue/database');
const { NotFoundError, ValidationError } = require('../errors');

class BucketService {
  constructor(bucketManager) {
    this.bucketManager = bucketManager;
  }

  getAllBuckets() {
    const buckets = this.bucketManager.getAllBuckets();
    return buckets.map((b) => {
      const pool = this.bucketManager.pools.get(b.id);
      return {
        ...b,
        poolStatus: pool ? pool.getStatus() : { status: 'stopped', workerCount: b.worker_count, activeWorkers: 0 },
      };
    });
  }

  getBucket(id) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    const pool = this.bucketManager.pools.get(bucket.id);
    return {
      ...bucket,
      poolStatus: pool ? pool.getStatus() : { status: 'stopped', workerCount: bucket.worker_count, activeWorkers: 0 },
    };
  }

  createBucket(data) {
    try {
      return this.bucketManager.createBucket(data);
    } catch (err) {
      throw new ValidationError(err.message);
    }
  }

  updateBucket(id, data) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    try {
      return this.bucketManager.updateBucket(id, data);
    } catch (err) {
      throw new ValidationError(err.message);
    }
  }

  deleteBucket(id) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    try {
      this.bucketManager.deleteBucket(id);
      return { deleted: true };
    } catch (err) {
      throw new ValidationError(err.message);
    }
  }

  getStats(id) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    return database.getStatsByBucket(id);
  }

  getFolders(id) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    const statsMap = database.getFolderStatsCached(id);
    return bucket.source_folders.map((f) => {
      const resolved = path.resolve(f);
      return (
        statsMap[resolved] || {
          source_folder: resolved,
          pending: { count: 0, totalSize: 0 },
          in_progress: { count: 0, totalSize: 0 },
          completed: { count: 0, totalSize: 0 },
          error: { count: 0, totalSize: 0 },
          conflict: { count: 0, totalSize: 0 },
        }
      );
    });
  }

  getFiles(id, status, limit, offset) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    return database.getFilesByStatusForBucket(id, status, limit, offset);
  }

  getActivity(id, limit) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    return database.getRecentActivityForBucket(id, limit);
  }

  exportFiles(id, status) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');
    return database.getFilesByStatusForBucket(id, status, 100000, 0);
  }
}

module.exports = BucketService;
