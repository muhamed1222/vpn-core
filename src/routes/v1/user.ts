import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';

export async function userRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const marzbanService = fastify.marzbanService;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
  });

  /**
   * GET /v1/user/config
   * Возвращает VPN-конфиг (ссылку на подписку) для текущего пользователя
   */
  fastify.get(
    '/config',
    {
      preHandler: verifyAuth,
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const tgId = request.user.tgId;
      
      try {
        const config = await marzbanService.getUserConfig(tgId);
        
        if (!config) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'VPN account not found. Please ensure you have an active subscription.',
          });
        }

        return reply.send({
          ok: true,
          config: config,
        });
      } catch (error: any) {
        fastify.log.error({ err: error, tgId }, 'Error getting config');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch VPN configuration',
        });
      }
    }
  );

  /**
   * GET /v1/user/status
   * Возвращает статус пользователя в Marzban
   */
  fastify.get(
    '/status',
    {
      preHandler: verifyAuth,
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const tgId = request.user.tgId;
      const status = await marzbanService.getUserStatus(tgId);

      return reply.send({
        ok: true,
        status: status ? status.status : 'not_found',
        expiresAt: status ? status.expire : null,
      });
    }
  );
}

