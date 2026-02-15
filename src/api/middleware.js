const { AppError, ValidationError } = require('../errors');

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return next(new ValidationError('Dados inválidos', details));
    }
    if (!req.validated) req.validated = {};
    req.validated[source] = result.data;
    next();
  };
}

function errorHandler(broadcast) {
  return (err, _req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      return res.status(err.statusCode).json(body);
    }

    console.error('Erro não tratado:', err);
    if (broadcast) {
      broadcast('error', { message: err.message, timestamp: new Date().toISOString() });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' },
    });
  };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { validate, errorHandler, asyncHandler };
