const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const SCHEMA_VERSION = 2;

class FileQueueDB {
  constructor() {
    const dbDir = path.dirname(config.database.path);
    fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(config.database.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this._createSchema();
    this._migrate();
    this._recoverCrash();
    this._prepareStatements();
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS buckets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        source_folders TEXT NOT NULL DEFAULT '[]',
        destination_folder TEXT NOT NULL,
        worker_count INTEGER NOT NULL DEFAULT ${config.workers.defaultCount},
        status TEXT NOT NULL DEFAULT 'stopped',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS file_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_id INTEGER REFERENCES buckets(id),
        source_path TEXT NOT NULL,
        source_folder TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        source_hash TEXT,
        destination_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        started_at TEXT,
        completed_at TEXT,
        worker_id INTEGER,
        UNIQUE(source_path, destination_path, bucket_id)
      );

      CREATE INDEX IF NOT EXISTS idx_status ON file_queue(status);
      CREATE INDEX IF NOT EXISTS idx_source_folder ON file_queue(source_folder);
      CREATE INDEX IF NOT EXISTS idx_bucket_id ON file_queue(bucket_id);
    `);
  }

  _migrate() {
    const currentVersion = this._getSchemaVersion();

    if (currentVersion < 2) {
      const hasFileQueue = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_queue'")
        .get();

      if (hasFileQueue) {
        const columns = this.db.prepare('PRAGMA table_info(file_queue)').all();
        const hasBucketId = columns.some((c) => c.name === 'bucket_id');

        if (!hasBucketId) {
          this.db.transaction(() => {
            this.db.exec(`
              ALTER TABLE file_queue RENAME TO file_queue_old;

              CREATE TABLE file_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_id INTEGER REFERENCES buckets(id),
                source_path TEXT NOT NULL,
                source_folder TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                destination_path TEXT NOT NULL,
                file_size INTEGER DEFAULT 0,
                source_hash TEXT,
                destination_hash TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                started_at TEXT,
                completed_at TEXT,
                worker_id INTEGER,
                UNIQUE(source_path, destination_path, bucket_id)
              );

              INSERT INTO file_queue (id, source_path, source_folder, relative_path, destination_path, file_size, source_hash, destination_hash, status, error_message, created_at, updated_at, started_at, completed_at, worker_id)
              SELECT id, source_path, source_folder, relative_path, destination_path, file_size, source_hash, destination_hash, status, error_message, created_at, updated_at, started_at, completed_at, worker_id
              FROM file_queue_old;

              DROP TABLE file_queue_old;

