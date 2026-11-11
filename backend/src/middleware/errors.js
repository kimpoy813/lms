// Final error handling: every failure becomes { error: { code, message, details? } }.
import { ZodError } from 'zod';
import { Prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { zodFieldErrors } from './validate.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' } });
}

/** PostgreSQL SQLSTATE of the underlying driver error, when there is one. */
function sqlState(err) {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ??
    err?.cause?.originalCode ??
    err?.cause?.code ??
    (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : undefined)
  );
}

function fromPrisma(err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = err.meta?.driverAdapterError?.cause?.constraint?.fields ?? err.meta?.target ?? [];
      return new AppError(409, 'ALREADY_EXISTS', 'A record with the same value already exists.', {
        fields: Object.fromEntries([].concat(fields).map((f) => [f, 'Already in use'])),
      });
    }
    if (err.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Record not found.');
    if (err.code === 'P2003' || err.code === 'P2014') {
      return new AppError(409, 'IN_USE', 'This record is referenced by other records and cannot be removed.');
    }
    if (err.code === 'P2034') {
      return new AppError(409, 'WRITE_CONFLICT', 'Another change was saved at the same time. Please try again.');
    }
  }
  const state = sqlState(err);
  // 23503 foreign_key_violation, 23001 restrict_violation (PostgreSQL 18 reports RESTRICT this way)
  if (state === '23503' || state === '23001') {
    return new AppError(409, 'IN_USE', 'This record is referenced by other records and cannot be removed.');
  }
  if (state === '23505') return new AppError(409, 'ALREADY_EXISTS', 'A record with the same value already exists.');
  if (state === '40001' || state === '40P01') {
    return new AppError(409, 'WRITE_CONFLICT', 'Another change was saved at the same time. Please try again.');
  }
  return null;
}

function normalise(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', { fields: zodFieldErrors(err) });
  }
  const prismaError = fromPrisma(err);
  if (prismaError) return prismaError;

  // body-parser / multer
  if (err?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
  if (err?.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  if (err?.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError(413, 'FILE_TOO_LARGE', 'The file exceeds the maximum upload size.');
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return new AppError(400, 'TOO_MANY_FILES', 'Too many files were uploaded at once.');
    }
    return new AppError(400, 'UPLOAD_ERROR', 'The upload could not be processed.');
  }
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) {
    return new AppError(err.status, 'BAD_REQUEST', err.message || 'Bad request.');
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const known = normalise(err);
  if (known) {
    if (known.status >= 500) logger.error({ err, reqId: req.id }, known.message);
    if (res.headersSent) return res.end();
    return res.status(known.status).json({
      error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) },
    });
  }
  logger.error({ err, reqId: req.id, method: req.method, url: req.originalUrl }, 'unhandled error');
  if (res.headersSent) return res.end();
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again. If the problem continues, contact your administrator.',
      reference: req.id,
    },
  });
}
