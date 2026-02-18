import { FastifyInstance } from 'fastify';
import { PLAN_PRICES } from '../../config/plans.js';
import { createVerifyAuth } from '../../auth/verifyAuth.js';
import { getOrdersByUser } from '../../storage/ordersRepo.js';
import fs from 'fs';

/**
 * Роуты для получения тарифов
 */
export async function tariffsRoutes(fastify: FastifyInstance) {
  const jwtSecret = fastify.authJwtSecret;
  const cookieName = fastify.authCookieName;
  const botToken = fastify.telegramBotToken;
  const adminApiKey = fastify.adminApiKey;

  // Опциональная авторизация для проверки доступности пробного периода
  const verifyAuthOptional = createVerifyAuth({
    jwtSecret,
    cookieName,
    botToken,
    adminApiKey,
  });

  /**
   * GET /v1/tariffs
   * Возвращает список доступных тарифов
   */
  fastify.get('/', {
    // Делаем авторизацию опциональной - если пользователь не авторизован,
    // он просто увидит все тарифы, включая пробный.
    preHandler: async (request, reply) => {
      try {
        await verifyAuthOptional(request, reply);
      } catch (e) {
        // Игнорируем ошибку авторизации - request.user останется undefined
      }
    }
  }, async (request, reply) => {
    let trialAvailable = true;

    // Если пользователь авторизован, проверяем его прошлые заказы
    if (request.user && request.user.tgId) {
      const userRef = `tg_${request.user.tgId}`;
      const orders = getOrdersByUser(userRef);
      
      // Проверяем, были ли успешные оплаты (статус 'paid')
      const hasPaidOrders = orders.some(o => o.status === 'paid');
      
      if (hasPaidOrders) {
        trialAvailable = false;
        fastify.log.info({ tgId: request.user.tgId, hasPaidOrders }, '[Tariffs] User has paid orders, hiding plan_7');
      }

      // Дополнительная проверка через базу бота (если доступна)
      // Пробуем стандартный путь, если переменная окружения не установлена
      const botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
      if (trialAvailable && fs.existsSync(botDbPath)) {
        try {
          const { getDatabase } = await import('../../storage/db.js');
          const db = getDatabase();
          
          // Прикрепляем базу бота (ATTACH)
          // Примечание: ATTACH работает в рамках текущего соединения
          // Мы используем try/catch на случай проблем с правами доступа
          try {
            db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
            
            const botPaidOrder = db.prepare(`
              SELECT 1 FROM bot_db.orders 
              WHERE user_id = ? AND status IN ('PAID', 'COMPLETED') 
              LIMIT 1
            `).get(request.user.tgId);
            
            if (botPaidOrder) {
              trialAvailable = false;
              fastify.log.info({ tgId: request.user.tgId }, '[Tariffs] User has paid orders in bot DB, hiding plan_7');
            }
            
            db.prepare('DETACH DATABASE bot_db').run();
          } catch (attachError) {
            // Если база уже прикреплена или другая ошибка
            fastify.log.warn({ err: attachError }, 'Failed to check bot database');
          }
        } catch (e) {
          fastify.log.error({ err: e }, 'Error checking trial availability in bot database');
        }
      }
    } else {
      // Если пользователь не авторизован, показываем все тарифы (включая пробный)
      // Это нормально для первого визита
      fastify.log.debug('[Tariffs] User not authenticated, showing all plans including trial');
    }

    // Преобразуем PLAN_PRICES в формат для фронтенда
    const tariffs = Object.entries(PLAN_PRICES)
      .filter(([id]) => {
        // Скрываем тестовый тариф, если он недоступен
        if (id === 'plan_7' && !trialAvailable) {
          return false;
        }
        return true;
      })
      .map(([id, price]) => {
        // Извлекаем дни из planId
        const days = parseInt(id.replace('plan_', ''), 10);
        
        // Формируем название тарифа
        let name = '';
        if (days === 7) name = '7 дней';
        else if (days === 30) name = '1 месяц';
        else if (days === 90) name = '3 месяца';
        else if (days === 180) name = '6 месяцев';
        else if (days === 365) name = '1 год';
        else name = `${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`;
        
        return {
          id,
          name,
          days,
          price_rub: parseFloat(price.value),
          price_stars: price.stars,
        };
      });
    
    return reply.send(tariffs);
  });
}
