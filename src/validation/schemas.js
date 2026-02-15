const { z } = require('zod');
const config = require('../config');

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'error', 'conflict'];
const VALID_ACTIONS = ['overwrite', 'skip'];

const bucketParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const fileParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  fileId: z.coerce.number().int().positive(),
});

const statusParamsSchema = z.object({
  status: z.enum([...VALID_STATUSES, 'all']),
});

const bucketStatusParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  status: z.enum([...VALID_STATUSES, 'all']),
});

const bucketCreateSchema = z.object({
  name: z.string().min(1, 'name é obrigatório'),
  sourceFolders: z.array(z.string().min(1)).min(1, 'sourceFolders deve conter ao menos 1 pasta').optional().default([]),
  destinationFolder: z.string().min(1, 'destinationFolder é obrigatório'),
  workerCount: z.number().int().min(1).max(config.workers.maxCount).optional(),
});

const bucketUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    sourceFolders: z.array(z.string().min(1)).min(1).optional(),
    destinationFolder: z.string().min(1).optional(),
    workerCount: z.number().int().min(1).max(config.workers.maxCount).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Ao menos um campo deve ser informado',
  });

const workerCountSchema = z.object({
  count: z.number().int().min(1).max(config.workers.maxCount),
});

const conflictResolutionSchema = z.object({
  action: z.enum(VALID_ACTIONS, { errorMap: () => ({ message: 'action deve ser "overwrite" ou "skip"' }) }),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(50),
});

module.exports = {
  VALID_STATUSES,
  VALID_ACTIONS,
  bucketParamsSchema,
  fileParamsSchema,
  statusParamsSchema,
  bucketStatusParamsSchema,
  bucketCreateSchema,
  bucketUpdateSchema,
  workerCountSchema,
  conflictResolutionSchema,
  paginationSchema,
  activityQuerySchema,
};
