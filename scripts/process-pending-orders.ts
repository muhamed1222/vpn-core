#!/usr/bin/env tsx
/**
 * Скрипт для обработки pending заказов из базы API
 * Проверяет статус платежей в YooKassa и обрабатывает успешные
 */

import dotenv from 'dotenv';
import path from 'path';
// Не используем YooKassaClient, так как у него нет метода getPayment
import { initDatabase, getDatabase } from '../src/storage/db.js';
import * as ordersRepo from '../src/storage/ordersRepo.js';
import { awardTicketsForPayment } from '../src/storage/contestUtils.js';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const BOT_DB_PATH = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
  console.error('❌ YOOKASSA credentials не найдены');
  process.exit(1);
}

// Используем прямой запрос к YooKassa API

async function processPendingOrders() {
  // Инициализируем базу данных
  const API_DB_PATH = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data/db.sqlite');
  initDatabase(API_DB_PATH);
  const db = getDatabase();
  
  try {
    // Получаем pending заказы после 15:00 МСК (12:00 UTC)
    const pendingOrders = db.prepare(`
      SELECT 
        order_id,
        user_ref,
        plan_id,
        status,
        yookassa_payment_id,
        created_at
      FROM orders
      WHERE status = 'pending'
        AND datetime(created_at) >= '2026-01-20 12:00:00'
        AND yookassa_payment_id IS NOT NULL
      ORDER BY created_at DESC
    `).all() as Array<{
      order_id: string;
      user_ref: string;
      plan_id: string;
      status: string;
      yookassa_payment_id: string;
      created_at: string;
    }>;

    console.log(`📋 Найдено pending заказов: ${pendingOrders.length}\n`);

    if (pendingOrders.length === 0) {
      console.log('✅ Нет pending заказов для обработки');
      return;
    }

    let processedCount = 0;
    let succeededCount = 0;
    let failedCount = 0;

    for (const order of pendingOrders) {
      console.log(`\n🔍 Обработка заказа ${order.order_id}:`);
      console.log(`   Пользователь: ${order.user_ref}`);
      console.log(`   План: ${order.plan_id}`);
      console.log(`   Payment ID: ${order.yookassa_payment_id}`);

      try {
        // Проверяем статус платежа в YooKassa через API
        const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
        const response = await fetch(`https://api.yookassa.ru/v3/payments/${order.yookassa_payment_id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${auth}`,
          },
        });

        if (!response.ok) {
          console.log(`   ❌ Ошибка при проверке платежа: ${response.status} ${response.statusText}`);
          failedCount++;
          continue;
        }

        const payment = await response.json() as { status: string; id: string; paid: boolean };
        
        console.log(`   Статус платежа в YooKassa: ${payment.status}`);

        if (payment.status === 'succeeded') {
          console.log(`   ✅ Платеж успешен, обрабатываем заказ...`);

          const tgIdStr = order.user_ref?.replace('tg_', '');
          const tgId = tgIdStr ? parseInt(tgIdStr, 10) : null;

          if (!tgId || isNaN(tgId)) {
            console.log(`   ❌ Не удалось извлечь telegram ID из ${order.user_ref}`);
            failedCount++;
            continue;
          }

          // Определяем количество дней
          let days = 30;
          if (order.plan_id === 'plan_7') days = 7;
          else if (order.plan_id === 'plan_30') days = 30;
          else if (order.plan_id === 'plan_90') days = 90;
          else if (order.plan_id === 'plan_180') days = 180;
          else if (order.plan_id === 'plan_365') days = 365;

          // Импортируем marzbanService (нужно будет создать или использовать существующий)
          // Пока просто обновляем статус заказа
          const updated = ordersRepo.markPaidWithKey({
            orderId: order.order_id,
            key: 'MANUAL_PROCESSING' // Временный ключ, нужно будет получить реальный
          });

          if (updated) {
            console.log(`   ✅ Заказ обновлен в базе API`);
            
            // Начисляем билеты
            if (fs.existsSync(BOT_DB_PATH)) {
              try {
                const orderCreatedAt = order.created_at || new Date().toISOString();
                const ticketsAwarded = await awardTicketsForPayment(
                  BOT_DB_PATH,
                  tgId,
                  order.order_id,
                  order.plan_id,
                  orderCreatedAt
                );

                if (ticketsAwarded) {
                  console.log(`   ✅ Билеты начислены`);
                } else {
                  console.log(`   ⚠️  Билеты не начислены (возможно, вне периода конкурса)`);
                }
              } catch (ticketError: any) {
                console.error(`   ❌ Ошибка начисления билетов: ${ticketError.message}`);
              }
            }

            succeededCount++;
          } else {
            console.log(`   ❌ Не удалось обновить заказ`);
            failedCount++;
          }
        } else if (payment.status === 'canceled') {
          console.log(`   ⏭️  Платеж отменен, пропускаем`);
        } else {
          console.log(`   ⏳ Платеж еще не завершен (статус: ${payment.status})`);
        }

        processedCount++;
      } catch (error: any) {
        console.error(`   ❌ Ошибка при обработке: ${error.message}`);
        failedCount++;
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 ИТОГИ:');
    console.log('='.repeat(60));
    console.log(`✅ Успешно обработано: ${succeededCount}`);
    console.log(`⏳ Платежи в процессе: ${processedCount - succeededCount - failedCount}`);
    console.log(`❌ Ошибок: ${failedCount}`);
    console.log(`📈 Всего проверено: ${processedCount}`);

  } catch (error: any) {
    console.error('❌ Критическая ошибка:', error.message);
    throw error;
  }
}

// Запускаем скрипт
processPendingOrders()
  .then(() => {
    console.log('\n✅ Скрипт завершен');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Ошибка выполнения:', error);
    process.exit(1);
  });
