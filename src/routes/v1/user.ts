import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';

export async function userRoutes(fastify: FastifyInstance) {
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const marzbanService = fastify.marzbanService;
  const adminApiKey: string = fastify.adminApiKey;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken, // Добавляем botToken для поддержки initData
    adminApiKey,
  });

  /**
   * GET /v1/user/config
   * Возвращает стабильный VPN-ключ из БД или Marzban.
   */
  fastify.get('/config', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    // Admin mode: allow reading config for an arbitrary tgId (service-to-service).
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    // Теперь вся логика стабильности (БД + Marzban) внутри getUserConfig
    const config = await marzbanService.getUserConfig(targetTgId);

    if (!config) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'У вас еще нет активной подписки.'
      });
    }

    return reply.send({ ok: true, config });
  });

  /**
   * GET /v1/user/status
   */
  fastify.get('/status', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) {
      fastify.log.warn({ user: request.user }, '[UserStatus] Missing targetTgId');
      return reply.status(400).send({ error: 'Missing Telegram ID' });
    }

    fastify.log.info({ targetTgId, requester: request.user.tgId }, '[UserStatus] Querying status from Marzban');

    const status = await marzbanService.getUserStatus(targetTgId);
    fastify.log.info({ targetTgId, status: status ? { username: status.username, status: status.status, expire: status.expire } : 'NOT_FOUND' }, '[UserStatus] Marzban returned data');

    const now = Math.floor(Date.now() / 1000);
    // Подписка активна если статус 'active' И (срок не установлен ИЛИ еще не вышел)
    const isActive = status &&
      status.status === 'active' &&
      (!status.expire || status.expire === 0 || status.expire > now);

    fastify.log.info({ targetTgId, isActive, now, expire: status?.expire }, '[UserStatus] Computed isActive');

    return reply.send({
      ok: !!isActive,
      status: isActive ? 'active' : (status?.status || 'disabled'),
      expiresAt: status?.expire ? status.expire * 1000 : null, // Конвертируем в миллисекунды
      usedTraffic: (status && typeof status.used_traffic === 'number') ? status.used_traffic : 0,
      dataLimit: (status && typeof status.data_limit === 'number') ? status.data_limit : 0,
    });
  });

  /**
   * POST /v1/user/regenerate
   */
  fastify.post('/regenerate', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    // 1. Генерируем новый (Marzban + сохранение в vpn_keys БД)
    const config = await marzbanService.regenerateUser(request.user.tgId);

    // 2. Также обновляем "замороженный" ключ в последнем оплаченном заказе (для совместимости)
    if (config) {
      const { getOrdersByUser, markPaidWithKey } = await import('../../storage/ordersRepo.js');
      const userRef = `tg_${request.user.tgId}`;
      const orders = getOrdersByUser(userRef);
      const lastPaidOrder = orders.find(o => o.status === 'paid');

      if (lastPaidOrder) {
        markPaidWithKey({ orderId: lastPaidOrder.order_id, key: config });
      }
    }

    return reply.send({ ok: true, config });
  });

  /**
   * POST /v1/user/renew (Для админки бота и акций)
   */
  fastify.post<{ Body: { tgId: number; days: number } }>('/renew', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    if (!request.user.isAdmin) return reply.status(403).send({ error: 'Forbidden' });
    const { tgId, days } = request.body;
    const success = await marzbanService.renewUser(tgId, days);
    return reply.send({ ok: success });
  });

  /**
   * GET /v1/user/billing
   * Статистика использования трафика
   */
  fastify.get('/billing', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) {
      return reply.status(400).send({ error: 'Missing Telegram ID' });
    }

    const status = await marzbanService.getUserStatus(targetTgId);

    if (!status) {
      return reply.send({
        usedBytes: 0,
        limitBytes: null,
        averagePerDayBytes: 0,
        planId: null,
        planName: null,
        period: { start: null, end: null },
      });
    }

    const usedBytes = status.used_traffic || 0;
    const dataLimit = status.data_limit || null;
    const expire = status.expire || null;
    const now = Math.floor(Date.now() / 1000);

    let averagePerDayBytes = 0;
    if (expire && expire > now) {
      const daysActive = Math.ceil((expire - now) / 86400);
      if (daysActive > 0) {
        averagePerDayBytes = Math.floor(usedBytes / daysActive);
      }
    }

    return reply.send({
      usedBytes,
      limitBytes: dataLimit,
      averagePerDayBytes,
      planId: null,
      planName: null,
      period: {
        start: null,
        end: expire ? expire * 1000 : null, // Конвертируем в миллисекунды
      },
    });
  });

  /**
   * GET /v1/user/referrals
   * Статистика реферальной программы
   */
  fastify.get('/referrals', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) {
      return reply.status(400).send({ error: 'Missing Telegram ID' });
    }

    const botDbPath = process.env.BOT_DATABASE_PATH;
    if (!botDbPath) {
      return reply.send({
        totalCount: 0,
        trialCount: 0,
        premiumCount: 0,
        referralCode: `REF${targetTgId}`,
      });
    }

    const { getReferralStats } = await import('../../storage/referralsRepo.js');
    const stats = getReferralStats(targetTgId, botDbPath);

    return reply.send(stats);
  });
}
