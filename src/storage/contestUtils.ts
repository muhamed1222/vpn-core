/**
 * Утилиты для работы с конкурсами
 */

import type Database from 'better-sqlite3';

/**
 * Конвертирует plan_id в количество билетов (месяцев)
 * 
 * Правила:
 * - plan_30 = 1 билет (1 месяц)
 * - plan_90 = 3 билета (3 месяца)
 * - plan_180 = 6 билетов (6 месяцев)
 * - plan_365 = 12 билетов (12 месяцев)
 * - plan_XXX (динамический) = XXX дней / 30 (округление вверх)
 * 
 * @param planId - ID плана (например, 'plan_30')
 * @returns Количество билетов (месяцев) или 0 для невалидных планов
 */
export function getTicketsFromPlanId(planId: string | null | undefined): number {
  if (!planId) {
    return 0;
  }

  // Фиксированные планы
  const fixedPlans: Record<string, number> = {
    'plan_30': 1,
    'plan_90': 3,
    'plan_180': 6,
    'plan_365': 12,
  };

  if (planId in fixedPlans) {
    return fixedPlans[planId];
  }

  // Динамические планы (plan_XXX где XXX = дни)
  if (planId.startsWith('plan_')) {
    const daysStr = planId.substring(5); // Извлекаем часть после 'plan_'
    const days = parseInt(daysStr, 10);
    
    if (!isNaN(days) && days > 0) {
      // Округляем вверх до месяца (7 дней = 1 месяц, 30 дней = 1 месяц)
      return Math.ceil(days / 30);
    }
  }

  // Невалидный plan_id - логируем предупреждение и возвращаем 0
  console.warn(`[getTicketsFromPlanId] Unknown plan_id: ${planId}`);
  return 0;
}

/**
 * SQL выражение для конвертации plan_id в билеты
 * Используется в SQL запросах, где нужна конвертация на уровне БД
 * 
 * @param planIdColumn - Имя колонки с plan_id (по умолчанию 'plan_id')
 * @returns SQL выражение CASE для конвертации
 */
export function getTicketsFromPlanIdSQL(planIdColumn: string = 'plan_id'): string {
  return `
    CASE 
      WHEN ${planIdColumn} = 'plan_30' THEN 1
      WHEN ${planIdColumn} = 'plan_90' THEN 3
      WHEN ${planIdColumn} = 'plan_180' THEN 6
      WHEN ${planIdColumn} = 'plan_365' THEN 12
      WHEN ${planIdColumn} LIKE 'plan_%' THEN 
        CASE 
          WHEN CAST(SUBSTR(${planIdColumn}, 6) AS INTEGER) > 0 
          THEN CAST((CAST(SUBSTR(${planIdColumn}, 6) AS INTEGER) + 29) / 30 AS INTEGER)
          ELSE 0
        END
      ELSE 0
    END
  `.trim();
}

/**
 * Проверяет существование таблиц для системы конкурсов
 * 
 * @param db - База данных
 * @param dbName - Имя базы (например, 'bot_db')
 * @returns Объект с результатами проверки
 */
export function checkContestTables(
  db: Database.Database,
  dbName: string = 'bot_db'
): { refEventsExists: boolean; ticketLedgerExists: boolean } {
  const refEventsExists = !!(db.prepare(`
    SELECT name FROM ${dbName}.sqlite_master 
    WHERE type='table' AND name='ref_events'
  `).get() as { name: string } | undefined);

  const ticketLedgerExists = !!(db.prepare(`
    SELECT name FROM ${dbName}.sqlite_master 
    WHERE type='table' AND name='ticket_ledger'
  `).get() as { name: string } | undefined);

  return { refEventsExists, ticketLedgerExists };
}

