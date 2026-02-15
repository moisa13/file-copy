const database = require('../queue/database');
const pkg = require('../../package.json');

class HealthService {
  constructor(bucketManager) {
    this.bucketManager = bucketManager;
    this.startTime = Date.now();
  }

  getHealth() {
    let dbConnected = true;
    try {
      database.getStats();
    } catch (_) {
      dbConnected = false;
    }

    const pools = Array.from(this.bucketManager.pools.values());
    const activePools = pools.filter((p) => p.status === 'running' || p.status === 'paused');
    const totalWorkers = pools.reduce((sum, p) => sum + p.workerCount, 0);
    const activeWorkers = pools.reduce((sum, p) => sum + p.activeWorkers, 0);

    let status = 'healthy';
    if (!dbConnected) {
      status = 'unhealthy';
    } else if (activePools.length > 0 && activeWorkers === 0 && totalWorkers > 0) {
      status = 'degraded';
    }

    const mem = process.memoryUsage();

    return {
      status,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: pkg.version,
      database: { connected: dbConnected },
      buckets: { total: this.bucketManager.pools.size, active: activePools.length },
      workers: { total: totalWorkers, active: activeWorkers },
      memory: {
        heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
        rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      },
    };
  }

  getMetrics() {
    const stats = database.getStats();
    const pools = Array.from(this.bucketManager.pools.values());
    const totalWorkers = pools.reduce((sum, p) => sum + p.workerCount, 0);
    const activeWorkers = pools.reduce((sum, p) => sum + p.activeWorkers, 0);

    const pendingCount = stats.pending ? stats.pending.count : 0;
    const pendingSize = stats.pending ? stats.pending.totalSize : 0;
    const inProgressCount = stats.in_progress ? stats.in_progress.count : 0;
    const inProgressSize = stats.in_progress ? stats.in_progress.totalSize : 0;

    return {
      files: stats,
      queue: {
        depth: pendingCount + inProgressCount,
        size: pendingSize + inProgressSize,
      },
      workers: {
        total: totalWorkers,
        active: activeWorkers,
        utilization: totalWorkers > 0 ? Math.round((activeWorkers / totalWorkers) * 100) : 0,
      },
    };
  }
}

module.exports = HealthService;
