import { FastifyInstance, FastifyReply } from 'fastify';
import { verifyTelegramInitData } from '../../auth/telegram.js';
import { createToken, verifyToken } from '../../auth/jwt.js';
import { getUserPhotoUrl } from '../../auth/telegramPhoto.js';
import {
  consumeBrowserAccessLink,
  consumeIosHandoffToken,
  createIosHandoffToken,
  getOrCreateBrowserAccessLink,
  revokeActiveBrowserAccessLinks,
  rotateBrowserAccessLink,
} from '../../storage/browserAuthRepo.js';

export async function authRoutes(fastify: FastifyInstance) {
  const botToken: string = fastify.telegramBotToken;
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const cookieDomain: string = fastify.authCookieDomain || '.outlivion.space';
  const adminApiKey: string = fastify.adminApiKey;
  const webAppBaseUrl: string = fastify.webAppBaseUrl || 'https://my.outlivion.space';

  const setSessionCookie = (reply: FastifyReply, token: string, maxAgeDays: number) => {
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      domain: cookieDomain,
      maxAge: 60 * 60 * 24 * maxAgeDays,
    });
  };

  // POST /v1/auth/telegram
  fastify.post<{ Body: { initData: string } }>(
    '/telegram',
    {
      schema: {
        body: {
          type: 'object',
          required: ['initData'],
          properties: {
            initData: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      fastify.log.info('[auth/telegram] Received auth request');
      const { initData } = request.body;

      const verifyResult = verifyTelegramInitData({
        initData,
        botToken,
      });

      if (!verifyResult.valid || !verifyResult.user) {
        fastify.log.warn(
          {
            error: verifyResult.error,
            botTokenPrefix: botToken ? botToken.substring(0, 10) : 'none'
          },
          'Telegram initData verification failed'
        );
        return reply.status(401).send({
          error: 'Unauthorized',
          message: verifyResult.error || 'Invalid Telegram data',
        });
      }

      const user = verifyResult.user;
      fastify.log.info({ userId: user.id }, '[auth/telegram] Verification successful');

      // Получаем фото профиля: сначала из initData, если нет - через Bot API
      let photoUrl = user.photo_url || null;
      if (!photoUrl && botToken) {
        try {
          photoUrl = await getUserPhotoUrl(user.id, botToken);
          fastify.log.info({ userId: user.id, hasPhoto: !!photoUrl }, '[auth/telegram] Photo URL fetched');
        } catch (error) {
          fastify.log.warn({ userId: user.id, error }, '[auth/telegram] Failed to fetch photo URL');
        }
      }

      // Создаем JWT
      const token = createToken({
        tgId: user.id,
        username: user.username,
        firstName: user.first_name,
        secret: jwtSecret,
      });

      // Устанавливаем cookie
      setSessionCookie(reply, token, 7);

      return reply.send({
        ok: true,
        user: {
          tgId: user.id,
          username: user.username,
          firstName: user.first_name,
          photoUrl: photoUrl, // URL фотографии из initData или Bot API
        },
      });
    }
  );

  // POST /v1/auth/token (для входа по ссылке из бота)
  fastify.post<{ Body: { token: string } }>(
    '/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body;
      const handoff = consumeIosHandoffToken(token);
      const payload = handoff.status === 'active'
        ? {
            tgId: handoff.tgId!,
            username: handoff.username,
            firstName: handoff.firstName,
          }
        : verifyToken({ token, secret: jwtSecret });

      if (!payload || !payload.tgId) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired login token',
        });
      }

      // Получаем фото профиля через Bot API
      let photoUrl: string | null = null;
      if (botToken) {
        try {
          photoUrl = await getUserPhotoUrl(payload.tgId, botToken);
          fastify.log.info({ userId: payload.tgId, hasPhoto: !!photoUrl }, '[auth/token] Photo URL fetched');
        } catch (error) {
          fastify.log.warn({ userId: payload.tgId, error }, '[auth/token] Failed to fetch photo URL');
        }
      }

      // Устанавливаем сессионную cookie (точно так же, как в /telegram)
      const sessionToken = createToken({
        tgId: payload.tgId,
        username: payload.username,
        firstName: payload.firstName,
        secret: jwtSecret,
        expiresInDays: handoff.status === 'active' ? 30 : 7,
      });
      setSessionCookie(reply, sessionToken, handoff.status === 'active' ? 30 : 7);

      return reply.send({
        ok: true,
        user: {
          tgId: payload.tgId,
          username: payload.username,
          firstName: payload.firstName,
          photoUrl: photoUrl, // URL фотографии из Bot API
        },
      });
    }
  );

  fastify.get('/browser-access/link', {
    preHandler: async (request, reply) => {
      const { createVerifyAuth } = await import('../../auth/verifyAuth.js');
      const verifyAuth = createVerifyAuth({ jwtSecret, cookieName, botToken });
      return verifyAuth(request, reply);
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userRef = `tg_${request.user.tgId}`;
    const link = getOrCreateBrowserAccessLink(userRef);

    return reply.send({
      ok: true,
      url: `${webAppBaseUrl.replace(/\/$/, '')}/access/${encodeURIComponent(link.token)}`,
      expiresAt: link.record.expires_at,
      status: 'active',
    });
  });

  fastify.post('/browser-access/link/rotate', {
    preHandler: async (request, reply) => {
      const { createVerifyAuth } = await import('../../auth/verifyAuth.js');
      const verifyAuth = createVerifyAuth({ jwtSecret, cookieName, botToken });
      return verifyAuth(request, reply);
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userRef = `tg_${request.user.tgId}`;
    const link = rotateBrowserAccessLink(userRef);

    return reply.send({
      ok: true,
      url: `${webAppBaseUrl.replace(/\/$/, '')}/access/${encodeURIComponent(link.token)}`,
      expiresAt: link.record.expires_at,
      status: 'active',
    });
  });

  fastify.post('/browser-access/link/revoke', {
    preHandler: async (request, reply) => {
      const { createVerifyAuth } = await import('../../auth/verifyAuth.js');
      const verifyAuth = createVerifyAuth({ jwtSecret, cookieName, botToken });
      return verifyAuth(request, reply);
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    revokeActiveBrowserAccessLinks(`tg_${request.user.tgId}`);
    return reply.send({ ok: true });
  });

  fastify.post<{
    Body: { tgId: number; rotate?: boolean }
  }>('/browser-access/link/admin', async (request, reply) => {
    const apiKey = request.headers['x-admin-api-key'];
    if (!adminApiKey || apiKey !== adminApiKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const tgId = Number(request.body?.tgId);
    if (!Number.isFinite(tgId) || tgId <= 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'tgId is required',
      });
    }

    const userRef = `tg_${tgId}`;
    const link = request.body.rotate ? rotateBrowserAccessLink(userRef) : getOrCreateBrowserAccessLink(userRef);

    return reply.send({
      ok: true,
      url: `${webAppBaseUrl.replace(/\/$/, '')}/access/${encodeURIComponent(link.token)}`,
      expiresAt: link.record.expires_at,
      status: 'active',
    });
  });

  fastify.post<{ Body: { token: string } }>('/browser-access/consume', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const result = consumeBrowserAccessLink(request.body.token);

    if (result.status !== 'active' || !result.userRef) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: result.status,
      });
    }

    const tgId = Number(result.userRef.replace(/^tg_/, ''));
    if (!Number.isFinite(tgId) || tgId <= 0) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'invalid',
      });
    }

    const sessionToken = createToken({
      tgId,
      secret: jwtSecret,
      expiresInDays: 30,
    });

    return reply.send({
      ok: true,
      sessionToken,
      expiresAt: result.expiresAt,
      tgId,
    });
  });

  fastify.post<{
    Body: { tgId: number; username?: string; firstName?: string }
  }>('/ios-handoff', async (request, reply) => {
    const apiKey = request.headers['x-admin-api-key'];
    if (!adminApiKey || apiKey !== adminApiKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const tgId = Number(request.body?.tgId);
    if (!Number.isFinite(tgId) || tgId <= 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'tgId is required',
      });
    }

    const handoff = createIosHandoffToken({
      tgId,
      username: request.body.username,
      firstName: request.body.firstName,
    });

    return reply.send({
      ok: true,
      token: handoff.token,
      expiresAt: handoff.expiresAt,
      redirectUrl: `${webAppBaseUrl.replace(/\/$/, '')}/ios-auth-redirect/${encodeURIComponent(handoff.token)}`,
    });
  });

  fastify.post('/ios-handoff/telegram', {
    preHandler: async (request, reply) => {
      const { createVerifyAuth } = await import('../../auth/verifyAuth.js');
      const verifyAuth = createVerifyAuth({ jwtSecret, cookieName, botToken });
      return verifyAuth(request, reply);
    },
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const handoff = createIosHandoffToken({
      tgId: request.user.tgId,
      username: request.user.username,
      firstName: request.user.firstName,
    });

    return reply.send({
      ok: true,
      token: handoff.token,
      expiresAt: handoff.expiresAt,
      redirectUrl: `${webAppBaseUrl.replace(/\/$/, '')}/ios-auth-redirect/${encodeURIComponent(handoff.token)}`,
    });
  });

  /**
   * GET /v1/auth/me
   * Проверка текущей сессии и возврат данных пользователя с подпиской
   */
  const { createVerifyAuth } = await import('../../auth/verifyAuth.js');
  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: botToken, // Добавляем botToken для поддержки initData
  });
  const marzbanService = fastify.marzbanService;

  fastify.get(
    '/me',
    {
      preHandler: verifyAuth,
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Получаем данные пользователя из Marzban
      const status = await marzbanService.getUserStatus(request.user.tgId);
      const config = await marzbanService.getUserConfig(request.user.tgId);

      fastify.log.info({ tgId: request.user.tgId, status: status ? { status: status.status, expire: status.expire } : 'NOT_FOUND' }, '[AuthMe] Marzban data');

      const now = Math.floor(Date.now() / 1000);
      // Подписка активна если статус 'active' И (срок не установлен ИЛИ еще не вышел)
      const isActive = status &&
        status.status === 'active' &&
        (!status.expire || status.expire === 0 || status.expire > now);

      fastify.log.info({ tgId: request.user.tgId, isActive, now, expire: status?.expire }, '[AuthMe] Computed isActive');

      // Получаем фото профиля через Bot API
      let photoUrl: string | null = null;
      if (botToken) {
        try {
          photoUrl = await getUserPhotoUrl(request.user.tgId, botToken);
          fastify.log.info({ userId: request.user.tgId, hasPhoto: !!photoUrl }, '[auth/me] Photo URL fetched');
        } catch (error) {
          fastify.log.warn({ userId: request.user.tgId, error }, '[auth/me] Failed to fetch photo URL');
        }
      }

      // Возвращаем данные в формате, который ожидает VPN Website
      return reply.send({
        id: request.user.tgId,
        firstName: request.user.firstName || '',
        username: request.user.username || null, // Добавляем username из JWT токена
        photoUrl: photoUrl, // URL фотографии профиля
        subscription: {
          is_active: isActive,
          expires_at: status?.expire ? status.expire * 1000 : null, // Конвертируем в миллисекунды
          vless_key: config || undefined,
        },
      });
    }
  );
}
