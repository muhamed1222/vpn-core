import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getAllContestParticipants } from '../../storage/contestRepo.js';
import Database from 'better-sqlite3';
import { awardRetryScheduler } from '../../services/awardRetryScheduler.js';

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
function createVerifyAdmin(fastify: FastifyInstance) {
  return async function verifyAdmin(request: any, reply: any): Promise<void> {
    // Добавляем логирование для отладки (используем info вместо debug для видимости)
    fastify.log.info({
      hasUser: !!request.user,
      isAdmin: request.user?.isAdmin,
      tgId: request.user?.tgId,
      headers: Object.keys(request.headers).filter(k => k.toLowerCase().includes('admin') || k.toLowerCase().includes('x-'))
    }, '[Admin] verifyAdmin check');

    if (!request.user) {
      fastify.log.warn('[Admin] No user in request');
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    // Проверяем через isAdmin флаг (для Admin API Key)
    if (request.user.isAdmin) {
      fastify.log.info('[Admin] Access granted via isAdmin flag');
      return;
    }

    // Проверяем через Telegram ID
    if (isAdminUser(request.user.tgId)) {
      fastify.log.info({ tgId: request.user.tgId }, '[Admin] Access granted via Telegram ID');
      return;
    }

    fastify.log.warn({
      tgId: request.user.tgId,
      isAdmin: request.user.isAdmin
    }, '[Admin] Access denied');

    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin access required'
    });
  };
}

export async function adminRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken,
    adminApiKey: (fastify as any).adminApiKey || '',
  });

  const verifyAdmin = createVerifyAdmin(fastify);

  // Добавляем логирование при регистрации роутов
  const adminApiKey = (fastify as any).adminApiKey || '';
  fastify.log.info({
    hasAdminApiKey: !!adminApiKey,
    adminApiKeyLength: adminApiKey ? adminApiKey.length : 0,
    adminApiKeyPreview: adminApiKey ? `${adminApiKey.substring(0, 3)}...` : 'empty'
  }, '[Admin] Admin routes registered');

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
      fastify.log.info('[Admin] Handler called');
      const { contest_id } = request.query;
      fastify.log.info({ contest_id }, '[Admin] Contest ID from query');

      if (!contest_id) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing contest_id parameter'
        });
      }

      const botDbPath = process.env.BOT_DATABASE_PATH;
      fastify.log.info({ botDbPath, contest_id }, '[Admin] Processing participants request');

      if (!botDbPath) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Contest system not configured'
        });
      }

      try {
        // Для админ-панели проверяем конкурс напрямую по ID из БД (не через getActiveContest, 
        // так как он проверяет даты, а конкурс может еще не начаться)
        fastify.log.info('[Admin] Getting contest by ID from database');
        const db = new Database(process.env.DATABASE_PATH || './data/db.sqlite');
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

        const contestRow = db.prepare(`
          SELECT id, title, starts_at, ends_at, attribution_window_days, rules_version, is_active
          FROM bot_db.contests
          WHERE id = ? AND is_active = 1
        `).get(contest_id) as any;

        if (!contestRow) {
          db.close();
          fastify.log.warn({ requestedId: contest_id }, '[Admin] Contest not found or not active');
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Contest not found'
          });
        }

        const contest = {
          id: contestRow.id,
          title: contestRow.title,
          starts_at: contestRow.starts_at,
          ends_at: contestRow.ends_at,
          attribution_window_days: contestRow.attribution_window_days,
          rules_version: contestRow.rules_version,
          is_active: contestRow.is_active === 1
        };

        fastify.log.info({ contest: { id: contest.id, title: contest.title } }, '[Admin] Contest found');

        // Получаем билеты напрямую из ticket_ledger
        fastify.log.info('[Admin] Getting tickets from ticket_ledger');

        const ticketsRaw = db.prepare(`
          SELECT 
            referrer_id,
            referred_id,
            order_id,
            MAX(created_at) as created_at,
            SUM(delta) as total_delta
          FROM bot_db.ticket_ledger
          WHERE contest_id = ?
          GROUP BY referrer_id, referred_id, order_id
          HAVING SUM(delta) > 0
          ORDER BY MAX(created_at) DESC
        `).all(contest_id) as Array<{
          referrer_id: number;
          referred_id: number;
          order_id: string;
          created_at: string;
          total_delta: number;
        }>;

        db.close();

        const tickets: Array<any> = [];
        for (const t of ticketsRaw) {
          const count = t.total_delta;
          for (let i = 0; i < count; i++) {
            tickets.push({
              referrer_id: t.referrer_id,
              referred_id: t.referred_id,
              order_id: t.order_id,
              created_at: t.created_at
            });
          }
        }

        // Перемешиваем билеты (Fisher-Yates shuffle)
        for (let i = tickets.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const temp = tickets[i];
          tickets[i] = tickets[j];
          tickets[j] = temp;
        }

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

  /**
   * GET /v1/admin/award-retry-stats
   * Получить статистику очереди повторных попыток начисления билетов (админский endpoint)
   */
  fastify.get(
    '/award-retry-stats',
    {
      preHandler: [verifyAuth, verifyAdmin]
    },
    async (request, reply) => {
      try {
        const stats = awardRetryScheduler.getStats();
        fastify.log.info({ queueSize: stats.queueSize }, '[Admin] Award retry stats requested');
        return reply.send(stats);
      } catch (error) {
        fastify.log.error({ err: error }, '[Admin] Error fetching award retry stats');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch award retry stats'
        });
      }
    }
  );
}
