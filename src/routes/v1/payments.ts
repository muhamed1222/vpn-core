import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as ordersRepo from '../../storage/ordersRepo.js';
import { isYooKassaIP } from '../../config/yookassa.js';

const yookassaWebhookSchema = z.object({
  type: z.literal('notification'),
  event: z.string(),
  object: z.object({
    id: z.string(),
    status: z.string(),
    paid: z.boolean(),
    amount: z.object({
      value: z.string(),
      currency: z.string(),
    }).optional(),
    metadata: z.object({
      orderId: z.string(),
      userRef: z.string().optional(),
      planId: z.string().optional(),
    }).optional(),
  }),
});

export async function paymentsRoutes(fastify: FastifyInstance) {
  const webhookIPCheck: boolean = fastify.yookassaWebhookIPCheck;
  const marzbanService = fastify.marzbanService;

  // POST /v1/payments/webhook
  fastify.post<{ Body: unknown }>(
    '/webhook',
    {
      schema: {
        body: {
          type: 'object',
        },
      },
    },
    async (request, reply) => {
      // Проверка IP (если включена)
      if (webhookIPCheck) {
        const clientIP = request.ip || '';
        if (!clientIP || !isYooKassaIP(clientIP)) {
          fastify.log.warn({ ip: clientIP, headers: request.headers }, 'Webhook request from unauthorized IP');
          return reply.status(403).send({ error: 'Forbidden' });
        }
      }

      // Валидация через zod
      const validationResult = yookassaWebhookSchema.safeParse(request.body);
      if (!validationResult.success) {
        fastify.log.warn({ body: request.body, errors: validationResult.error.errors }, 'Invalid webhook payload');
        return reply.status(400).send({
          error: 'Validation failed',
          details: validationResult.error.errors,
        });
      }

      const { event, object } = validationResult.data;
      const paymentId = object.id;

      // Извлекаем orderId из metadata или ищем по payment_id
      let orderId: string | null = null;
      if (object.metadata?.orderId) {
        orderId = object.metadata.orderId;
      } else {
        const order = ordersRepo.getOrderByPaymentId(paymentId);
        if (order) {
          orderId = order.order_id;
        }
      }

      if (!orderId) {
        fastify.log.error({ paymentId }, 'Order not found for payment');
        return reply.status(200).send({ ok: true });
      }

      const orderRow = ordersRepo.getOrder(orderId);
      if (!orderRow) {
        fastify.log.error({ orderId, paymentId }, 'Order not found in database');
        return reply.status(200).send({ ok: true });
      }

      // Обработка payment.succeeded
      if (event === 'payment.succeeded' && object.status === 'succeeded' && object.paid === true) {
        if (orderRow.status === 'paid' && orderRow.key) {
          return reply.status(200).send({ ok: true });
        }

        // Пытаемся получить или создать ключ для пользователя
        const tgIdStr = orderRow.user_ref?.replace('tg_', '');
        const tgId = tgIdStr ? parseInt(tgIdStr, 10) : null;

        let key = 'Check your account for VPN key';
        if (tgId && !isNaN(tgId)) {
          try {
            // 1. Сначала создаем пользователя, если его нет
            const config = await marzbanService.getOrCreateUserConfig(tgId);
            
            // 2. Рассчитываем срок на основе planId
            const planId = orderRow.plan_id;
            let days = 30; // дефолт
            if (planId === 'plan_7') days = 7;
            else if (planId === 'plan_30') days = 30;
            else if (planId === 'plan_90') days = 90;
            else if (planId === 'plan_180') days = 180;
            else if (planId === 'plan_365') days = 365;

            const expireTimestamp = Math.floor(Date.now() / 1000) + (days * 86400);

            // 3. Обновляем срок в Marzban
            await marzbanService.client.updateUser(tgId.toString(), {
              expire: expireTimestamp,
              status: 'active'
            });

            if (config) {
              key = config;
            }
          } catch (e: any) {
            fastify.log.error({ err: e.message, tgId }, 'Failed to activate/update Marzban');
          }
        }

        // Помечаем заказ как paid и сохраняем key
        ordersRepo.markPaidWithKey({
          orderId,
          key: key,
        });

        fastify.log.info({ orderId, paymentId }, 'Order marked as paid');
        return reply.status(200).send({ ok: true });
      }

      if (event === 'payment.canceled') {
        ordersRepo.markCanceled(orderId);
        return reply.status(200).send({ ok: true });
      }

      return reply.status(200).send({ ok: true });
    }
  );
}
