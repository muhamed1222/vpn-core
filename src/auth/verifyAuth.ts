import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './jwt.js';

export interface AuthenticatedUser {
  tgId: number;
  username?: string;
  firstName?: string;
}

// Расширяем типы Fastify для request.user
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export interface VerifyAuthOptions {
  jwtSecret: string;
  cookieName: string;
}

/**
 * Middleware для проверки авторизации через JWT в cookie
 */
export function createVerifyAuth(options: VerifyAuthOptions) {
  const { jwtSecret, cookieName } = options;

  return async function verifyAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Читаем cookie
    const token = request.cookies[cookieName];

    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    // Проверяем JWT
    const payload = verifyToken({ token, secret: jwtSecret });

    if (!payload) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
      });
    }

    // Кладем пользователя в request.user
    request.user = {
      tgId: payload.tgId,
      username: payload.username,
      firstName: payload.firstName,
    };
  };
}


