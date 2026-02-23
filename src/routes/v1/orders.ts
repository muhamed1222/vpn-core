import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateOrderRequest, CreateOrderResponse, GetOrderResponse } from '../../types/order.js';
import { YooKassaClient } from '../../integrations/yookassa/client.js';
import { v4 as uuidv4 } from 'uuid';
import { getPlanPrice } from '../../config/plans.js';
import * as ordersRepo from '../../storage/ordersRepo.js';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { botHasPaidOrder, getBotUserDiscount } from '../../storage/botRepo.js';

const createOrderSchema = z.object({
  planId: z.string().min(1),
  returnUrlBase: z.string().url().optional(),
  bonusDays: z.number().int().min(0).optional(),
  autoRenew: z.boolean().optional(),
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
            bonusDays: { type: 'number' },
            autoRenew: { type: 'boolean' },
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

      const { planId, tgId, returnUrlBase, bonusDays, autoRenew } = request.body as any;

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
        const botTgId = request.user.tgId || tgId;
        if (botTgId && botHasPaidOrder(botTgId)) {
          fastify.log.warn({ tgId: botTgId, planId }, '[Orders] User tried to buy plan_7 but has paid orders in bot DB');
          return reply.status(400).send({
            error: 'Trial plan unavailable',
            message: 'Пробная подписка доступна только один раз. Выберите другой тариф.'
          });
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

      // Идемпотентность: если клиент прислал X-Idempotency-Key, проверяем кэш
      const clientIdempotencyKey = request.headers['x-idempotency-key'] as string | undefined;
      if (clientIdempotencyKey) {
        const existingOrder = ordersRepo.getOrderByIdempotencyKey(clientIdempotencyKey);
        if (existingOrder) {
          fastify.log.info({ orderId: existingOrder.order_id, clientIdempotencyKey }, 'Returning cached order for idempotency key');
          const cachedResponse: CreateOrderResponse = {
            orderId: existingOrder.order_id,
            status: existingOrder.status === 'paid' ? 'paid' : 'pending',
            ...(existingOrder.payment_url ? { paymentUrl: existingOrder.payment_url } : {}),
          };
          return reply.status(200).send(cachedResponse);
        }
      }

      const orderId = uuidv4();
      const idempotenceKey = uuidv4(); // Уникальный ключ для YooKassa API

      // Определяем сумму по planId
      let amount = getPlanPrice(planId);

      // Проверяем скидку пользователя из базы бота
      const discountPercent = getBotUserDiscount(request.user.tgId || tgId || 0);

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
          bonusDays,
          idempotencyKey: clientIdempotencyKey,
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
                description: `Outlivion VPN plan: ${planId}`,
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

        if (autoRenew) {
          paymentParams.save_payment_method = true;
          paymentParams.metadata.autoRenew = 'true';
        }

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

        // Сохраняем yookassa_payment_id и paymentUrl в заказ
        ordersRepo.setPaymentId({
          orderId,
          yookassaPaymentId: payment.id,
          amountValue: payment.amount.value,
          amountCurrency: payment.amount.currency,
        });
        ordersRepo.setPaymentUrl(orderId, payment.confirmation.confirmation_url);

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
