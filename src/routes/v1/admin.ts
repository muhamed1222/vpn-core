import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getAllContestParticipants, getAllContestTickets } from '../../storage/contestRepo.js';
import { getActiveContest } from '../../storage/contestRepo.js';

/**
 * Проверка, является ли пользователь админом
 */
function isAdminUser(tgId?: number): boolean {
  if (!tgId) return false;
  
  const adminIdsRaw = process.env.ADMIN_ID || '';
  if (!adminIdsRaw) return false;
  
  const adminIds = adminIdsRaw
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => Number.isFinite(id) && id > 0);
  
  return adminIds.includes(tgId);
}

/**
 * Middleware для проверки прав админа
 */
function verifyAdmin(request: any, reply: any): void {
  if (!request.user) {
    return reply.status(401).send({ 
      error: 'Unauthorized',
      message: 'Authentication required' 
    });
  }

  // Проверяем через isAdmin флаг (для Admin API Key)
  if (request.user.isAdmin) {
    return;
  }

  // Проверяем через Telegram ID
  if (isAdminUser(request.user.tgId)) {
    return;
  }

  return reply.status(403).send({ 
    error: 'Forbidden',
    message: 'Admin access required' 
  });
}

export async function adminRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken,
  });

  /**
   * GET /v1/admin/contest/participants?contest_id={id}
   * Получить список всех участников конкурса (админский endpoint)
   */
  fastify.get<{ Querystring: { contest_id: string } }>(
    '/contest/participants',
    { 
      preHandler: [verifyAuth, verifyAdmin]
    },
    async (request, reply) => {
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
          message: 'Contest system not configured' 
        });
      }

      try {
        // Проверяем, существует ли конкурс
        const contest = getActiveContest(botDbPath);
        if (!contest || contest.id !== contest_id) {
          return reply.status(404).send({ 
            error: 'Not Found',
            message: 'Contest not found' 
          });
        }

        // Получаем развернутые билеты для розыгрыша
        const tickets = getAllContestTickets(contest_id, botDbPath);
        
        fastify.log.info({ 
          contestId: contest_id, 
          ticketsCount: tickets.length 
        }, '[Admin] Fetched contest tickets');

        return reply.send({ tickets });
      } catch (error) {
        fastify.log.error({ err: error }, '[Admin] Error fetching participants');
        return reply.status(500).send({ 
          error: 'Internal Server Error',
          message: 'Failed to fetch participants' 
        });
      }
    }
  );
}
