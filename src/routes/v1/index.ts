import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ordersRoutes } from './orders.js';
import { paymentsRoutes } from './payments.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './user.js';
import { tariffsRoutes } from './tariffs.js';
import { serversRoutes } from './servers.js';
import { contestRoutes } from './contest.js';
import { referralRoutes } from './referral.js';
import { adminRoutes } from './admin.js';
import { promoRoutes } from './promo.js';

export async function v1Routes(fastify: FastifyInstance) {
  // Rate limiting для всех роутов v1
  await fastify.register(rateLimit, {
    max: 100, // максимум 100 запросов
    timeWindow: '1 minute', // за 1 минуту
  });

  // Регистрируем роуты для авторизации (без middleware, доступны всем)
  await fastify.register(authRoutes, { prefix: '/auth' });

  // Регистрируем роуты для заказов
  await fastify.register(ordersRoutes, { prefix: '/orders' });

  // Регистрируем роуты для платежей
  await fastify.register(paymentsRoutes, { prefix: '/payments' });

  // Регистрируем роуты для пользователя (ключи и статус)
  await fastify.register(userRoutes, { prefix: '/user' });

  // Регистрируем роуты для тарифов
  await fastify.register(tariffsRoutes, { prefix: '/tariffs' });

  // Регистрируем роуты для промокодов
  fastify.log.info('[v1] Registering promo routes...');
  await fastify.register(promoRoutes, { prefix: '/promo' });
  fastify.log.info('[v1] Promo routes registered successfully');

  // Регистрируем роуты для серверов (доступно всем)
  try {
    await fastify.register(serversRoutes, { prefix: '/servers' });
  } catch (error) {
    fastify.log.warn({ err: error }, 'Failed to register servers routes');
  }

  // Регистрируем роуты для конкурса
  try {
    await fastify.register(contestRoutes, { prefix: '/contest' });
    fastify.log.info('Contest routes registered');
  } catch (error) {
    fastify.log.error({ err: error }, 'Failed to register contest routes');
  }

  // Регистрируем роуты для реферальной программы
  try {
    await fastify.register(referralRoutes, { prefix: '/referral' });
    fastify.log.info('Referral routes registered');
  } catch (error) {
    fastify.log.error({ err: error }, 'Failed to register referral routes');
  }

  // Регистрируем админские роуты
  try {
    await fastify.register(adminRoutes, { prefix: '/admin' });
    fastify.log.info('Admin routes registered');
  } catch (error) {
    fastify.log.error({ err: error }, 'Failed to register admin routes');
  }

}
