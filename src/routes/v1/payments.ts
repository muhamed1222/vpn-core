import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import axios from 'axios';
import fs from 'fs';
import * as ordersRepo from '../../storage/ordersRepo.js';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { isYooKassaIP } from '../../config/yookassa.js';
import { awardTicketsForPayment } from '../../storage/contestUtils.js';
import { awardRetryScheduler } from '../../services/awardRetryScheduler.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const yookassaWebhookSchema = z.object({
  type: z.literal('notification'),
  event: z.string(),
  object: z.object({
    id: z.string(),
    status: z.string(),
    paid: z.boolean(),
    metadata: z.object({
      orderId: z.string(),
      autoRenew: z.string().optional()
    }).optional(),
    payment_method: z.object({
      id: z.string(),
      saved: z.boolean(),
      type: z.string()
    }).optional()
  }),
});

export async function paymentsRoutes(fastify: FastifyInstance) {
  const marzbanService = fastify.marzbanService;
  const botToken = fastify.telegramBotToken;
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const webhookIpCheck = fastify.yookassaWebhookIPCheck;

  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: botToken, // Добавляем botToken для поддержки initData
    adminApiKey: fastify.adminApiKey,
  });

  fastify.post<{ Body: unknown }>(
    '/webhook',
    async (request, reply) => {
      // 1. Проверка IP (если включено в конфиге)
      if (webhookIpCheck) {
        const clientIp = request.ip;
        if (!isYooKassaIP(clientIp)) {
          fastify.log.warn({ ip: clientIp }, '[Webhook] Rejected request from non-YooKassa IP');
          return reply.status(403).send({ error: 'Forbidden' });
        }
      }

      const validationResult = yookassaWebhookSchema.safeParse(request.body);
      if (!validationResult.success) {
        return reply.status(200).send({ ok: true });
      }

      const { event, object } = validationResult.data;
      if (event !== 'payment.succeeded' || object.status !== 'succeeded') {
        return reply.status(200).send({ ok: true });
      }

      const orderId = object.metadata?.orderId;
      if (!orderId) return reply.status(200).send({ ok: true });

      const orderRow = ordersRepo.getOrder(orderId);
      if (!orderRow) {
        fastify.log.warn({ orderId }, '[Webhook] Order not found in Core DB. Forwarding to Bot...');

        try {
          // Пытаемся переслать вебхук в бота (предполагаем порт 3000)
          // Бот обрабатывает вебхук по пути /webhook/payment/yukassa
          await axios.post('http://127.0.0.1:3000/webhook/payment/yukassa', request.body);
          fastify.log.info({ orderId }, '[Webhook] Forwarded to Bot successfully');
        } catch (forwardErr: any) {
          fastify.log.error({ orderId, err: forwardErr.message }, '[Webhook] Failed to forward to Bot');
        }

        return reply.status(200).send({ ok: true });
      }

      fastify.log.info({
        orderId,
        status: orderRow.status,
        keyType: typeof orderRow.key,
        keyValue: orderRow.key ? orderRow.key.substring(0, 50) : 'null/empty',
        keyLength: orderRow.key ? orderRow.key.length : 0
      }, '[Webhook] Order found, checking status');

      // Если ордер уже paid И ключ есть - пропускаем
      const hasValidKey = orderRow.key && typeof orderRow.key === 'string' && orderRow.key.trim() !== '';
      if (orderRow.status === 'paid' && hasValidKey) {
        fastify.log.info({ orderId, hasKey: true }, '[Webhook] Order already processed with key');
        return reply.status(200).send({ ok: true });
      }

      // Если ордер paid, но ключа нет - активируем
      if (orderRow.status === 'paid' && !hasValidKey) {
        fastify.log.warn({ orderId, status: orderRow.status, hasKey: false }, '[Webhook] Order is paid but has no key, activating...');
      }

      const tgIdStr = orderRow.user_ref?.replace('tg_', '');
      const tgId = tgIdStr ? parseInt(tgIdStr, 10) : null;

      if (tgId && !isNaN(tgId)) {
        try {
          const planId = orderRow.plan_id;
          let days = 30;
          if (planId === 'plan_7') days = 7;
          else if (planId === 'plan_30') days = 30;
          else if (planId === 'plan_90') days = 90;
          else if (planId === 'plan_180') days = 180;
          else if (planId === 'plan_365') days = 365;

          // Добавляем бонусные дни из промокода
          const totalDays = days + (orderRow.bonus_days || 0);

          // ВЫЗЫВАЕМ НОВУЮ УНИВЕРСАЛЬНУЮ ФУНКЦИЮ
          // Она создаст юзера, если его нет, или продлит существующего
          const vlessKey = await marzbanService.activateUser(tgId, totalDays);

          if (!vlessKey) {
            fastify.log.error({ tgId, orderId }, '[Webhook] activateUser returned empty key');
            throw new Error('Failed to get VPN key from Marzban');
          }

          // Обновляем статус заказа и сохраняем ключ
          const saved = ordersRepo.markPaidWithKey({
            orderId,
            key: vlessKey
          });

          if (!saved) {
            fastify.log.error({ tgId, orderId, keyLength: vlessKey.length }, '[Webhook] Failed to save key to order');
          } else {
            fastify.log.info({ tgId, orderId, keyLength: vlessKey.length }, '[Webhook] Key saved to order');
          }

          // Попытка сохранить токен для рекуррентных платежей (Фаза 2 Автопродление)
          if (object.metadata?.autoRenew === 'true' && object.payment_method?.saved && object.payment_method?.id) {
            fastify.log.info({ tgId, paymentMethodId: object.payment_method.id }, '[Webhook] Saving recurring payment method to Prisma');
            try {
              // Ищем пользователя по tgId
              const prismaUser = await prisma.user.findUnique({
                where: { vpnTgId: BigInt(tgId) }
              });

              if (prismaUser) {
                // Создаем или обновляем подписку для этого пользователя с привязанной картой
                const endDate = new Date(Date.now() + (totalDays * 86400 * 1000));

                // Ищем активную подписку для этого плана, чтобы обновить, или создаем новую
                const existingSub = await prisma.subscription.findFirst({
                  where: { userId: prismaUser.id, productId: planId },
                  orderBy: { createdAt: 'desc' }
                });

                if (existingSub) {
                  await prisma.subscription.update({
                    where: { id: existingSub.id },
                    data: {
                      paymentMethodId: object.payment_method.id,
                      autoRenewEnabled: true,
                      currentPeriodEnd: endDate,
                      status: 'ACTIVE'
                    }
                  });
                } else {
                  await prisma.subscription.create({
                    data: {
                      userId: prismaUser.id,
                      productId: planId,
                      status: 'ACTIVE',
                      currentPeriodStart: new Date(),
                      currentPeriodEnd: endDate,
                      paymentMethodId: object.payment_method.id,
                      autoRenewEnabled: true
                    }
                  });
                }
                fastify.log.info({ tgId }, '[Webhook] Prisma updated with saved payment method');
              } else {
                fastify.log.warn({ tgId }, '[Webhook] User not found in Prisma, skipping payment method save');
              }
            } catch (prismaErr: any) {
              fastify.log.error({ err: prismaErr.message }, '[Webhook] Failed to save payment method to Prisma');
            }
          }

          // Начисляем билеты конкурса (покупателю и рефереру, если применимо)
          // ВАЖНО: Изолируем ошибки начисления - они не должны прерывать основной поток обработки платежа
          const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
          if (fs.existsSync(botDbPath)) {
            try {
              // Преобразуем created_at в ISO string
              // orderRow.created_at может быть ISO string или нужно взять из базы бота
              let orderCreatedAt = orderRow.created_at || new Date().toISOString();

              // Если created_at не в ISO формате, попробуем получить из базы бота
              if (botDbPath && fs.existsSync(botDbPath)) {
                try {
                  const { getDatabase } = await import('../../storage/db.js');
                  const db = getDatabase();
                  try {
                    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
                    const botOrder = db.prepare(`
                      SELECT created_at
                      FROM bot_db.orders
                      WHERE id = ?
                      LIMIT 1
                    `).get(orderId) as { created_at: number | string } | undefined;

                    if (botOrder) {
                      // created_at в базе бота - это timestamp в миллисекундах
                      if (typeof botOrder.created_at === 'number') {
                        orderCreatedAt = new Date(botOrder.created_at).toISOString();
                      } else if (typeof botOrder.created_at === 'string') {
                        const num = Number(botOrder.created_at);
                        orderCreatedAt = !isNaN(num) ? new Date(num).toISOString() : botOrder.created_at;
                      }
                    }
                    db.prepare('DETACH DATABASE bot_db').run();
                  } catch (attachError) {
                    // Игнорируем ошибку - используем orderRow.created_at
                  }
                } catch (e) {
                  // Игнорируем - используем orderRow.created_at
                }
              }

              // АКТИВНОЕ НАЧИСЛЕНИЕ БИЛЕТОВ
              // Используем try-catch для изоляции ошибок начисления от основного потока
              try {
                const ticketsAwarded = await awardTicketsForPayment(
                  botDbPath,
                  tgId,
                  orderId,
                  planId,
                  orderCreatedAt
                );

                if (ticketsAwarded) {
                  fastify.log.info({
                    tgId,
                    orderId,
                    planId
                  }, '[Webhook] ✅ Tickets awarded successfully');
                } else {
                  fastify.log.debug({
                    tgId,
                    orderId
                  }, '[Webhook] No tickets awarded (no referrer or outside contest period)');
                }
              } catch (ticketError: any) {
                // НЕ прерываем основной поток - оплата уже обработана
                fastify.log.error({
                  err: ticketError?.message,
                  stack: ticketError?.stack,
                  tgId,
                  orderId
                }, '[Webhook] ❌ Failed to award tickets (non-critical)');

                // ДОБАВЛЯЕМ В ОЧЕРЕДЬ ПОВТОРНЫХ ПОПЫТОК
                awardRetryScheduler.addToRetryQueue(
                  tgId,
                  orderId,
                  planId,
                  orderCreatedAt,
                  ticketError?.message
                );
              }
            } catch (ticketError: any) {
              // Общая ошибка при работе с базой бота или начислением
              fastify.log.error({
                err: ticketError?.message,
                stack: ticketError?.stack,
                tgId,
                orderId
              }, '[Webhook] ❌ Error in ticket awarding flow (non-critical)');

              // Пытаемся добавить в очередь, если можем извлечь данные
              try {
                const orderCreatedAt = orderRow.created_at || new Date().toISOString();
                awardRetryScheduler.addToRetryQueue(
                  tgId,
                  orderId,
                  planId,
                  orderCreatedAt,
                  ticketError?.message
                );
              } catch (retryError) {
                // Если не удалось добавить в очередь - просто логируем
                fastify.log.warn({ err: retryError }, '[Webhook] Failed to add to retry queue');
              }
            }
          }

          // Отправляем уведомление пользователю
          if (botToken) {
            const expireDate = new Date(Date.now() + (days * 86400 * 1000)).toLocaleDateString('ru-RU');
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              chat_id: tgId,
              text: `✅ <b>Оплата получена! Ваша подписка активирована.</b>\n\n` +
                `🟢 Статус: <b>Активна</b>\n` +
                `🕓 Действует до: <b>${expireDate}</b>\n\n` +
                `🔗 <b>Ваш ключ:</b>\n<code>${vlessKey}</code>\n\n` +
                `Используйте кнопки в боте для управления подключением.`,
              parse_mode: 'HTML'
            }).catch(err => {
              fastify.log.error({ err: err.message, tgId }, 'Failed to send TG success message');
            });
          }

          fastify.log.info({ orderId, tgId }, '[Webhook] Successfully activated user and sent notification');

        } catch (e: any) {
          fastify.log.error({ err: e.message, tgId, orderId }, '[Webhook] CRITICAL ACTIVATION ERROR');

          // Уведомляем админа о сбое
          if (botToken) {
            // Получаем первый ADMIN_ID из переменной окружения
            const adminIdsRaw = process.env.ADMIN_ID || '';
            const adminIds = adminIdsRaw
              .split(',')
              .map(id => parseInt(id.trim(), 10))
              .filter(id => Number.isFinite(id) && id > 0);
            const adminChatId = adminIds.length > 0 ? adminIds[0] : null;

            if (adminChatId) {
              await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: adminChatId,
                text: `🚨 <b>ОШИБКА СОЗДАНИЯ КЛЮЧА</b>\nЮзер: ${tgId}\nОшибка: ${e.message}\n\nСрочно проверьте панель Marzban!`
              }).catch(() => { });
            }
          }
        }
      }

      return reply.status(200).send({ ok: true });
    }
  );

  /**
   * GET /v1/payments/history
   * История платежей пользователя
   * Читает заказы из обеих баз: API и бота
   */
  fastify.get('/history', { preHandler: verifyAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const tgIdParamRaw = (request.query as any)?.tgId;
    const tgIdParam = tgIdParamRaw ? Number(tgIdParamRaw) : null;
    const tgId = request.user.isAdmin && tgIdParam ? tgIdParam : request.user.tgId;

    if (!tgId) {
      return reply.status(400).send({ error: 'Missing Telegram ID' });
    }

    const userRef = `tg_${tgId}`;

    // Получаем заказы из базы API
    const apiOrders = ordersRepo.getOrdersByUser(userRef);

    // Получаем заказы из базы бота (если доступна)
    const botOrders: Array<{
      id: string;
      plan_id: string;
      status: string;
      amount: number | null;
      currency: string | null;
      created_at: number;
      updated_at?: number;
    }> = [];

    const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
    if (fs.existsSync(botDbPath)) {
      try {
        const { getDatabase } = await import('../../storage/db.js');
        const db = getDatabase();
        try {
          db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
          const botOrdersRows = db.prepare(`
            SELECT id, plan_id, status, amount, currency, created_at
            FROM bot_db.orders 
            WHERE user_id = ? 
            ORDER BY created_at DESC
            LIMIT 50
          `).all(tgId) as any[];

          botOrders.push(...botOrdersRows.map(row => ({
            id: row.id,
            plan_id: row.plan_id,
            status: row.status.toLowerCase(), // COMPLETED -> completed
            amount: row.amount,
            currency: row.currency || 'RUB',
            created_at: row.created_at, // уже в миллисекундах
          })));

          db.prepare('DETACH DATABASE bot_db').run();
        } catch (attachError) {
          fastify.log.warn({ err: attachError }, '[Payments] Failed to read bot database');
          try {
            db.prepare('DETACH DATABASE bot_db').run();
          } catch (detachError) {
            // Игнорируем ошибку отключения
          }
        }
      } catch (e) {
        fastify.log.error({ err: e }, '[Payments] Error reading bot database');
      }
    }

    // Объединяем заказы из обеих баз
    const allOrders = [
      ...apiOrders.map(order => ({
        id: order.order_id,
        plan_id: order.plan_id,
        status: order.status,
        amount: order.amount_value ? parseFloat(order.amount_value) : 0,
        currency: order.amount_currency || 'RUB',
        date: new Date(order.updated_at || order.created_at).getTime(),
        yookassa_payment_id: order.yookassa_payment_id,
      })),
      ...botOrders.map(order => ({
        id: order.id,
        plan_id: order.plan_id,
        status: order.status,
        amount: order.amount || 0,
        currency: order.currency || 'RUB',
        date: order.created_at,
        yookassa_payment_id: null,
      })),
    ];

    // Удаляем дубликаты (по order_id) и оставляем последний
    const uniqueOrders = new Map<string, typeof allOrders[0]>();
    for (const order of allOrders) {
      const existing = uniqueOrders.get(order.id);
      if (!existing || order.date > existing.date) {
        uniqueOrders.set(order.id, order);
      }
    }

    // Преобразуем заказы в формат для фронтенда
    const payments = Array.from(uniqueOrders.values())
      .filter(order => order.status === 'paid' || order.status === 'pending' || order.status === 'completed')
      .map(order => {
        // Определяем название плана
        let planName = order.plan_id;
        if (order.plan_id === 'plan_7') planName = '7 дней';
        else if (order.plan_id === 'plan_30') planName = '1 месяц';
        else if (order.plan_id === 'plan_90') planName = '3 месяца';
        else if (order.plan_id === 'plan_180') planName = '6 месяцев';
        else if (order.plan_id === 'plan_365') planName = '1 год';

        return {
          id: order.yookassa_payment_id || order.id,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          date: order.date,
          status: order.status === 'paid' || order.status === 'completed' ? 'success' as const :
            order.status === 'pending' ? 'pending' as const :
              'fail' as const,
          planId: order.plan_id,
          planName,
        };
      })
      .sort((a, b) => b.date - a.date); // Сортируем по дате (новые первые)

    return reply.send(payments);
  });
}
