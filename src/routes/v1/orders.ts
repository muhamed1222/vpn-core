import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateOrderRequest, CreateOrderResponse, GetOrderResponse } from '../../types/order.js';
import { YooKassaClient } from '../../integrations/yookassa/client.js';
import { v4 as uuidv4 } from 'uuid';
import { getPlanPrice } from '../../config/plans.js';
import * as ordersRepo from '../../storage/ordersRepo.js';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import fs from 'fs';

const createOrderSchema = z.object({
  planId: z.string().min(1),
  returnUrlBase: z.string().url().optional(),
  // userRef больше не принимаем из body, берем из request.user
});

export async function ordersRoutes(fastify: FastifyInstance) {
  const yookassaClient: YooKassaClient = fastify.yookassaClient;
  const yookassaReturnUrl: string = fastify.yookassaReturnUrl;
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;
  const adminApiKey: string = fastify.adminApiKey;

  // Middleware для проверки авторизации
  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken: fastify.telegramBotToken, // Добавляем botToken для поддержки initData
    adminApiKey,
  });

  // POST /v1/orders/create
  fastify.post<{ Body: CreateOrderRequest }>(
    '/create',
    {
      preHandler: verifyAuth,
      schema: {
        body: {
          type: 'object',
          required: ['planId'],
          properties: {
            planId: { type: 'string' },
            tgId: { type: 'number' },
            returnUrlBase: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      // Проверяем, что пользователь авторизован (middleware уже проверил)
      if (!request.user) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      // Валидация через zod
      const validationResult = createOrderSchema.safeParse(request.body);
      if (!validationResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: validationResult.error.errors,
        });
      }

      const { planId, tgId, returnUrlBase } = request.body as any;

      // Проверка: если пользователь пытается купить plan_7, но у него уже есть оплаченные ордера - отклоняем
      if (planId === 'plan_7') {
        let userRefForCheck: string;
        if (request.user.isAdmin && tgId) {
          userRefForCheck = `tg_${tgId}`;
        } else if (request.user.tgId) {
          userRefForCheck = `tg_${request.user.tgId}`;
        } else {
          return reply.status(401).send({ error: 'User ID missing in token' });
        }

        // Проверяем оплаченные ордера в базе API
        const orders = ordersRepo.getOrdersByUser(userRefForCheck);
        const hasPaidOrders = orders.some(o => o.status === 'paid');

        if (hasPaidOrders) {
          fastify.log.warn({ tgId: request.user.tgId || tgId, planId }, '[Orders] User tried to buy plan_7 but has paid orders');
          return reply.status(400).send({
            error: 'Trial plan unavailable',
            message: 'Пробная подписка доступна только один раз. Выберите другой тариф.'
          });
        }

        // Дополнительная проверка через базу бота
        const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
        if (fs.existsSync(botDbPath)) {
          try {
            const { getDatabase } = await import('../../storage/db.js');
            const db = getDatabase();
            try {
              db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
              const botPaidOrder = db.prepare(`
                SELECT 1 FROM bot_db.orders 
                WHERE user_id = ? AND status IN ('PAID', 'COMPLETED') 
                LIMIT 1
              `).get(request.user.tgId || tgId);

              if (botPaidOrder) {
                db.prepare('DETACH DATABASE bot_db').run();
                fastify.log.warn({ tgId: request.user.tgId || tgId, planId }, '[Orders] User tried to buy plan_7 but has paid orders in bot DB');
                return reply.status(400).send({
                  error: 'Trial plan unavailable',
                  message: 'Пробная подписка доступна только один раз. Выберите другой тариф.'
                });
              }
              db.prepare('DETACH DATABASE bot_db').run();
            } catch (attachError) {
              fastify.log.warn({ err: attachError }, 'Failed to check bot database');
            }
          } catch (e) {
            fastify.log.error({ err: e }, 'Error checking trial availability in bot database');
          }
        }
      }

      let userRef: string;

      if (request.user.isAdmin) {
        if (!tgId) {
          return reply.status(400).send({ error: 'tgId required for admin requests' });
        }
        userRef = `tg_${tgId}`;
      } else {
        if (!request.user.tgId) {
          return reply.status(401).send({ error: 'User ID missing in token' });
        }
        userRef = `tg_${request.user.tgId}`;
      }

      const orderId = uuidv4();
      const idempotenceKey = uuidv4(); // Уникальный ключ для каждого запроса

      // Определяем сумму по planId
      let amount = getPlanPrice(planId);

      // Проверяем скидку пользователя из базы бота
      const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
      let discountPercent = 0;

      if (fs.existsSync(botDbPath)) {
        try {
          const { getDatabase } = await import('../../storage/db.js');
          const db = getDatabase();
          try {
            db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
            const userRow = db.prepare(`
              SELECT discount_percent, discount_expires_at 
              FROM bot_db.users 
              WHERE id = ?
            `).get(request.user.tgId || tgId) as any;

            if (userRow) {
              const now = Date.now();
              // Проверяем, не истекла ли скидка
              if (userRow.discount_percent &&
                (!userRow.discount_expires_at || userRow.discount_expires_at > now)) {
                discountPercent = userRow.discount_percent || 0;
              }
            }

            db.prepare('DETACH DATABASE bot_db').run();
          } catch (attachError) {
            fastify.log.warn({ err: attachError }, 'Failed to check user discount from bot database');
          }
        } catch (e) {
          fastify.log.error({ err: e }, 'Error checking user discount in bot database');
        }
      }

      // Применяем скидку к цене
      if (discountPercent > 0 && discountPercent <= 100) {
        const originalValue = parseFloat(amount.value);
        const discountedValue = Math.round((originalValue * (100 - discountPercent)) / 100);
        // Минимальная цена - 1 рубль (защита от нуля)
        const finalValue = Math.max(1, discountedValue);
        amount = {
          value: finalValue.toFixed(2),
          currency: amount.currency,
          stars: amount.stars,
        };
        fastify.log.info(
          {
            tgId: request.user.tgId || tgId,
            discountPercent,
            originalValue,
            finalValue
          },
          'Applied discount to order'
        );
      }

      let resolvedReturnUrl = yookassaReturnUrl;
      if (returnUrlBase) {
        try {
          const u = new URL(returnUrlBase);
          u.searchParams.set('orderId', orderId);
          resolvedReturnUrl = u.toString();
        } catch (e) {
          fastify.log.warn({ err: e, returnUrlBase }, 'Invalid returnUrlBase, using default yookassaReturnUrl');
        }
      }

      try {
        // Сначала создаем заказ в БД со статусом pending
        ordersRepo.createOrder({
          orderId,
          planId,
          userRef,
        });

        // Создаем платеж в YooKassa
        // Для РФ требуется receipt (чек) - добавляем receipt с валидным форматом
        const paymentParams: any = {
          amount: {
            value: amount.value,
            currency: amount.currency,
          },
          capture: true,
          confirmation: {
            type: 'redirect',
            return_url: resolvedReturnUrl,
          },
          description: `Outlivion plan ${planId}, order ${orderId}`,
          metadata: {
            orderId,
            ...(userRef ? { userRef } : {}),
            planId,
          },
          receipt: {
            customer: {
              // Email для receipt (требуется для ФНС в РФ)
              email: 'noreply@outlivion.space',
            },
            items: [
              {
                description: `vpn-web plan: ${planId}`,
                quantity: '1.00',
                amount: {
                  value: amount.value,
                  currency: amount.currency,
                },
                vat_code: 1, // Без НДС
                payment_subject: 'service', // Услуга
                payment_mode: 'full_prepayment', // Полная предоплата
              },
            ],
          },
        };

        const payment = await yookassaClient.createPayment(
          paymentParams,
          idempotenceKey
        );

        // Проверяем, что payment содержит необходимые данные
        if (!payment || !payment.id) {
          throw new Error('YooKassa вернул неполный ответ: отсутствует payment.id');
        }

        if (!payment.confirmation || !payment.confirmation.confirmation_url) {
          fastify.log.error(
            {
              paymentId: payment.id,
              paymentStatus: payment.status,
              hasConfirmation: !!payment.confirmation,
              paymentData: JSON.stringify(payment).substring(0, 500),
            },
            'YooKassa payment missing confirmation_url'
          );
          throw new Error(`YooKassa payment не содержит confirmation_url. Status: ${payment.status}`);
        }

        // Сохраняем yookassa_payment_id в заказ
        ordersRepo.setPaymentId({
          orderId,
          yookassaPaymentId: payment.id,
          amountValue: payment.amount.value,
          amountCurrency: payment.amount.currency,
        });

        const response: CreateOrderResponse = {
          orderId,
          status: 'pending',
          paymentUrl: payment.confirmation.confirmation_url,
        };

        fastify.log.info(
          {
            orderId,
            paymentId: payment.id,
            paymentUrl: payment.confirmation.confirmation_url,
          },
          'Order created successfully with payment URL'
        );

        return reply.status(201).send(response);
      } catch (error) {
        // Если YooKassa createPayment упал, заказ остается pending
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Детальное логирование ошибки для диагностики
        fastify.log.error(
          {
            err: error,
            errorMessage,
            orderId,
            planId,
            userRef,
            amount: amount.value,
            currency: amount.currency,
          },
          'Failed to create YooKassa payment'
        );

        // Логируем полную ошибку в консоль для отладки (без секретов)
        const sanitizedError = errorMessage.replace(/SHOP_ID|SECRET_KEY|Authorization|Basic [A-Za-z0-9+/=]+/g, '[REDACTED]');
        fastify.log.error({ fullError: sanitizedError }, 'YooKassa payment error details');

        // Возвращаем более информативную ошибку
        return reply.status(500).send({
          error: 'Failed to create payment',
          message: 'Payment service temporarily unavailable. Order created but payment link could not be generated.',
          details: sanitizedError,
        });
      }
    }
  );

  // GET /v1/orders/:orderId
  fastify.get<{ Params: { orderId: string } }>(
    '/:orderId',
    {
      preHandler: verifyAuth,
      schema: {
        params: {
          type: 'object',
          required: ['orderId'],
          properties: {
            orderId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      // Проверяем, что пользователь авторизован (middleware уже проверил)
      if (!request.user) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      const { orderId } = request.params;

      const orderRow = ordersRepo.getOrder(orderId);
      if (!orderRow) {
        return reply.status(404).send({
          error: 'Order not found',
        });
      }

      // Проверяем, что заказ принадлежит текущему пользователю (кроме adminApiKey)
      if (!request.user.isAdmin) {
        const expectedUserRef = `tg_${request.user.tgId}`;
        if (orderRow.user_ref !== expectedUserRef) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Access denied: order belongs to another user',
          });
        }
      }

      const response: GetOrderResponse = {
        orderId: orderRow.order_id,
        status: orderRow.status === 'paid' ? 'paid' : 'pending',
        ...(orderRow.status === 'paid' && orderRow.key ? { key: orderRow.key } : {}),
      };

      return reply.send(response);
    }
  );

  // GET /v1/orders/history
  fastify.get(
    '/history',
    {
      preHandler: verifyAuth,
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const userRef = `tg_${request.user.tgId}`;
      const orders = ordersRepo.getOrdersByUser(userRef);

      const history = orders.map(order => ({
        id: order.order_id,
        orderId: order.order_id,
        amount: parseFloat(order.amount_value || '0'),
        currency: order.amount_currency || 'RUB',
        date: new Date(order.created_at).getTime(),
        status: order.status === 'paid' ? 'success' : (order.status === 'canceled' ? 'cancelled' : 'pending'),
        planName: order.plan_id, // Можно сделать маппинг в читаемые названия
        planId: order.plan_id,
      }));

      return reply.send(history);
    }
  );
}