              CREATE INDEX IF NOT EXISTS idx_status ON file_queue(status);
              CREATE INDEX IF NOT EXISTS idx_source_folder ON file_queue(source_folder);
              CREATE INDEX IF NOT EXISTS idx_bucket_id ON file_queue(bucket_id);
            `);
          })();
        }
      }

      this._setSchemaVersion(SCHEMA_VERSION);
    }
  }

  _getSchemaVersion() {
    const row = this.db.prepare("SELECT value FROM service_state WHERE key = 'schema_version'").get();
    return row ? parseInt(row.value) : 1;
  }

  _setSchemaVersion(version) {
    this.db
      .prepare(
        `
      INSERT INTO service_state (key, value, updated_at)
      VALUES ('schema_version', @value, datetime('now', 'localtime'))
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now', 'localtime')
    `,
      )
      .run({ value: String(version) });
  }

  _recoverCrash() {
    this.db
      .prepare(
        `
      UPDATE file_queue
      SET status = 'pending', worker_id = NULL, started_at = NULL,
          updated_at = datetime('now', 'localtime')
      WHERE status = 'in_progress'
    `,
      )
      .run();
  }

  _prepareStatements() {
    this._stmts = {
      insertFile: this.db.prepare(`
        INSERT OR IGNORE INTO file_queue (bucket_id, source_path, source_folder, relative_path, destination_path, file_size, status, error_message)
        VALUES (@bucketId, @sourcePath, @sourceFolder, @relativePath, @destinationPath, @fileSize, @status, @errorMessage)
      `),

      getNextPending: this.db.prepare(`
        SELECT * FROM file_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?
      `),

      getNextPendingForBucket: this.db.prepare(`
        SELECT * FROM file_queue WHERE status = 'pending' AND bucket_id = ? ORDER BY id ASC LIMIT ?
      `),

      getNextPendingForBucketAndFolder: this.db.prepare(`
        SELECT * FROM file_queue WHERE status = 'pending' AND bucket_id = ? AND source_folder = ? ORDER BY id ASC LIMIT ?
      `),

      getActiveFolderCounts: this.db.prepare(`
        SELECT source_folder,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
        FROM file_queue
        WHERE bucket_id = ? AND status IN ('pending', 'in_progress')
        GROUP BY source_folder
      `),

      getStatsByBucketGroupedByFolder: this.db.prepare(`
        SELECT source_folder, status, COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize
        FROM file_queue
        WHERE bucket_id = ?
        GROUP BY source_folder, status
      `),

      updateStatus: this.db.prepare(`
        UPDATE file_queue
        SET status = @status,
            source_hash = COALESCE(@sourceHash, source_hash),
            destination_hash = COALESCE(@destinationHash, destination_hash),
            error_message = COALESCE(@errorMessage, error_message),
            worker_id = COALESCE(@workerId, worker_id),
            started_at = COALESCE(@startedAt, started_at),
            completed_at = CASE WHEN @completedAt IS NOT NULL THEN datetime('now', 'localtime') ELSE completed_at END,
            updated_at = datetime('now', 'localtime')
        WHERE id = @id
      `),

      markInProgress: this.db.prepare(`
        UPDATE file_queue
        SET status = 'in_progress',
            worker_id = @workerId,
            started_at = datetime('now', 'localtime'),
            updated_at = datetime('now', 'localtime')
        WHERE id = @id AND status = 'pending'
      `),

      getStats: this.db.prepare(`
        SELECT status, COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize
        FROM file_queue GROUP BY status
      `),

      getStatsByBucket: this.db.prepare(`
        SELECT status, COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize
        FROM file_queue WHERE bucket_id = ? GROUP BY status
      `),

      getFilesByStatus: this.db.prepare(`
        SELECT f.*, b.name as bucket_name FROM file_queue f
        LEFT JOIN buckets b ON f.bucket_id = b.id
        WHERE f.status = @status
        ORDER BY f.updated_at DESC LIMIT @limit OFFSET @offset
      `),

      getFilesByStatusForBucket: this.db.prepare(`
        SELECT f.*, b.name as bucket_name FROM file_queue f
        LEFT JOIN buckets b ON f.bucket_id = b.id
        WHERE f.status = @status AND f.bucket_id = @bucketId
        ORDER BY f.updated_at DESC LIMIT @limit OFFSET @offset
      `),

      getAllFiles: this.db.prepare(`
        SELECT f.*, b.name as bucket_name FROM file_queue f
        LEFT JOIN buckets b ON f.bucket_id = b.id
        ORDER BY f.updated_at DESC LIMIT @limit OFFSET @offset
      `),

      getAllFilesForBucket: this.db.prepare(`
        SELECT f.*, b.name as bucket_name FROM file_queue f
        LEFT JOIN buckets b ON f.bucket_id = b.id
        WHERE f.bucket_id = @bucketId
        ORDER BY f.updated_at DESC LIMIT @limit OFFSET @offset
      `),

      getRecentActivity: this.db.prepare(`
        SELECT * FROM file_queue ORDER BY updated_at DESC LIMIT ?
      `),

      getRecentActivityForBucket: this.db.prepare(`
        SELECT * FROM file_queue WHERE bucket_id = ? ORDER BY updated_at DESC LIMIT ?
      `),

      resolveConflictOverwrite: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            destination_hash = NULL, updated_at = datetime('now', 'localtime')
        WHERE id = ? AND status = 'conflict'
      `),

      resolveConflictSkip: this.db.prepare(`
        UPDATE file_queue
        SET status = 'completed', completed_at = datetime('now', 'localtime'),
            updated_at = datetime('now', 'localtime')
        WHERE id = ? AND status = 'conflict'
      `),

      resolveAllConflictsOverwrite: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            destination_hash = NULL, updated_at = datetime('now', 'localtime')
        WHERE status = 'conflict'
      `),

      resolveAllConflictsSkip: this.db.prepare(`
        UPDATE file_queue
        SET status = 'completed', completed_at = datetime('now', 'localtime'),
            updated_at = datetime('now', 'localtime')
        WHERE status = 'conflict'
      `),

      resolveAllConflictsOverwriteForBucket: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            destination_hash = NULL, updated_at = datetime('now', 'localtime')
        WHERE status = 'conflict' AND bucket_id = ?
      `),

      resolveAllConflictsSkipForBucket: this.db.prepare(`
        UPDATE file_queue
        SET status = 'completed', completed_at = datetime('now', 'localtime'),
            updated_at = datetime('now', 'localtime')
        WHERE status = 'conflict' AND bucket_id = ?
      `),

      retryError: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            error_message = NULL, updated_at = datetime('now', 'localtime')
        WHERE id = ? AND status = 'error'
      `),

      retryAllErrors: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            error_message = NULL, updated_at = datetime('now', 'localtime')
        WHERE status = 'error'
      `),

      retryAllErrorsForBucket: this.db.prepare(`
        UPDATE file_queue
        SET status = 'pending', worker_id = NULL, started_at = NULL,
            error_message = NULL, updated_at = datetime('now', 'localtime')
        WHERE status = 'error' AND bucket_id = ?
      `),

      getServiceState: this.db.prepare(`
        SELECT value FROM service_state WHERE key = ?
      `),

      setServiceState: this.db.prepare(`
        INSERT INTO service_state (key, value, updated_at)
        VALUES (@key, @value, datetime('now', 'localtime'))
        ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now', 'localtime')
      `),

      createBucket: this.db.prepare(`
        INSERT INTO buckets (name, source_folders, destination_folder, worker_count)
        VALUES (@name, @sourceFolders, @destinationFolder, @workerCount)
      `),

      updateBucket: this.db.prepare(`
        UPDATE buckets
        SET name = COALESCE(@name, name),
            source_folders = COALESCE(@sourceFolders, source_folders),
            destination_folder = COALESCE(@destinationFolder, destination_folder),
            worker_count = COALESCE(@workerCount, worker_count),
            updated_at = datetime('now', 'localtime')
        WHERE id = @id
      `),

      updateBucketStatus: this.db.prepare(`
        UPDATE buckets SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?
      `),

      deleteBucket: this.db.prepare(`DELETE FROM buckets WHERE id = ?`),

      deleteFilesByBucket: this.db.prepare(`DELETE FROM file_queue WHERE bucket_id = ?`),

      getBucket: this.db.prepare(`SELECT * FROM buckets WHERE id = ?`),

      getAllBuckets: this.db.prepare(`SELECT * FROM buckets ORDER BY id`),
    };

    this._addFilesTransaction = this.db.transaction((files) => {
      let added = 0;
      for (const file of files) {
        const result = this._stmts.insertFile.run(file);
        if (result.changes > 0) added++;
      }
      return added;
    });

    this._claimPendingTransaction = this.db.transaction((limit, workerId) => {
      const rows = this._stmts.getNextPending.all(limit);
      const claimed = [];
      for (const row of rows) {
        const result = this._stmts.markInProgress.run({ id: row.id, workerId });
        if (result.changes > 0) {
          row.status = 'in_progress';
          row.worker_id = workerId;
          claimed.push(row);
        }
      }
      return claimed;
    });

    this._claimPendingForBucketTransaction = this.db.transaction((bucketId, limit, workerId) => {
      const rows = this._stmts.getNextPendingForBucket.all(bucketId, limit);
      const claimed = [];
      for (const row of rows) {
        const result = this._stmts.markInProgress.run({ id: row.id, workerId });
        if (result.changes > 0) {
          row.status = 'in_progress';
          row.worker_id = workerId;
          claimed.push(row);
        }
      }
      return claimed;
    });

    this._claimPendingForBucketAndFolderTransaction = this.db.transaction((bucketId, sourceFolder, limit, workerId) => {
      const rows = this._stmts.getNextPendingForBucketAndFolder.all(bucketId, sourceFolder, limit);
      const claimed = [];
      for (const row of rows) {
        const result = this._stmts.markInProgress.run({ id: row.id, workerId });
        if (result.changes > 0) {
          row.status = 'in_progress';
          row.worker_id = workerId;
          claimed.push(row);
        }
      }
      return claimed;
    });
  }

  createBucket(data) {
    const result = this._stmts.createBucket.run({
      name: data.name,
      sourceFolders: JSON.stringify(data.sourceFolders || []),
      destinationFolder: data.destinationFolder,
      workerCount: data.workerCount || config.workers.defaultCount,
    });
    return this.getBucket(result.lastInsertRowid);
  }

  updateBucket(id, data) {
    this._stmts.updateBucket.run({
      id,
      name: data.name || null,
      sourceFolders: data.sourceFolders ? JSON.stringify(data.sourceFolders) : null,
      destinationFolder: data.destinationFolder || null,
      workerCount: data.workerCount || null,
    });
    return this.getBucket(id);
  }

  updateBucketStatus(id, status) {
    this._stmts.updateBucketStatus.run(status, id);
  }

  deleteBucket(id) {
    this._stmts.deleteFilesByBucket.run(id);
    return this._stmts.deleteBucket.run(id);
  }

  getBucket(id) {
    const row = this._stmts.getBucket.get(id);
    if (!row) return null;
    row.source_folders = JSON.parse(row.source_folders);
    return row;
  }

  getAllBuckets() {
    const rows = this._stmts.getAllBuckets.all();
    for (const row of rows) {
      row.source_folders = JSON.parse(row.source_folders);
    }
    return rows;
  }

  addFiles(files) {
    return this._addFilesTransaction(files);
  }

  addFilesForBucket(bucketId, files) {
    const enriched = files.map((f) => ({
      ...f,
      bucketId,
      status: f.status || 'pending',
      errorMessage: f.errorMessage || null,
    }));
    return this._addFilesTransaction(enriched);
  }

  getNextPending(limit = 1, workerId = 0) {
    return this._claimPendingTransaction(limit, workerId);
  }

  getNextPendingForBucket(bucketId, limit = 1, workerId = 0) {
    return this._claimPendingForBucketTransaction(bucketId, limit, workerId);
  }

  getNextPendingForBucketAndFolder(bucketId, sourceFolder, limit = 1, workerId = 0) {
    return this._claimPendingForBucketAndFolderTransaction(bucketId, sourceFolder, limit, workerId);
  }

  getActiveFolderCounts(bucketId) {
    const rows = this._stmts.getActiveFolderCounts.all(bucketId);
    const result = {};
    for (const row of rows) {
      result[row.source_folder] = { pending: row.pending, inProgress: row.in_progress };
    }
    return result;
  }

  getStatsByBucketGroupedByFolder(bucketId) {
    const rows = this._stmts.getStatsByBucketGroupedByFolder.all(bucketId);
    const result = {};
    for (const row of rows) {
      if (!result[row.source_folder]) {
        result[row.source_folder] = {
          source_folder: row.source_folder,
          pending: { count: 0, totalSize: 0 },
          in_progress: { count: 0, totalSize: 0 },
          completed: { count: 0, totalSize: 0 },
          error: { count: 0, totalSize: 0 },
          conflict: { count: 0, totalSize: 0 },
        };
      }
      if (result[row.source_folder][row.status]) {
        result[row.source_folder][row.status] = { count: row.count, totalSize: row.totalSize };
      }
    }
    return result;
  }

  updateStatus(id, status, extras = {}) {
    return this._stmts.updateStatus.run({
      id,
      status,
      sourceHash: extras.sourceHash || null,
      destinationHash: extras.destinationHash || null,
      errorMessage: extras.errorMessage || null,
      workerId: extras.workerId != null ? extras.workerId : null,
      startedAt: extras.startedAt || null,
      completedAt: extras.completedAt || null,
    });
  }

  getStats() {
    const rows = this._stmts.getStats.all();
    return this._buildStats(rows);
  }

  getStatsByBucket(bucketId) {
    const rows = this._stmts.getStatsByBucket.all(bucketId);
    return this._buildStats(rows);
  }

  _buildStats(rows) {
    const stats = {
      pending: { count: 0, totalSize: 0 },
      in_progress: { count: 0, totalSize: 0 },
      completed: { count: 0, totalSize: 0 },
      error: { count: 0, totalSize: 0 },
      conflict: { count: 0, totalSize: 0 },
    };
    for (const row of rows) {
      if (stats[row.status]) {
        stats[row.status] = { count: row.count, totalSize: row.totalSize };
      }
    }
    return stats;
  }

  getFilesByStatus(status, limit = 100, offset = 0) {
    if (!status || status === 'all') {
      return this._stmts.getAllFiles.all({ limit, offset });
    }
    return this._stmts.getFilesByStatus.all({ status, limit, offset });
  }

  getFilesByStatusForBucket(bucketId, status, limit = 100, offset = 0) {
    if (!status || status === 'all') {
      return this._stmts.getAllFilesForBucket.all({ bucketId, limit, offset });
    }
    return this._stmts.getFilesByStatusForBucket.all({ bucketId, status, limit, offset });
  }

  getRecentActivity(limit = 50) {
    return this._stmts.getRecentActivity.all(limit);
  }

  getRecentActivityForBucket(bucketId, limit = 50) {
    return this._stmts.getRecentActivityForBucket.all(bucketId, limit);
  }

  resolveConflict(id, action) {
    if (action === 'overwrite') {
      return this._stmts.resolveConflictOverwrite.run(id);
    }
    if (action === 'skip') {
      return this._stmts.resolveConflictSkip.run(id);
    }
    throw new Error(`Ação inválida: ${action}`);
  }

  resolveAllConflicts(action) {
    if (action === 'overwrite') {
      return this._stmts.resolveAllConflictsOverwrite.run();
    }
    if (action === 'skip') {
      return this._stmts.resolveAllConflictsSkip.run();
    }
    throw new Error(`Ação inválida: ${action}`);
  }

  resolveAllConflictsForBucket(bucketId, action) {
    if (action === 'overwrite') {
      return this._stmts.resolveAllConflictsOverwriteForBucket.run(bucketId);
    }
    if (action === 'skip') {
      return this._stmts.resolveAllConflictsSkipForBucket.run(bucketId);
    }
    throw new Error(`Ação inválida: ${action}`);
  }

  retryError(id) {
    return this._stmts.retryError.run(id);
  }

  retryAllErrors() {
    return this._stmts.retryAllErrors.run();
  }

  retryAllErrorsForBucket(bucketId) {
    return this._stmts.retryAllErrorsForBucket.run(bucketId);
  }

  deleteFilesByBucket(bucketId) {
    return this._stmts.deleteFilesByBucket.run(bucketId);
  }

  getServiceState(key) {
    const row = this._stmts.getServiceState.get(key);
    return row ? row.value : null;
  }

  setServiceState(key, value) {
    return this._stmts.setServiceState.run({ key, value: String(value) });
  }

  close() {
    this.db.close();
  }
}

module.exports = new FileQueueDB();
module.exports.FileQueueDB = FileQueueDB;
