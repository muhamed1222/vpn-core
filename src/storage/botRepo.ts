import Database from 'better-sqlite3';
import * as fs from 'fs';

/**
 * Путь к базе данных бота
 */
export function getBotDbPath(): string {
    return process.env.BOT_DATABASE_PATH || '/root/vpn_bot/data/database.sqlite';
}

/**
 * Ленивый синглтон — отдельное соединение с базой бота.
 * Не использует ATTACH/DETACH на основном соединении, что исключает race condition.
 */
let _botDb: Database.Database | null = null;

function getBotDatabase(): Database.Database | null {
    const botDbPath = getBotDbPath();
    if (!fs.existsSync(botDbPath)) return null;

    if (!_botDb) {
        _botDb = new Database(botDbPath);
        _botDb.pragma('journal_mode = WAL');
    }
    return _botDb;
}

/**
 * Получить статус автопродления из базы бота
 */
export function getBotAutoRenewal(tgId: number) {
    const db = getBotDatabase();
    if (!db) return null;

    try {
        const row = db.prepare(`
            SELECT ar.enabled, ar.plan_id, s.payment_method_id
            FROM auto_renewals ar
            LEFT JOIN subscriptions s ON s.user_id = ar.user_id
            WHERE ar.user_id = ?
        `).get(tgId) as { enabled: number; plan_id: string; payment_method_id: string } | undefined;

        if (!row) return null;

        return {
            enabled: row.enabled === 1,
            planId: row.plan_id,
            paymentMethodId: row.payment_method_id
        };
    } catch (e) {
        return null;
    }
}

/**
 * Обновить статус автопродления в базе бота
 */
export function updateBotAutoRenewal(tgId: number, enabled: boolean) {
    const db = getBotDatabase();
    if (!db) return false;

    try {
        const exists = db.prepare('SELECT user_id FROM auto_renewals WHERE user_id = ?').get(tgId);

        if (exists) {
            db.prepare('UPDATE auto_renewals SET enabled = ? WHERE user_id = ?')
                .run(enabled ? 1 : 0, tgId);
        } else {
            const lastOrder = db.prepare(
                'SELECT plan_id FROM orders WHERE user_id = ? AND status = "COMPLETED" ORDER BY created_at DESC LIMIT 1'
            ).get(tgId) as { plan_id: string } | undefined;

            db.prepare('INSERT INTO auto_renewals (user_id, enabled, plan_id) VALUES (?, ?, ?)')
                .run(tgId, enabled ? 1 : 0, lastOrder?.plan_id || 'plan_30');
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Сохранить ID метода платежа в базу бота
 */
export function saveBotPaymentMethod(tgId: number, paymentMethodId: string) {
    const db = getBotDatabase();
    if (!db) return false;

    try {
        db.prepare('UPDATE subscriptions SET payment_method_id = ? WHERE user_id = ?')
            .run(paymentMethodId, tgId);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Продлить подписку в базе бота (для автопродления)
 */
export function extendBotSubscription(tgId: number, addDays: number) {
    const db = getBotDatabase();
    if (!db) return false;

    try {
        const sub = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id = ?').get(tgId) as { expires_at: number } | undefined;
        if (sub) {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const baseTime = sub.expires_at > nowSeconds ? sub.expires_at : nowSeconds;
            const newExpiresAt = baseTime + (addDays * 24 * 60 * 60);

            db.prepare('UPDATE subscriptions SET expires_at = ?, is_active = 1 WHERE user_id = ?')
                .run(newExpiresAt, tgId);
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Проверить, есть ли у пользователя оплаченные заказы в базе бота
 */
export function botHasPaidOrder(tgId: number): boolean {
    const db = getBotDatabase();
    if (!db) return false;

    try {
        const row = db.prepare(
            `SELECT 1 FROM orders WHERE user_id = ? AND status IN ('PAID', 'COMPLETED') LIMIT 1`
        ).get(tgId);
        return row !== undefined;
    } catch (e) {
        return false;
    }
}

/**
 * Получить процент скидки пользователя из базы бота
 */
export function getBotUserDiscount(tgId: number): number {
    const db = getBotDatabase();
    if (!db) return 0;

    try {
        const userRow = db.prepare(
            'SELECT discount_percent, discount_expires_at FROM users WHERE id = ?'
        ).get(tgId) as { discount_percent: number; discount_expires_at: number | null } | undefined;

        if (!userRow || !userRow.discount_percent) return 0;

        const now = Date.now();
        if (userRow.discount_expires_at && userRow.discount_expires_at <= now) return 0;

        return userRow.discount_percent;
    } catch (e) {
        return 0;
    }
}
