import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getActiveContest } from '../../storage/contestRepo.js';

export async function contestRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const adminApiKey = process.env.ADMIN_API_KEY || '';

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken,
    adminApiKey,
  });

  /**
   * GET /v1/contest/active
   * Получить активный конкурс
   */
  fastify.get('/active', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const botDbPath = process.env.BOT_DATABASE_PATH;
    if (!botDbPath) {
      fastify.log.warn('[Contest] BOT_DATABASE_PATH not configured');
      return reply.status(404).send({ 
        error: 'Not Found',
        message: 'Contest system not configured' 
      });
    }

    try {
      const contest = getActiveContest(botDbPath);
      
      if (!contest) {
        fastify.log.warn({ botDbPath }, '[Contest] No active contest found in database');
        return reply.status(404).send({ 
          error: 'Not Found',
          message: 'No active contest found' 
        });
      }

      fastify.log.debug({ contestId: contest.id }, '[Contest] Active contest found');
      return reply.send({ contest });
    } catch (error) {
      fastify.log.error({ err: error }, '[Contest] Error fetching active contest');
      return reply.status(500).send({ 
        error: 'Internal Server Error',
        message: 'Failed to fetch contest data' 
      });
    }
  });
}
