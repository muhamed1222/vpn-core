import { FastifyInstance } from 'fastify';
import { PLAN_PRICES } from '../../config/plans.js';

/**
 * Роуты для получения тарифов
 */
export async function tariffsRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/tariffs
   * Возвращает список доступных тарифов
   */
  fastify.get('/', async (request, reply) => {
    // Преобразуем PLAN_PRICES в формат для фронтенда
    const tariffs = Object.entries(PLAN_PRICES).map(([id, price]) => {
      // Извлекаем дни из planId (plan_7 = 7 дней, plan_30 = 30 дней и т.д.)
      const days = parseInt(id.replace('plan_', ''), 10);
      const priceStars = Math.round(parseFloat(price.value) * 10); // Конвертируем в stars (1 RUB = 10 stars)
      
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
        price_stars: priceStars,
      };
    });
    
    return reply.send(tariffs);
  });
}

