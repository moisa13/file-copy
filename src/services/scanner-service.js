const { NotFoundError } = require('../errors');
const scanner = require('../scanner');
const database = require('../queue/database');
const logger = require('../logger');

class ScannerService {
  constructor(bucketManager, broadcast) {
    this.bucketManager = bucketManager;
    this.broadcast = broadcast;
  }

  scanBucket(id) {
    const bucket = this.bucketManager.getBucket(id);
    if (!bucket) throw new NotFoundError('Bucket não encontrado');

    scanner.scanBucket(bucket).then((result) => {
      this.broadcast('scan-complete', { bucketId: id, found: result.found, added: result.added });
      this.broadcast('stats-update', database.getStatsByBucket(id));
    }).catch((err) => {
      logger.system(`Erro durante varredura do bucket ${id}: ${err.message}`);
    });

    return { status: 'scanning' };
  }

  scanAll() {
    scanner.scanAll().then((result) => {
      this.broadcast('scan-complete', { bucketId: null, totalFound: result.totalFound, totalAdded: result.totalAdded });
      this.broadcast('stats-update-global', database.getStats());
    }).catch((err) => {
      logger.system(`Erro durante varredura global: ${err.message}`);
    });

    return { status: 'scanning' };
  }
}

module.exports = ScannerService;
