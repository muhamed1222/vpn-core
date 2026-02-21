import { FastifyInstance } from 'fastify';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getDevices, getDeviceById, revokeDevice } from '../../storage/devicesRepo.js';
import * as botRepo from '../../storage/botRepo.js';
import { getPrisma } from '../../storage/prisma.js';
import { MarzbanService } from '../../integrations/marzban/service.js';
import fs from 'fs';

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
      note: status?.note || '',
      marzbanUsername: status?.username || '',
      discount: await (async () => {
        const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
        if (fs.existsSync(botDbPath)) {
          try {
            const { getDatabase } = await import('../../storage/db.js');
            const db = getDatabase();
            db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
            const userRow = db.prepare(`
              SELECT discount_percent, discount_expires_at 
              FROM bot_db.users 
              WHERE id = ?
            `).get(targetTgId) as any;
            db.prepare('DETACH DATABASE bot_db').run();
            if (userRow && userRow.discount_percent && (!userRow.discount_expires_at || userRow.discount_expires_at > Date.now())) {
              return { percent: userRow.discount_percent, expiresAt: userRow.discount_expires_at };
            }
          } catch (e) {
            fastify.log.error(e, 'Failed to fetch discount for status');
          }
        }
        return null;
      })(),
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

    if (success) {
      // Уведомляем бота об успешном продлении (best effort, не ждем)
      const BOT_API_URL = process.env.BOT_API_URL || 'http://127.0.0.1:3000';
      const adminApiKey = process.env.ADMIN_API_KEY || '';

      // Сопоставляем дни с ID тарифа в боте
      let planId = `plan_${days}`;
      if (days > 25 && days < 35) planId = 'plan_30';
      else if (days > 80 && days < 100) planId = 'plan_90';
      else if (days > 170 && days < 190) planId = 'plan_180';
      else if (days > 350) planId = 'plan_365';

      import('axios').then(async (axiosLib) => {
        const axios = axiosLib.default || axiosLib;
        try {
          await axios.post(`${BOT_API_URL}/api/internal/activate-external-order`, {
            tgId,
            planId,
            amount: 0,
            orderId: `core_${Date.now()}_${tgId}`
          }, {
            headers: { 'x-admin-api-key': adminApiKey },
            timeout: 5000
          });
          fastify.log.info(`[NotifyBot] Sent activation notice to bot for user ${tgId}`);
        } catch (e: any) {
          fastify.log.error(`[NotifyBot] Failed to notify bot: ${e.message}`);
        }
      }).catch(e => {
        fastify.log.error(`[NotifyBot] Import axios failed: ${e.message}`);
      });
    }

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
      const dbDevices: any[] = getDevices(userRef);

      if (dbDevices.length > 0) {
        const now = Date.now();
        const FIVE_MINUTES = 5 * 60 * 1000;

        const devices = dbDevices.map(d => ({
          id: d.id,
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

  // GET /v1/user/autorenewal
  fastify.get('/autorenewal', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    let status = { enabled: false, canEnable: false };

    // 1. Пытаемся получить из Prisma (база для веб)
    try {
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({
        where: { vpnTgId: BigInt(targetTgId) },
        include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } }
      });

      const activeSub = user?.subscriptions[0];
      if (activeSub) {
        status.enabled = activeSub.autoRenewEnabled;
        status.canEnable = !!activeSub.paymentMethodId;
      }
    } catch (e) {
      // Игнорируем ошибку подключения к Prisma, идем в SQLite
    }

    // 2. Если в Prisma нет или она недоступна, проверяем базу бота
    if (!status.canEnable) {
      const botStatus = botRepo.getBotAutoRenewal(targetTgId);
      if (botStatus) {
        status.enabled = botStatus.enabled;
        status.canEnable = !!botStatus.paymentMethodId;
      }
    }

    return reply.send(status);
  });

  // POST /v1/user/autorenewal
  fastify.post('/autorenewal', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const { enabled } = request.body as { enabled: boolean };
    const tgIdParamRaw = (request.query as any)?.tgId || (request.body as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const targetTgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!targetTgId) return reply.status(400).send({ error: 'Missing Telegram ID' });

    let success = false;
    let finalEnabled = enabled;

    // 1. Проверяем наличие карты в обеих базах
    const botStatus = botRepo.getBotAutoRenewal(targetTgId);
    let hasCard = !!botStatus?.paymentMethodId;

    // 2. Пытаемся обновить в Prisma
    try {
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({
        where: { vpnTgId: BigInt(targetTgId) },
        include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } }
      });

      const activeSub = user?.subscriptions[0];
      if (activeSub) {
        if (activeSub.paymentMethodId) hasCard = true;

        if (!(enabled && !hasCard)) {
          const updated = await prisma.subscription.update({
            where: { id: activeSub.id },
            data: { autoRenewEnabled: enabled }
          });
          finalEnabled = updated.autoRenewEnabled;
          success = true;
        }
      }
    } catch (e) {
      // Пропускаем Prisma если она упала
    }

    // 3. Также обновляем в базе бота
    if (enabled && !hasCard) {
      return reply.status(400).send({ error: 'No saved payment method' });
    }

    const botUpdated = botRepo.updateBotAutoRenewal(targetTgId, enabled);
    if (botUpdated) success = true;

    if (!success) {
      return reply.status(404).send({ error: 'Subscription not found' });
    }

    return reply.send({ enabled: finalEnabled });
  });
}
