import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiError } from '../lib/api-error.js';

export type AuthenticatedUser = NonNullable<Express.Request['user']>;
type RawSessionUser = {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  isActive?: boolean;
  preferredLocale?: string;
};
export type SessionResolver = (headers: Headers) => Promise<{ user?: RawSessionUser } | null>;

const betterAuthSessionResolver: SessionResolver = async (headers) => {
  const { auth } = await import('../lib/auth.js');
  return await auth.api.getSession({ headers }) as { user?: RawSessionUser } | null;
};

export const createRequireAuth = (
  resolveSession: SessionResolver = betterAuthSessionResolver,
): RequestHandler => async (req, _res, next) => {
  try {
    const session = await resolveSession(fromNodeHeaders(req.headers));
    const sessionUser = session?.user;

    if (!sessionUser?.id || !sessionUser.email || !sessionUser.name || !sessionUser.role) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }

    if (!['admin', 'teacher', 'student'].includes(sessionUser.role)) {
      throw new ApiError(403, 'ROLE_INVALID', 'Account role is not allowed');
    }

    if (sessionUser.isActive === false) {
      throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account is inactive');
    }

    req.user = {
      id: sessionUser.id,
      name: sessionUser.name,
      email: sessionUser.email,
      role: sessionUser.role as UserRole,
      isActive: sessionUser.isActive ?? true,
      preferredLocale: sessionUser.preferredLocale === 'vi' ? 'vi' : 'en',
    };
    next();
  } catch (error) {
    next(error);
  }
};

export const requireRole = (...roles: UserRole[]): RequestHandler => (req, _res, next) => {
  if (!req.user) return next(new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required'));
  if (!roles.includes(req.user.role)) {
    return next(new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action', {
      requiredRole: roles.join('|'),
    }));
  }
  next();
};
