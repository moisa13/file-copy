const database = require('../queue/database');

class FileService {
  getGlobalStats() {
    return database.getStats();
  }

  getFilesByStatus(status, limit, offset) {
    return database.getFilesByStatus(status, limit, offset);
  }

  resolveConflict(fileId, action) {
    return database.resolveConflict(fileId, action);
  }

  resolveAllConflicts(action) {
    return database.resolveAllConflicts(action);
  }

  resolveConflictForBucket(bucketId, fileId, action) {
    return database.resolveConflict(fileId, action);
  }

  resolveAllConflictsForBucket(bucketId, action) {
    return database.resolveAllConflictsForBucket(bucketId, action);
  }

  retryError(fileId) {
    return database.retryError(fileId);
  }

  retryAllErrors() {
    return database.retryAllErrors();
  }

  retryErrorForBucket(bucketId, fileId) {
    return database.retryError(fileId);
  }

  retryAllErrorsForBucket(bucketId) {
    return database.retryAllErrorsForBucket(bucketId);
  }

  exportFiles(status) {
    return database.getFilesByStatus(status, 100000, 0);
  }
}

module.exports = FileService;
