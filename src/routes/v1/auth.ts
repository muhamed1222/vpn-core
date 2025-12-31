import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyTelegramInitData } from '../../auth/telegram.js';
import { createToken } from '../../auth/jwt.js';

const telegramAuthSchema = z.object({
  initData: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance) {
  const botToken: string = fastify.telegramBotToken;
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const cookieDomain: string = fastify.authCookieDomain || '.outlivion.space';

  // POST /v1/auth/telegram
  fastify.post<{ Body: { initData: string } }>(
    '/telegram',
    {
      schema: {
        body: telegramAuthSchema,
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

      // Создаем JWT
      const token = createToken({
        tgId: user.id,
        username: user.username,
        firstName: user.first_name,
        secret: jwtSecret,
      });

      // Устанавливаем cookie
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        domain: cookieDomain,
        maxAge: 60 * 60 * 24 * 7, // 7 дней
      });

      return reply.send({
        ok: true,
        user: {
          tgId: user.id,
          username: user.username,
          firstName: user.first_name,
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
      const { verifyToken } = await import('../../auth/jwt.js');

      // Проверяем токен
      const payload = verifyToken({ token, secret: jwtSecret });

      if (!payload || !payload.tgId) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired login token',
        });
      }

      // Устанавливаем сессионную cookie (точно так же, как в /telegram)
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        domain: cookieDomain,
        maxAge: 60 * 60 * 24 * 7,
      });

      return reply.send({
        ok: true,
        user: {
          tgId: payload.tgId,
          username: payload.username,
          firstName: payload.firstName,
        },
      });
    }
  );
}


