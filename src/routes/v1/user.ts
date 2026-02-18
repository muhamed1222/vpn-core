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
    botToken: fastify.telegramBotToken,
    adminApiKey,
  });

  fastify.get('/config', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;
    const config = await marzbanService.getUserConfig(targetTgId);
    if (!config) {
      return reply.status(404).send({ error: 'Not Found', message: 'У вас еще нет активной подписки.' });
    }
    return reply.send({ ok: true, config });
  });

  fastify.get('/status', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;
    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const status = await marzbanService.getUserStatus(targetTgId);
    const now = Math.floor(Date.now() / 1000);
    const isActive = status && status.status === 'active' && (!status.expire || status.expire === 0 || status.expire > now);

    return reply.send({
      ok: !!isActive,
      status: isActive ? 'active' : (status?.status || 'disabled'),
      expiresAt: status?.expire ? status.expire * 1000 : null,
      usedTraffic: (status && typeof status.used_traffic === 'number') ? status.used_traffic : 0,
      dataLimit: (status && typeof status.data_limit === 'number') ? status.data_limit : 0,
    });
  });

  fastify.post('/regenerate', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const config = await marzbanService.regenerateUser(request.user.tgId);
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

  fastify.get('/billing', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;
    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const status = await marzbanService.getUserStatus(targetTgId);
    if (!status) {
      return reply.send({ usedBytes: 0, limitBytes: null, averagePerDayBytes: 0, planId: null, planName: null, period: { start: null, end: null } });
    }

    const usedBytes = status.used_traffic || 0;
    const dataLimit = status.data_limit || null;
    const expire = status.expire || null;
    const now = Math.floor(Date.now() / 1000);

    let averagePerDayBytes = 0;
    if (expire && expire > now) {
      const daysActive = Math.ceil((expire - now) / 86400);
      if (daysActive > 0) averagePerDayBytes = Math.floor(usedBytes / daysActive);
    }

    return reply.send({ usedBytes, limitBytes: dataLimit, averagePerDayBytes, planId: null, planName: null, period: { start: null, end: expire ? expire * 1000 : null } });
  });

  fastify.get('/referrals', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;
    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const botDbPath = process.env.BOT_DATABASE_PATH;
    if (!botDbPath) {
      return reply.send({ totalCount: 0, trialCount: 0, premiumCount: 0, referralCode: `REF${targetTgId}` });
    }
    const { getReferralStats } = await import('../../storage/referralsRepo.js');
    const stats = getReferralStats(targetTgId, botDbPath);
    return reply.send(stats);
  });

  fastify.get('/devices', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;
    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const devices = await marzbanService.getUserDevices(targetTgId);
    return reply.send({ ok: true, devices });
  });
}
