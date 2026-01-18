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
