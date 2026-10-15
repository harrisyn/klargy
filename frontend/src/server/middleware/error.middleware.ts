import { Request, Response, NextFunction } from 'express';

export const errorHandler = (
  err: Error & { status?: number },
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('Error:', err);

  // Only expose internal error messages outside production - a raw Prisma
  // error can leak table/column names and query details. Stack traces never
  // go in a response body (any environment); they are in the server log above.
  const exposeMessage = status < 500 || process.env.NODE_ENV !== 'production';
  res.status(status).json({
    error: exposeMessage ? err.message || 'Internal server error' : 'Internal server error',
  });
};
