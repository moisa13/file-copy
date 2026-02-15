const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

require('../helpers/setup');
const { validate, errorHandler, asyncHandler } = require('../../src/api/middleware');
const { AppError, NotFoundError, ValidationError } = require('../../src/errors');

function createRes() {
  const res = {
    _status: null,
    _json: null,
    status(code) {
      res._status = code;
      return res;
    },
    json(data) {
      res._json = data;
      return res;
    },
  };
  return res;
}

describe('validate()', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('calls next() on valid body', () => {
    const next = mock.fn();
    const req = { body: { name: 'test' } };
    validate(schema, 'body')(req, {}, next);
    assert.equal(next.mock.calls.length, 1);
    assert.equal(next.mock.calls[0].arguments[0], undefined);
  });

  it('populates req.validated.body on success', () => {
    const next = mock.fn();
    const req = { body: { name: 'test' } };
    validate(schema, 'body')(req, {}, next);
    assert.deepEqual(req.validated.body, { name: 'test' });
  });

  it('validates params source', () => {
    const paramSchema = z.object({ id: z.coerce.number().int().positive() });
    const next = mock.fn();
    const req = { params: { id: '5' } };
    validate(paramSchema, 'params')(req, {}, next);
    assert.equal(req.validated.params.id, 5);
  });

  it('calls next with ValidationError on invalid body', () => {
    const next = mock.fn();
    const req = { body: { name: '' } };
    validate(schema, 'body')(req, {}, next);
    assert.equal(next.mock.calls.length, 1);
    const err = next.mock.calls[0].arguments[0];
    assert.ok(err instanceof ValidationError);
    assert.ok(Array.isArray(err.details));
  });

  it('preserves existing req.validated from prior middleware', () => {
    const next = mock.fn();
    const req = { body: { name: 'test' }, validated: { params: { id: 1 } } };
    validate(schema, 'body')(req, {}, next);
    assert.equal(req.validated.params.id, 1);
    assert.equal(req.validated.body.name, 'test');
  });
});

describe('errorHandler()', () => {
  it('responds with AppError statusCode and code', () => {
    const handler = errorHandler();
    const res = createRes();
    const err = new AppError('fail', 422, 'CUSTOM');
    handler(err, {}, res, () => {});
    assert.equal(res._status, 422);
    assert.equal(res._json.error.code, 'CUSTOM');
    assert.equal(res._json.error.message, 'fail');
  });

  it('includes details when present on AppError', () => {
    const handler = errorHandler();
    const res = createRes();
    const err = new ValidationError('bad', [{ path: 'x', message: 'required' }]);
    handler(err, {}, res, () => {});
    assert.ok(res._json.error.details);
    assert.equal(res._json.error.details[0].path, 'x');
  });

  it('responds with 404 for NotFoundError', () => {
    const handler = errorHandler();
    const res = createRes();
    handler(new NotFoundError(), {}, res, () => {});
    assert.equal(res._status, 404);
  });

  it('responds with 500 for generic Error', () => {
    const handler = errorHandler();
    const res = createRes();
    handler(new Error('oops'), {}, res, () => {});
    assert.equal(res._status, 500);
    assert.equal(res._json.error.code, 'INTERNAL_ERROR');
  });

  it('calls broadcast on generic error if provided', () => {
    const broadcastFn = mock.fn();
    const handler = errorHandler(broadcastFn);
    const res = createRes();
    handler(new Error('oops'), {}, res, () => {});
    assert.equal(broadcastFn.mock.calls.length, 1);
    assert.equal(broadcastFn.mock.calls[0].arguments[0], 'error');
  });

  it('does not call broadcast for AppError', () => {
    const broadcastFn = mock.fn();
    const handler = errorHandler(broadcastFn);
    const res = createRes();
    handler(new AppError('x'), {}, res, () => {});
    assert.equal(broadcastFn.mock.calls.length, 0);
  });
});

describe('asyncHandler()', () => {
  it('calls handler and works for resolved promise', async () => {
    const handler = mock.fn(async (_req, res) => {
      res.json({ ok: true });
    });
    const wrapped = asyncHandler(handler);
    const res = createRes();
    const next = mock.fn();
    await wrapped({}, res, next);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(handler.mock.calls.length, 1);
    assert.deepEqual(res._json, { ok: true });
  });

  it('calls next with error for rejected promise', async () => {
    const error = new Error('async fail');
    const handler = mock.fn(async () => {
      throw error;
    });
    const wrapped = asyncHandler(handler);
    const next = mock.fn();
    await wrapped({}, {}, next);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(next.mock.calls.length, 1);
    assert.equal(next.mock.calls[0].arguments[0], error);
  });
});
