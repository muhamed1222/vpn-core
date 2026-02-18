#!/usr/bin/env tsx

/**
 * Скрипт для проверки состояния конкурса
 * Проверяет:
 * - Наличие активного конкурса в базе данных
 * - Состояние таблиц (contests, ref_events, ticket_ledger)
 * - Статистику по билетам и рефералам
 * - Настройки API
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_DB_PATH = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
const API_DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../data/db.sqlite');

interface Contest {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  attribution_window_days: number;
  rules_version: string;
  is_active: number;
}

function checkContest(): void {
  console.log('🔍 Проверка системы конкурсов\n');
  console.log('=' .repeat(60));

  // 1. Проверка существования базы данных бота
  console.log('\n1️⃣ Проверка базы данных бота...');
  if (!fs.existsSync(BOT_DB_PATH)) {
    console.error(`   ❌ База данных не найдена: ${BOT_DB_PATH}`);
    console.error(`   💡 Установите переменную окружения BOT_DATABASE_PATH`);
    process.exit(1);
  }
  console.log(`   ✅ База данных найдена: ${BOT_DB_PATH}`);

  const botDb = new Database(BOT_DB_PATH, { readonly: true });

  try {
    // 2. Проверка таблицы contests
    console.log('\n2️⃣ Проверка таблицы contests...');
    const contestsTableExists = botDb.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='contests'
    `).get() as { name: string } | undefined;

    if (!contestsTableExists) {
      console.error('   ❌ Таблица contests не существует');
      console.error('   💡 Запустите скрипт create_contest.ts для создания таблицы');
      process.exit(1);
    }
    console.log('   ✅ Таблица contests существует');

    // 3. Проверка активных конкурсов
    console.log('\n3️⃣ Проверка активных конкурсов...');
    const allContests = botDb.prepare(`
      SELECT id, title, starts_at, ends_at, attribution_window_days, rules_version, is_active
      FROM contests
      ORDER BY starts_at DESC
    `).all() as Contest[];

    let activeContest: Contest | null = null;

    if (allContests.length === 0) {
      console.warn('   ⚠️  В базе нет конкурсов');
      console.log('   💡 Создайте конкурс с помощью: cd vpn-bot && npx tsx scripts/create_contest.ts');
    } else {
      console.log(`   📊 Найдено конкурсов: ${allContests.length}`);
      
      const now = Date.now();

      for (const contest of allContests) {
        const startTime = new Date(contest.starts_at).getTime();
        const endTime = new Date(contest.ends_at).getTime();
        const isActive = contest.is_active === 1;
        const isInPeriod = now >= startTime && now <= endTime;
        const isCurrentlyActive = isActive && isInPeriod;

        console.log(`\n   📋 Конкурс: ${contest.title}`);
        console.log(`      ID: ${contest.id}`);
        console.log(`      Начало: ${new Date(startTime).toLocaleString('ru-RU')}`);
        console.log(`      Окончание: ${new Date(endTime).toLocaleString('ru-RU')}`);
        console.log(`      Окно атрибуции: ${contest.attribution_window_days} дней`);
        console.log(`      Версия правил: ${contest.rules_version}`);
        console.log(`      is_active: ${isActive ? '✅' : '❌'}`);
        console.log(`      Период: ${isInPeriod ? '✅ Активен' : now < startTime ? '⏳ Еще не начался' : '⏸️  Уже закончился'}`);
        
        if (isCurrentlyActive) {
          activeContest = contest;
          console.log(`      🎯 СТАТУС: ✅ АКТИВЕН СЕЙЧАС`);
        }
      }

      if (!activeContest) {
        console.warn('\n   ⚠️  Нет активного конкурса в данный момент');
        console.log('   💡 Проверьте даты начала и окончания конкурсов');
      } else {
        console.log(`\n   ✅ Активный конкурс найден: ${activeContest.title}`);
      }
    }

    // 4. Проверка таблиц ref_events и ticket_ledger
    console.log('\n4️⃣ Проверка таблиц для реферальной программы...');
    const refEventsExists = botDb.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='ref_events'
    `).get() as { name: string } | undefined;

    const ticketLedgerExists = botDb.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='ticket_ledger'
    `).get() as { name: string } | undefined;

    if (refEventsExists) {
      console.log('   ✅ Таблица ref_events существует');
      const refEventsCount = botDb.prepare('SELECT COUNT(*) as count FROM ref_events').get() as { count: number };
      console.log(`      📊 Записей: ${refEventsCount.count}`);
    } else {
      console.warn('   ⚠️  Таблица ref_events не существует');
      console.log('   💡 Таблица будет создана автоматически при первом использовании');
    }

    if (ticketLedgerExists) {
      console.log('   ✅ Таблица ticket_ledger существует');
      const ticketLedgerCount = botDb.prepare('SELECT COUNT(*) as count FROM ticket_ledger').get() as { count: number };
      const ticketsTotal = botDb.prepare('SELECT COALESCE(SUM(delta), 0) as total FROM ticket_ledger').get() as { total: number };
      console.log(`      📊 Записей: ${ticketLedgerCount.count}`);
      console.log(`      🎫 Всего билетов: ${ticketsTotal.total}`);
    } else {
      console.warn('   ⚠️  Таблица ticket_ledger не существует');
      console.log('   💡 Таблица будет создана автоматически при первом начислении билетов');
    }

    // 5. Статистика по рефералам (если есть активный конкурс)
    if (activeContest && refEventsExists && ticketLedgerExists) {
      console.log('\n5️⃣ Статистика по активному конкурсу...');
      
      const ticketsStats = botDb.prepare(`
        SELECT 
          COUNT(DISTINCT referrer_id) as participants,
          COALESCE(SUM(delta), 0) as tickets_total
        FROM ticket_ledger
        WHERE contest_id = ?
      `).get(activeContest.id) as {
        participants: number;
        tickets_total: number;
      };

      const refStats = botDb.prepare(`
        SELECT 
          COUNT(DISTINCT referred_id) as invited_total,
          COUNT(DISTINCT CASE WHEN status = 'qualified' THEN referred_id END) as qualified_total
        FROM ref_events
        WHERE contest_id = ?
      `).get(activeContest.id) as {
        invited_total: number;
        qualified_total: number;
      };

      console.log(`   👥 Участников: ${ticketsStats.participants}`);
      console.log(`   👤 Приглашено: ${refStats.invited_total}`);
      console.log(`   ✅ Квалифицировано: ${refStats.qualified_total}`);
      console.log(`   🎫 Всего билетов: ${ticketsStats.tickets_total}`);
    }

    // 6. Проверка переменных окружения API
    console.log('\n6️⃣ Проверка настроек API...');
    const botDbPathEnv = process.env.BOT_DATABASE_PATH;
    if (botDbPathEnv) {
      console.log(`   ✅ BOT_DATABASE_PATH установлен: ${botDbPathEnv}`);
      if (botDbPathEnv === BOT_DB_PATH) {
        console.log('   ✅ Путь совпадает с используемым');
      } else {
        console.warn(`   ⚠️  Путь в переменной окружения отличается от используемого`);
        console.log(`      Env: ${botDbPathEnv}`);
        console.log(`      Used: ${BOT_DB_PATH}`);
      }
    } else {
      console.warn('   ⚠️  BOT_DATABASE_PATH не установлен');
      console.log(`   💡 Используется значение по умолчанию: ${BOT_DB_PATH}`);
    }

    // 7. Проверка API базы данных
    console.log('\n7️⃣ Проверка API базы данных...');
    if (fs.existsSync(API_DB_PATH)) {
      console.log(`   ✅ API база данных найдена: ${API_DB_PATH}`);
    } else {
      console.warn(`   ⚠️  API база данных не найдена: ${API_DB_PATH}`);
    }

    // Итоговый отчет
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 ИТОГОВЫЙ ОТЧЕТ:\n');

    if (allContests.length === 0) {
      console.log('❌ Критические проблемы:');
      console.log('   - Нет конкурсов в базе данных');
      console.log('   💡 Решение: Создайте конкурс с помощью create_contest.ts');
    } else if (!activeContest) {
      console.log('⚠️  Предупреждения:');
      console.log('   - Нет активного конкурса в данный момент');
      console.log('   💡 Проверьте даты начала и окончания конкурсов');
    } else {
      console.log('✅ Система конкурсов работает корректно!');
      console.log(`   Активный конкурс: ${activeContest.title}`);
    }

    if (!refEventsExists || !ticketLedgerExists) {
      console.log('\n⚠️  Дополнительная информация:');
      console.log('   - Некоторые таблицы еще не созданы');
      console.log('   💡 Это нормально, таблицы создадутся автоматически при первом использовании');
    }

  } catch (error: any) {
    console.error('\n❌ Ошибка при проверке:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    botDb.close();
  }
}

// Запускаем проверку
checkContest();