/**
 * Начисляет билеты при оплате подписки
 * 
 * Логика начисления:
 * 1. ВСЕГДА начисляет билеты самому покупателю (SELF_PURCHASE)
 * 2. Если у покупателя есть реферер (и прошел все проверки) - начисляет билеты и рефереру (INVITEE_PAYMENT)
 * 
 * Проверки для реферера:
 * - Период конкурса
 * - Окно атрибуции (7 дней от привязки)
 * - Квалификация (не было оплат до привязки)
 * 
 * @param botDbPath - Путь к базе данных бота
 * @param referredTgId - Telegram ID пользователя (кто оплатил)
 * @param orderId - ID заказа
 * @param planId - ID плана подписки
 * @param orderCreatedAt - Дата создания заказа (ISO string)
 * @returns true если билеты начислены (хотя бы пользователю), false если не подходит под условия конкурса
 */
export async function awardTicketsForPayment(
  botDbPath: string,
  referredTgId: number,
  orderId: string,
  planId: string,
  orderCreatedAt: string
): Promise<boolean> {
  const { getDatabase } = await import('./db.js');
  // Используем прямую функцию из того же модуля (циклический импорт избегаем)
  const db = getDatabase();
  
  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[awardTicketsForPayment] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }
    
    try {
      // Получаем активный конкурс
      const contest = db.prepare(`
        SELECT id, starts_at, ends_at, attribution_window_days
        FROM bot_db.contests
        WHERE is_active = 1
        ORDER BY starts_at DESC
        LIMIT 1
      `).get() as {
        id: string;
        starts_at: string;
        ends_at: string;
        attribution_window_days: number;
      } | undefined;

      if (!contest) {
        console.log('[awardTicketsForPayment] No active contest found');
        return false;
      }

      // Проверяем, попадает ли заказ в период конкурса
      // orderCreatedAt может быть ISO string или timestamp (миллисекунды)
      let orderDate: Date;
      if (typeof orderCreatedAt === 'string') {
        // Если это ISO string или число в виде строки (timestamp)
        const parsed = Date.parse(orderCreatedAt);
        if (!isNaN(parsed)) {
          orderDate = new Date(parsed);
        } else {
          // Пробуем как число (миллисекунды)
          const num = Number(orderCreatedAt);
          orderDate = isNaN(num) ? new Date() : new Date(num);
        }
      } else {
        // Если это число (timestamp в миллисекундах)
        orderDate = new Date(orderCreatedAt);
      }
      
      const contestStart = new Date(contest.starts_at);
      const contestEnd = new Date(contest.ends_at);
      
      if (orderDate < contestStart || orderDate > contestEnd) {
        console.log(`[awardTicketsForPayment] Order ${orderId} is outside contest period`);
        return false;
      }

      // Находим реферера (если есть)
      const referral = db.prepare(`
        SELECT referrer_id
        FROM bot_db.user_referrals
        WHERE referred_id = ?
        LIMIT 1
      `).get(referredTgId) as { referrer_id: number } | undefined;

      let referrerId: number | null = null;
      let bindingDate: Date | null = null;

      // Если есть реферер, проверяем квалификацию
      if (referral) {
        referrerId = referral.referrer_id;
        
        // Проверяем, не является ли это саморефералом
        if (referrerId === referredTgId) {
          console.log(`[awardTicketsForPayment] Self-referral detected: ${referredTgId}`);
          referrerId = null; // Игнорируем самореферал
        } else {
          // Проверяем окно атрибуции
          const referralBinding = db.prepare(`
            SELECT created_at
            FROM bot_db.user_referrals
            WHERE referrer_id = ? AND referred_id = ?
            LIMIT 1
          `).get(referrerId, referredTgId) as { created_at: string | number } | undefined;

          if (referralBinding) {
            bindingDate = typeof referralBinding.created_at === 'string' 
              ? new Date(referralBinding.created_at)
              : new Date(referralBinding.created_at * 1000);
            
            const attributionDeadline = new Date(bindingDate);
            attributionDeadline.setDate(attributionDeadline.getDate() + contest.attribution_window_days);
            
            if (orderDate > attributionDeadline) {
              console.log(`[awardTicketsForPayment] Order ${orderId} is outside attribution window`);
              referrerId = null; // Пропускаем реферера из-за окна атрибуции
            } else {
              // Проверяем квалификацию: не было ли оплат до привязки
              const priorPayments = db.prepare(`
                SELECT COUNT(*) as count
                FROM bot_db.orders
                WHERE user_id = ?
                  AND status IN ('PAID', 'COMPLETED')
                  AND created_at < ?
              `).get(referredTgId, bindingDate.toISOString()) as { count: number } | undefined;

              if (priorPayments && priorPayments.count > 0) {
                console.log(`[awardTicketsForPayment] User ${referredTgId} had ${priorPayments.count} payments before binding - referrer not qualified`);
                referrerId = null; // Пропускаем реферера из-за квалификации
              }
            }
          } else {
            referrerId = null;
          }
        }
      }

      // Рассчитываем количество билетов (используем функцию из того же модуля)
      const ticketsDelta = getTicketsFromPlanId(planId);
      
      if (ticketsDelta <= 0) {
        console.log(`[awardTicketsForPayment] Invalid plan_id: ${planId}`);
        return false;
      }

      // Проверяем наличие таблиц
      const { ticketLedgerExists, refEventsExists } = checkContestTables(db, 'bot_db');
      
      if (!ticketLedgerExists) {
        console.warn('[awardTicketsForPayment] ticket_ledger table not found');
        return false;
      }

      const now = new Date().toISOString();
      let ticketsAwarded = false;

      // 1. ВСЕГДА начисляем билеты самому пользователю (покупателю)
      const selfTicketId = `ticket_self_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      db.prepare(`
        INSERT INTO bot_db.ticket_ledger (
          id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'SELF_PURCHASE', ?)
      `).run(selfTicketId, contest.id, referredTgId, referredTgId, orderId, ticketsDelta, now);
      ticketsAwarded = true;
      console.log(`[awardTicketsForPayment] Awarded ${ticketsDelta} tickets to user ${referredTgId} (self-purchase)`);

      // 2. Если есть реферер (и он прошел все проверки) - начисляем билеты и ему тоже
      if (referrerId !== null) {
        const referrerTicketId = `ticket_ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        
        db.prepare(`
          INSERT INTO bot_db.ticket_ledger (
            id, contest_id, referrer_id, referred_id, order_id, delta, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'INVITEE_PAYMENT', ?)
        `).run(referrerTicketId, contest.id, referrerId, referredTgId, orderId, ticketsDelta, now);

        ticketsAwarded = true;
        console.log(`[awardTicketsForPayment] Awarded ${ticketsDelta} tickets to referrer ${referrerId} for order ${orderId}`);

        // Обновляем или создаем запись в ref_events
        if (refEventsExists && bindingDate) {
          const existingEvent = db.prepare(`
            SELECT id, status
            FROM bot_db.ref_events
            WHERE contest_id = ? AND referrer_id = ? AND referred_id = ?
            LIMIT 1
          `).get(contest.id, referrerId, referredTgId) as { id: string; status: string } | undefined;

          if (existingEvent) {
            // Обновляем статус на 'qualified'
            db.prepare(`
              UPDATE bot_db.ref_events
              SET status = 'qualified',
                  qualified_at = ?
              WHERE id = ?
            `).run(now, existingEvent.id);
          } else {
            // Создаем новую запись
            const eventId = `ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
            const bindingDateStr = bindingDate.toISOString();
            db.prepare(`
              INSERT INTO bot_db.ref_events (
                id, contest_id, referrer_id, referred_id, bound_at, status, qualified_at
              ) VALUES (?, ?, ?, ?, ?, 'qualified', ?)
            `).run(eventId, contest.id, referrerId, referredTgId, bindingDateStr, now);
          }
        }
      }

      return ticketsAwarded;

    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error(`[awardTicketsForPayment] Error:`, error);
    return false;
  }
}
