import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateOrderRequest, CreateOrderResponse, GetOrderResponse } from '../../types/order.js';
import { YooKassaClient } from '../../integrations/yookassa/client.js';
import { v4 as uuidv4 } from 'uuid';
import { getPlanPrice } from '../../config/plans.js';
import * as ordersRepo from '../../storage/ordersRepo.js';
import { createVerifyAuth } from '../../auth/verifyAuth.js';

const createOrderSchema = z.object({
  planId: z.string().min(1),
  // userRef больше не принимаем из body, берем из request.user
});

export async function ordersRoutes(fastify: FastifyInstance) {
  const yookassaClient: YooKassaClient = fastify.yookassaClient;
  const yookassaReturnUrl: string = fastify.yookassaReturnUrl;
  const jwtSecret: string = fastify.authJwtSecret;
  const cookieName: string = fastify.authCookieName;

  // Middleware для проверки авторизации
  const verifyAuth = createVerifyAuth({
    jwtSecret,
    cookieName,
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
            // userRef больше не принимаем из body
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

      const { planId } = validationResult.data;
      // Берем userRef из авторизованного пользователя
      const userRef = `tg_${request.user.tgId}`;
      const orderId = uuidv4();
      const idempotenceKey = uuidv4(); // Уникальный ключ для каждого запроса

      // Определяем сумму по planId
      const amount = getPlanPrice(planId);

      try {
        // Сначала создаем заказ в БД со статусом pending
        ordersRepo.createOrder({
          orderId,
          planId,
          userRef,
        });

        // Создаем платеж в YooKassa
        // Для РФ требуется receipt (чек) - добавляем минимальный receipt
        const paymentParams: any = {
          amount: {
            value: amount.value,
            currency: amount.currency,
          },
          capture: true,
          confirmation: {
            type: 'redirect',
            return_url: yookassaReturnUrl,
          },
          description: `Outlivion plan ${planId}, order ${orderId}`,
          metadata: {
            orderId,
            ...(userRef ? { userRef } : {}),
            planId,
          },
          receipt: {
            customer: {
              email: 'noreply@outlivion.space', // Обязательное поле для receipt
            },
            items: [
              {
                description: `Outlivion VPN plan: ${planId}`,
                quantity: '1.00',
                amount: {
                  value: amount.value,
                  currency: amount.currency,
                },
                vat_code: 1, // Без НДС (vat_code: 1 = без НДС)
                payment_subject: 'service', // Услуга (VPN)
                payment_mode: 'full_prepayment', // Полная предоплата
              },
            ],
          },
        };

        const payment = await yookassaClient.createPayment(
          paymentParams,
          idempotenceKey
        );

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

        return reply.status(201).send(response);
      } catch (error) {
        // Если YooKassa createPayment упал, заказ остается pending
        fastify.log.error(
          {
            err: error,
            orderId,
            planId,
            userRef,
          },
          'Failed to create YooKassa payment'
        );

        // Логируем детали без секретов
        const errorMessage = error instanceof Error ? error.message : String(error);
        const sanitizedError = errorMessage.replace(/SHOP_ID|SECRET_KEY|Authorization/g, '[REDACTED]');

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

      // Проверяем, что заказ принадлежит текущему пользователю
      const expectedUserRef = `tg_${request.user.tgId}`;
      if (orderRow.user_ref !== expectedUserRef) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Access denied: order belongs to another user',
        });
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

