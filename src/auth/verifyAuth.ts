import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './jwt.js';

export interface AuthenticationResult {
  tgId: number;
  username?: string;
  firstName?: string;
  isAdmin?: boolean;
}

// Расширяем типы Fastify для request.user
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticationResult;
  }
}

export interface VerifyAuthOptions {
  jwtSecret: string;
  cookieName: string;
  botToken?: string;
  adminApiKey?: string;
}

/**
 * Middleware для проверки авторизации
 * Поддерживает три способа:
 * 1. Admin API Key (x-admin-api-key) - для сервисов (vpn-bot)
 * 2. Cookie-based auth (JWT в cookie) - для браузера
 * 3. initData в Authorization header - для Mini App
 */
export function createVerifyAuth(options: VerifyAuthOptions) {
  const { jwtSecret, cookieName, botToken, adminApiKey } = options;

  return async function verifyAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Вариант 1: Admin API Key (для vpn-bot)
    const apiKey = request.headers['x-admin-api-key'];
    if (adminApiKey && apiKey === adminApiKey) {
      request.user = { isAdmin: true, tgId: 0 }; // tgId 0 для админа (заглушка)
      return;
    }

    // Вариант 2: Cookie-based auth (JWT в cookie)
    const token = request.cookies[cookieName];
    if (token) {
      const payload = verifyToken({ token, secret: jwtSecret });
      if (payload) {
        request.user = {
          tgId: payload.tgId,
          username: payload.username,
          firstName: payload.firstName,
          isAdmin: false
        };
        return;
      }
    }

    // Вариант 3: initData в Authorization header (для vpn-tg-app)
    const initData = request.headers.authorization;
    if (initData && botToken) {
      try {
        const { verifyTelegramInitData } = await import('./telegram.js');
        const verifyResult = verifyTelegramInitData({
          initData,
          botToken,
        });

        if (verifyResult.valid && verifyResult.user) {
          request.user = {
            tgId: verifyResult.user.id,
            username: verifyResult.user.username,
            firstName: verifyResult.user.first_name,
            isAdmin: false
          };
          return;
        }
      } catch (error) {
        console.error('[verifyAuth] Error verifying initData:', error);
      }
    }

    // Если ни один способ не сработал
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  };
}

