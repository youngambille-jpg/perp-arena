// Shared API middleware: Supabase JWT auth, rate limiting,
// zod validation, and the error envelope.

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { verifySupabaseToken } from '../lib/supabase.js';
import { perUserRateLimiter } from '../lib/ratelimit.js';

export interface AuthedRequest extends Request {
  userId: string;
}

/** Requires a `Bearer <supabase access token>` header. */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    next(ApiError.unauthorized('Missing bearer token'));
    return;
  }
  const userId = await verifySupabaseToken(token);
  if (!userId) {
    next(ApiError.unauthorized('Invalid or expired token'));
    return;
  }
  (req as AuthedRequest).userId = userId;

  if (!perUserRateLimiter.allow(`user:${userId}`)) {
    next(ApiError.tooManyRequests('Rate limit exceeded (60/min)'));
    return;
  }
  next();
}

/** Validates req.body against a zod schema; 400s on failure. */
export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        ApiError.badRequest(
          'invalid_body',
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        ),
      );
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/** Validates req.query against a zod schema; 400s on failure. */
export function validateQuery<T>(schema: z.ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      next(
        ApiError.badRequest(
          'invalid_query',
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        ),
      );
      return;
    }
    // Express 5 exposes req.query as a getter-only property, so
    // the validated result is stashed alongside instead.
    (req as Request & { validatedQuery: T }).validatedQuery = parsed.data;
    next();
  };
}

/** Final error handler: { error: { code, message } }. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error('unhandled error', error);
  res
    .status(500)
    .json({ error: { code: 'internal', message: 'Internal server error' } });
}

/** Wraps async route handlers so rejections reach errorHandler. */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}
