import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  if (db) {
    return db;
  }

  // Создаем директорию для базы данных, если её нет
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Открываем базу данных
  db = new Database(dbPath);

  // Включаем foreign keys
  db.pragma('foreign_keys = ON');

  // Выполняем миграции
  runMigrations(db);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database: Database.Database): void {
  // Создаем таблицу orders
  database.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_ref TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL,
      yookassa_payment_id TEXT,
      amount_value TEXT,
      amount_currency TEXT,
      key TEXT,
      bonus_days INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Добавляем колонку bonus_days, если её нет (для существующих баз)
  try {
    database.prepare("ALTER TABLE orders ADD COLUMN bonus_days INTEGER DEFAULT 0").run();
  } catch (e) {
    // Игнорируем ошибку, если колонка уже существует
  }

  // Создаем таблицу payment_events
  database.exec(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yookassa_event_id TEXT UNIQUE,
      yookassa_payment_id TEXT NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Создаем таблицу vpn_keys для стабильного хранения ключей
  database.exec(`
    CREATE TABLE IF NOT EXISTS vpn_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_ref TEXT NOT NULL,
      marzban_username TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      is_active INTEGER DEFAULT 1
    )
  `);

  // Создаем индексы для производительности
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_yookassa_payment_id ON orders(yookassa_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_yookassa_payment_id ON payment_events(yookassa_payment_id);
    CREATE INDEX IF NOT EXISTS idx_vpn_keys_user_ref ON vpn_keys(user_ref);
    CREATE INDEX IF NOT EXISTS idx_vpn_keys_active ON vpn_keys(user_ref, is_active);
  `);
}

