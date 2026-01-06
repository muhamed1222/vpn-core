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
  botToken?: string; // Добавляем botToken для поддержки initData в Authorization header
}

/**
 * Middleware для проверки авторизации
 * Поддерживает два способа:
 * 1. Cookie-based auth (JWT в cookie) - для vpn_bot
 * 2. initData в Authorization header - для vpnwebsite
 */
export function createVerifyAuth(options: VerifyAuthOptions) {
  const { jwtSecret, cookieName, botToken } = options;

  return async function verifyAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Вариант 1: Cookie-based auth (для vpn_bot)
    const token = request.cookies[cookieName];
    if (token) {
      const payload = verifyToken({ token, secret: jwtSecret });
      if (payload) {
        request.user = {
          tgId: payload.tgId,
          username: payload.username,
          firstName: payload.firstName,
        };
        return;
      }
    }

    // Вариант 2: initData в Authorization header (для vpnwebsite)
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
          };
          return;
        } else {
          // Логируем ошибку валидации для отладки
          console.warn('[verifyAuth] initData validation failed:', {
            error: verifyResult.error,
            hasInitData: !!initData,
            hasBotToken: !!botToken,
            initDataLength: initData?.length,
          });
        }
      } catch (error) {
        console.error('[verifyAuth] Error verifying initData:', error);
      }
    } else {
      // Логируем, если нет initData или botToken
      if (!initData) {
        console.warn('[verifyAuth] No initData in Authorization header');
      }
      if (!botToken) {
        console.warn('[verifyAuth] No botToken provided to verifyAuth');
      }
    }

    // Если ни один способ не сработал
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  };
}


