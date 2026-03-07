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
 * Внутренняя попытка аутентификации.
 * Возвращает AuthenticationResult или null (если нет данных).
 * Бросает ошибку с prefix INVALID: если данные переданы, но невалидны.
 */
async function tryAuthenticate(
  request: FastifyRequest,
  options: VerifyAuthOptions,
  adminIds: Set<number>
): Promise<AuthenticationResult | null> {
  const { jwtSecret, cookieName, botToken, adminApiKey } = options;
  const isAdminUser = (tgId?: number): boolean => !!tgId && adminIds.has(tgId);

  // Вариант 1: Admin API Key (для VPN Bot)
  const apiKey = request.headers['x-admin-api-key'];
  if (adminApiKey && apiKey === adminApiKey) {
    return { isAdmin: true, tgId: 0 };
  }

  // Вариант 2: Cookie-based auth (JWT в cookie)
  const token = request.cookies[cookieName];
  if (token) {
    const payload = verifyToken({ token, secret: jwtSecret });
    if (payload) {
      return {
        tgId: payload.tgId,
        username: payload.username,
        firstName: payload.firstName,
        isAdmin: isAdminUser(payload.tgId),
      };
    }
  }

  // Вариант 3: initData в Authorization header (для Mini App / Website)
  const authHeader = request.headers.authorization;
  if (authHeader && botToken) {
    const { verifyTelegramInitData } = await import('./telegram.js');
    const verifyResult = verifyTelegramInitData({ initData: authHeader, botToken });

    if (verifyResult.valid && verifyResult.user) {
      return {
        tgId: verifyResult.user.id,
        username: verifyResult.user.username,
        firstName: verifyResult.user.first_name,
        isAdmin: isAdminUser(verifyResult.user.id),
      };
    }

    // initData передана, но не прошла проверку — это явная ошибка
    throw new Error(`INVALID:${verifyResult.error || 'Invalid Telegram data'}`);
  }

  // Нет ни одного способа авторизации
  return null;
}

function buildAdminIds(): Set<number> {
  return new Set(
    (process.env.ADMIN_ID || '')
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
}

/**
 * Middleware для ОБЯЗАТЕЛЬНОЙ проверки авторизации.
 * Если авторизация не прошла — отправляет 401.
 */
export function createVerifyAuth(options: VerifyAuthOptions) {
  const adminIds = buildAdminIds();

  return async function verifyAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const authResult = await tryAuthenticate(request, options, adminIds);
      if (authResult) {
        request.user = authResult;
        return;
      }
      // Нет данных авторизации
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    } catch (error: any) {
      const msg = error?.message?.startsWith('INVALID:')
        ? error.message.replace('INVALID:', '')
        : 'Authentication required';
      return reply.status(401).send({
        error: 'Unauthorized',
        message: msg,
      });
    }
  };
}

/**
 * Middleware для ОПЦИОНАЛЬНОЙ проверки авторизации.
 * Если авторизация не прошла — пропускает запрос (request.user = undefined).
 * Ошибки игнорируются.
 */
export function createVerifyAuthOptional(options: VerifyAuthOptions) {
  const adminIds = buildAdminIds();

  return async function verifyAuthOptional(
    request: FastifyRequest,
    _reply: FastifyReply
  ): Promise<void> {
    try {
      const authResult = await tryAuthenticate(request, options, adminIds);
      if (authResult) {
        request.user = authResult;
      }
    } catch {
      // Опциональная авторизация — игнорируем все ошибки
    }
  };
}
