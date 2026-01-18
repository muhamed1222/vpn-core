import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { 
  getReferralSummary, 
  getReferralFriends, 
  getTicketHistory 
} from '../../storage/contestRepo.js';

export async function referralRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken,
  });

  /**
   * GET /v1/referral/summary
   * Получить сводку по реферальной программе
   * Query params: contest_id
   */
  fastify.get<{ Querystring: { contest_id: string } }>(
    '/summary',
    { preHandler: verifyAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { contest_id } = request.query;
      if (!contest_id) {
        return reply.status(400).send({ 
          error: 'Bad Request',
          message: 'Missing contest_id parameter' 
        });
      }

      const botDbPath = process.env.BOT_DATABASE_PATH;
      if (!botDbPath) {
        return reply.status(404).send({ 
          error: 'Not Found',
          message: 'Referral system not configured' 
        });
      }

      const summary = getReferralSummary(request.user.tgId, contest_id, botDbPath);
      
      if (!summary) {
        return reply.status(404).send({ 
          error: 'Not Found',
          message: 'Contest or summary not found' 
        });
      }

      return reply.send({ summary });
    }
  );

  /**
   * GET /v1/referral/friends
   * Получить список приглашенных друзей
   * Query params: contest_id, limit (optional, default 50)
   */
  fastify.get<{ Querystring: { contest_id: string; limit?: string } }>(
    '/friends',
    { preHandler: verifyAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { contest_id, limit } = request.query;
      if (!contest_id) {
        return reply.status(400).send({ 
          error: 'Bad Request',
          message: 'Missing contest_id parameter' 
        });
      }

      const botDbPath = process.env.BOT_DATABASE_PATH;
      if (!botDbPath) {
        return reply.status(404).send({ 
          error: 'Not Found',
          message: 'Referral system not configured' 
        });
      }

      const limitNum = limit ? parseInt(limit, 10) : 50;
      const friends = getReferralFriends(
        request.user.tgId,
        contest_id,
        limitNum,
        botDbPath
      );

      return reply.send({ friends });
    }
  );

  /**
   * GET /v1/referral/tickets
   * Получить историю билетов
   * Query params: contest_id, limit (optional, default 20)
   */
  fastify.get<{ Querystring: { contest_id: string; limit?: string } }>(
    '/tickets',
    { preHandler: verifyAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { contest_id, limit } = request.query;
      if (!contest_id) {
        return reply.status(400).send({ 
          error: 'Bad Request',
          message: 'Missing contest_id parameter' 
        });
      }

      const botDbPath = process.env.BOT_DATABASE_PATH;
      if (!botDbPath) {
        return reply.status(404).send({ 
          error: 'Not Found',
          message: 'Referral system not configured' 
        });
      }

      const limitNum = limit ? parseInt(limit, 10) : 20;
      const tickets = getTicketHistory(
        request.user.tgId,
        contest_id,
        limitNum,
        botDbPath
      );

      return reply.send({ tickets });
    }
  );
}
