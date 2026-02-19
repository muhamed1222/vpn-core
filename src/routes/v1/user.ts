import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getDevices, getDeviceById, revokeDevice } from '../../storage/devicesRepo.js';
import { MarzbanService } from '../../integrations/marzban/service.js';

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

  // GET /v1/user/config
  fastify.get('/config', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    const config = await marzbanService.getUserConfig(targetTgId);

    if (!config) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'У вас еще нет активной подписки.'
      });
    }

    return reply.send({ ok: true, config });
  });

  // GET /v1/user/status
  fastify.get('/status', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) {
      fastify.log.warn({ user: request.user }, '[UserStatus] Missing targetTgId');
      return reply.status(400).send({ error: 'Missing Telegram ID' });
    }

    const status = await marzbanService.getUserStatus(targetTgId);

    const now = Math.floor(Date.now() / 1000);
    const isActive = status &&
      status.status === 'active' &&
      (!status.expire || status.expire === 0 || status.expire > now);

    return reply.send({
      ok: !!isActive,
      status: isActive ? 'active' : (status?.status || 'disabled'),
      expiresAt: status?.expire ? status.expire * 1000 : null,
      usedTraffic: (status && typeof status.used_traffic === 'number') ? status.used_traffic : 0,
      dataLimit: (status && typeof status.data_limit === 'number') ? status.data_limit : 0,
    });
  });

  // POST /v1/user/regenerate
  fastify.post('/regenerate', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId || (request.body as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const config = await marzbanService.regenerateUser(targetTgId);

    if (config) {
      const { getOrdersByUser, markPaidWithKey } = await import('../../storage/ordersRepo.js');
      const userRef = `tg_${targetTgId}`;
      const orders = getOrdersByUser(userRef);
      const lastPaidOrder = orders.find(o => o.status === 'paid');

      if (lastPaidOrder) {
        markPaidWithKey({ orderId: lastPaidOrder.order_id, key: config });
      }
    }

    return reply.send({ ok: true, config });
  });

  // POST /v1/user/renew
  fastify.post<{ Body: { tgId: number; days: number } }>('/renew', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    if (!request.user.isAdmin) return reply.status(403).send({ error: 'Forbidden' });
    const { tgId, days } = request.body;
    const success = await marzbanService.renewUser(tgId, days);
    return reply.send({ ok: success });
  });

  // GET /v1/user/billing
  fastify.get('/billing', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

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
        end: expire ? expire * 1000 : null,
      },
    });
  });

  // GET /v1/user/devices
  fastify.get('/devices', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    try {
      const userRef = `tg_${targetTgId}`;
      // Use getDevices (new method)
      const dbDevices: any[] = getDevices(userRef);

      if (dbDevices.length > 0) {
        const now = Date.now();
        const FIVE_MINUTES = 5 * 60 * 1000;

        const devices = dbDevices.map(d => ({
          id: d.id, // now using PK
          name: d.device_name,
          platform: d.platform,
          app: d.device_name.split(' ')[0],
          ipAddress: d.ip,
          country: d.country,
          lastActive: d.last_seen,
          firstSeen: d.created_at,
          isRevoked: !!d.is_revoked,
          status: !!d.is_revoked ? 'revoked' : (now - new Date(d.last_seen).getTime() < FIVE_MINUTES) ? 'online' : 'offline',
        }));

        const marzbanInfo = await marzbanService.getDeviceInfo(targetTgId).catch(() => null);

        const response = {
          devices,
          nodes: marzbanInfo?.nodes || [],
          lastOnline: marzbanInfo?.lastOnline || dbDevices[0]?.last_seen || null,
          userAgent: marzbanInfo?.userAgent || '',
          subUpdatedAt: marzbanInfo?.subUpdatedAt || null,
        };

        return reply.send(response);
      }

      const deviceInfo = await marzbanService.getDeviceInfo(targetTgId);
      if (!deviceInfo) return reply.send({ devices: [], nodes: [], lastOnline: null, userAgent: '', subUpdatedAt: null });
      return reply.send(deviceInfo);
    } catch (error: any) {
      fastify.log.error({ targetTgId, error: error.message }, '[UserDevices] Failed to get device info');
      return reply.send({ devices: [], nodes: [], lastOnline: null, userAgent: '', subUpdatedAt: null });
    }
  });

  // DELETE /v1/user/devices/:id
  fastify.delete<{ Params: { id: string } }>('/devices/:id', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const { id } = request.params;
    const deviceId = parseInt(id, 10);

    if (isNaN(deviceId)) return reply.status(400).send({ error: 'Invalid device ID' });

    const device = getDeviceById(deviceId);
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    // Check ownership
    const userRef = `tg_${request.user.tgId}`;
    if (device.vpn_key_id !== userRef && !request.user.isAdmin) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    revokeDevice(deviceId, userRef);
    return reply.send({ ok: true });
  });

  // GET /v1/user/referrals
  fastify.get('/referrals', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    const botDbPath = process.env.BOT_DATABASE_PATH;
    if (!botDbPath) {
      return reply.send({
        totalCount: 0, trialCount: 0, premiumCount: 0, referralCode: `REF${targetTgId}`,
      });
    }

    const { getReferralStats } = await import('../../storage/referralsRepo.js');
    const stats = getReferralStats(targetTgId, botDbPath);
    return reply.send(stats);
  });
}
