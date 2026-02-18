/**
 * Скрипт для начисления билетов за пропущенные заказы
 * Используется для обработки заказов, которые были оплачены до добавления функции начисления билетов
 */

import { getDatabase } from '../src/storage/db.js';
import { awardTicketsForPayment } from '../src/storage/contestUtils.js';

const BOT_DB_PATH = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
const API_DB_PATH = './data/db.sqlite';

async function awardMissingTickets() {
  const db = getDatabase();
  
  try {
    // Прикрепляем базу бота
    db.prepare('ATTACH DATABASE ? AS bot_db').run(BOT_DB_PATH);
    
    try {
      // Получаем активный конкурс
      const contest = db.prepare(`
        SELECT id, starts_at, ends_at
        FROM bot_db.contests
        WHERE is_active = 1
        LIMIT 1
      `).get() as { id: string; starts_at: string; ends_at: string } | undefined;

      if (!contest) {
        console.log('❌ Нет активного конкурса');
        return;
      }

      console.log(`✅ Найден активный конкурс: ${contest.id}`);
      console.log(`   Период: ${contest.starts_at} - ${contest.ends_at}`);

      // Находим заказы из базы бота, которые:
      // 1. Оплачены (COMPLETED или PAID)
      // 2. Попадают в период конкурса
      // 3. Не имеют записи в ticket_ledger
      const ordersToProcess = db.prepare(`
        SELECT 
          o.id,
          o.user_id,
          o.plan_id,
          o.status,
          o.created_at,
          CASE 
            WHEN EXISTS (
              SELECT 1 FROM bot_db.ticket_ledger tl 
              WHERE tl.order_id = o.id 
              AND tl.reason = 'SELF_PURCHASE'
            ) THEN 1 
            ELSE 0 
          END as has_ticket
        FROM bot_db.orders o
        WHERE o.status IN ('COMPLETED', 'PAID')
          AND o.created_at >= ?
          AND o.created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM bot_db.ticket_ledger tl 
            WHERE tl.order_id = o.id 
            AND tl.reason = 'SELF_PURCHASE'
          )
        ORDER BY o.created_at DESC
      `).all(
        Math.floor(new Date(contest.starts_at).getTime()),
        Math.ceil(new Date(contest.ends_at).getTime())
      ) as Array<{
        id: string;
        user_id: number;
        plan_id: string;
        status: string;
        created_at: number;
        has_ticket: number;
      }>;

      console.log(`\n📋 Найдено заказов для обработки: ${ordersToProcess.length}`);

      let successCount = 0;
      let failCount = 0;

      for (const order of ordersToProcess) {
        const orderDateISO = new Date(order.created_at).toISOString();
        
        console.log(`\n🔍 Обработка заказа ${order.id}:`);
        console.log(`   Пользователь: ${order.user_id}`);
        console.log(`   План: ${order.plan_id}`);
        console.log(`   Дата: ${orderDateISO}`);

        try {
          const result = await awardTicketsForPayment(
            BOT_DB_PATH,
            order.user_id,
            order.id,
            order.plan_id,
            orderDateISO
          );

          if (result) {
            console.log(`   ✅ Билеты начислены`);
            successCount++;
          } else {
            console.log(`   ⚠️  Билеты не начислены (нет реферера или вне условий)`);
          }
        } catch (error: any) {
          console.error(`   ❌ Ошибка: ${error.message}`);
          failCount++;
        }
      }

      console.log(`\n📊 Результат:`);
      console.log(`   ✅ Успешно: ${successCount}`);
      console.log(`   ⚠️  Пропущено: ${ordersToProcess.length - successCount - failCount}`);
      console.log(`   ❌ Ошибок: ${failCount}`);

    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error: any) {
    console.error('❌ Критическая ошибка:', error.message);
    process.exit(1);
  }
}

// Запускаем скрипт
awardMissingTickets()
  .then(() => {
    console.log('\n✅ Скрипт завершен');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Ошибка выполнения:', error);
    process.exit(1);
  });
