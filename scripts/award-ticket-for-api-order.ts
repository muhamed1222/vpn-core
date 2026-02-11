#!/usr/bin/env tsx
/**
 * Скрипт для начисления билетов за заказ из базы API
 * Использование: npx tsx scripts/award-ticket-for-api-order.ts <order_id>
 */

import dotenv from 'dotenv';
import path from 'path';
import { initDatabase, getDatabase } from '../src/storage/db.js';
import { awardTicketsForPayment } from '../src/storage/contestUtils.js';
import * as ordersRepo from '../src/storage/ordersRepo.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const BOT_DB_PATH = process.env.BOT_DATABASE_PATH || '/root/vpn_bot/data/database.sqlite';
const API_DB_PATH = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data/db.sqlite');

const orderId = process.argv[2];

if (!orderId) {
  console.error('❌ Укажите order_id: npx tsx scripts/award-ticket-for-api-order.ts <order_id>');
  process.exit(1);
}

async function awardTicketForOrder() {
  // Инициализируем базу API
  initDatabase(API_DB_PATH);
  const apiDb = getDatabase();

  try {
    // Получаем заказ из базы API
    const order = ordersRepo.getOrder(orderId);
    
    if (!order) {
      console.error(`❌ Заказ ${orderId} не найден в базе API`);
      process.exit(1);
    }

    console.log(`✅ Заказ найден:`);
    console.log(`   ID: ${order.order_id}`);
    console.log(`   Пользователь: ${order.user_ref}`);
    console.log(`   План: ${order.plan_id}`);
    console.log(`   Статус: ${order.status}`);
    console.log(`   Создан: ${order.created_at}\n`);

    if (order.status !== 'paid' && order.status !== 'completed') {
      console.error(`❌ Заказ не оплачен (статус: ${order.status})`);
      process.exit(1);
    }

    const tgIdStr = order.user_ref?.replace('tg_', '');
    const tgId = tgIdStr ? parseInt(tgIdStr, 10) : null;

    if (!tgId || isNaN(tgId)) {
      console.error(`❌ Не удалось извлечь telegram ID из ${order.user_ref}`);
      process.exit(1);
    }

    console.log(`🔄 Начисляем билеты...`);
    
    // Начисляем билеты через правильную функцию
    const result = await awardTicketsForPayment(
      BOT_DB_PATH,
      tgId,
      order.order_id,
      order.plan_id,
      order.created_at
    );

    if (result) {
      console.log(`✅ Билеты успешно начислены!`);
    } else {
      console.log(`⚠️  Билеты не начислены (возможно, вне периода конкурса или уже начислены)`);
    }

  } catch (error: any) {
    console.error(`❌ Ошибка: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

awardTicketForOrder()
  .then(() => {
    console.log('\n✅ Скрипт завершен');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  });
