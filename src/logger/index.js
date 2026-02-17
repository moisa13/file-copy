const fs = require('fs');
const rfs = require('rotating-file-stream');
const config = require('../config');

const STATUS_CHANNEL_MAP = {
  pending: 'pendente',
  in_progress: 'em_andamento',
  completed: 'finalizado',
  error: 'erro',
  conflict: 'conflito',
};

const CHANNELS = ['geral', 'pendente', 'em_andamento', 'erro', 'conflito', 'finalizado'];

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(2)} ${units[i]}`;
}

function filenameGenerator(channel) {
  return (time, index) => {
    if (!time) return `${channel}.log`;
    const date = time.toISOString().slice(0, 10);
    return `${channel}-${date}-${index}.log`;
  };
}

class Logger {
  constructor() {
    this.streams = {};
    this._drainState = {};
    this._init();
  }

  _init() {
    fs.mkdirSync(config.logging.directory, { recursive: true });

    for (const channel of CHANNELS) {
      this.streams[channel] = rfs.createStream(filenameGenerator(channel), {
        size: config.logging.maxFileSize,
        maxFiles: config.logging.maxFiles,
        path: config.logging.directory,
      });
      this._drainState[channel] = true;
      this.streams[channel].on('drain', () => {
        this._drainState[channel] = true;
      });
    }
  }

  _write(channel, line) {
    const stream = this.streams[channel];
    if (!stream) return;
    const ok = stream.write(line);
    if (!ok) {
      this._drainState[channel] = false;
    }
  }

  log(status, data = {}) {
    const channel = STATUS_CHANNEL_MAP[status] || status;
    const timestamp = new Date().toISOString();
    const statusLabel = (status || '').toUpperCase();
    const workerId = data.workerId != null ? data.workerId : '-';
    const filePath = data.sourcePath || data.file || '-';
    const sourceFolder = data.sourceFolder || '-';
    const fileSize = data.fileSize != null ? `${formatSize(data.fileSize)} (${data.fileSize})` : '-';
    const hash = data.sourceHash || data.hash || '-';
    const message = data.message || data.errorMessage || '';

    const bucketLabel = data.bucketName ? `[Bucket:${data.bucketName}] ` : '';
    const line = `[${timestamp}] [${statusLabel}] ${bucketLabel}[Worker:${workerId}] Arquivo: ${filePath} | Origem: ${sourceFolder} | Tamanho: ${fileSize} | Hash: ${hash} | ${message}\n`;

    this._write('geral', line);

    if (channel !== 'geral') {
      this._write(channel, line);
    }
  }

  system(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [SYSTEM] ${message}\n`;
    this._write('geral', line);
  }

  close() {
    for (const channel of CHANNELS) {
      if (this.streams[channel]) {
        this.streams[channel].end();
      }
    }
  }
}

module.exports = new Logger();
module.exports.formatSize = formatSize;
