const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../../src/errors');

describe('AppError', () => {
  it('sets message correctly', () => {
    const err = new AppError('test message');
    assert.equal(err.message, 'test message');
  });

  it('defaults statusCode to 500', () => {
    const err = new AppError('msg');
    assert.equal(err.statusCode, 500);
  });

  it('defaults code to INTERNAL_ERROR', () => {
    const err = new AppError('msg');
    assert.equal(err.code, 'INTERNAL_ERROR');
  });

  it('defaults details to null', () => {
    const err = new AppError('msg');
    assert.equal(err.details, null);
  });

  it('sets isOperational to true', () => {
    const err = new AppError('msg');
    assert.equal(err.isOperational, true);
  });

  it('sets name to AppError', () => {
    const err = new AppError('msg');
    assert.equal(err.name, 'AppError');
  });

  it('is an instance of Error', () => {
    const err = new AppError('msg');
    assert.ok(err instanceof Error);
  });

  it('accepts custom statusCode, code, and details', () => {
    const details = [{ field: 'x' }];
    const err = new AppError('custom', 422, 'CUSTOM_CODE', details);
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'CUSTOM_CODE');
    assert.deepEqual(err.details, details);
  });
});

describe('NotFoundError', () => {
  it('sets statusCode to 404', () => {
    const err = new NotFoundError();
    assert.equal(err.statusCode, 404);
  });

  it('sets code to NOT_FOUND', () => {
    const err = new NotFoundError();
    assert.equal(err.code, 'NOT_FOUND');
  });

  it('has a default message', () => {
    const err = new NotFoundError();
    assert.ok(err.message.length > 0);
  });

  it('is an instance of AppError and Error', () => {
    const err = new NotFoundError();
    assert.ok(err instanceof AppError);
    assert.ok(err instanceof Error);
  });

  it('accepts custom message and details', () => {
    const err = new NotFoundError('nope', { id: 1 });
    assert.equal(err.message, 'nope');
    assert.deepEqual(err.details, { id: 1 });
  });
});

describe('ValidationError', () => {
  it('sets statusCode to 400', () => {
    const err = new ValidationError();
    assert.equal(err.statusCode, 400);
  });

  it('sets code to VALIDATION_ERROR', () => {
    const err = new ValidationError();
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  it('has a default message', () => {
    const err = new ValidationError();
    assert.ok(err.message.length > 0);
  });
});

describe('ConflictError', () => {
  it('sets statusCode to 409', () => {
    const err = new ConflictError();
    assert.equal(err.statusCode, 409);
  });

  it('sets code to CONFLICT', () => {
    const err = new ConflictError();
    assert.equal(err.code, 'CONFLICT');
  });

  it('has a default message', () => {
    const err = new ConflictError();
    assert.ok(err.message.length > 0);
  });

  it('accepts custom message and details', () => {
    const err = new ConflictError('dup', { key: 'val' });
    assert.equal(err.message, 'dup');
    assert.deepEqual(err.details, { key: 'val' });
  });
});
