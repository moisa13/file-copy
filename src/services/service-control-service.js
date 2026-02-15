const { NotFoundError, ValidationError } = require('../errors');

class ServiceControlService {
  constructor(bucketManager) {
    this.bucketManager = bucketManager;
  }

  _handleError(err) {
    if (err.message.includes('não encontrado')) throw new NotFoundError(err.message);
    throw new ValidationError(err.message);
  }

  getStatus(id) {
    try {
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }

  start(id) {
    try {
      this.bucketManager.startBucket(id);
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }

  pause(id) {
    try {
      this.bucketManager.pauseBucket(id);
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }

  resume(id) {
    try {
      this.bucketManager.resumeBucket(id);
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }

  async stop(id) {
    try {
      await this.bucketManager.stopBucket(id);
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }

  setWorkerCount(id, count) {
    try {
      this.bucketManager.setWorkerCount(id, count);
      return this.bucketManager.getBucketStatus(id);
    } catch (err) {
      this._handleError(err);
    }
  }
}

module.exports = ServiceControlService;
