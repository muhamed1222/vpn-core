import { getDatabase } from './db.js';
import * as fs from 'fs';
import path from 'path';

/**
 * Путь к базе данных бота
 */
export function getBotDbPath(): string {
    return process.env.BOT_DATABASE_PATH || '/root/vpn_bot/data/database.sqlite';
}

/**
 * Получить статус автопродления из базы бота
 */
export function getBotAutoRenewal(tgId: number) {
    const db = getDatabase();
    const botDbPath = getBotDbPath();

    if (!fs.existsSync(botDbPath)) return null;

    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

        const row = db.prepare(`
      SELECT ar.enabled, ar.plan_id, s.payment_method_id
      FROM bot_db.auto_renewals ar
      LEFT JOIN bot_db.subscriptions s ON s.user_id = ar.user_id
      WHERE ar.user_id = ?
    `).get(tgId) as { enabled: number; plan_id: string; payment_method_id: string } | undefined;

        db.prepare('DETACH DATABASE bot_db').run();

        if (!row) return null;

        return {
            enabled: row.enabled === 1,
            planId: row.plan_id,
            paymentMethodId: row.payment_method_id
        };
    } catch (e) {
        try { db.prepare('DETACH DATABASE bot_db').run(); } catch (de) { }
        return null;
    }
}

/**
 * Обновить статус автопродления в базе бота
 */
export function updateBotAutoRenewal(tgId: number, enabled: boolean) {
    const db = getDatabase();
    const botDbPath = getBotDbPath();

    if (!fs.existsSync(botDbPath)) return false;

    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

        // Проверяем наличие записи
        const exists = db.prepare('SELECT user_id FROM bot_db.auto_renewals WHERE user_id = ?').get(tgId);

        if (exists) {
            db.prepare('UPDATE bot_db.auto_renewals SET enabled = ? WHERE user_id = ?')
                .run(enabled ? 1 : 0, tgId);
        } else {
            // Если нет записи в auto_renewals, создаем её (план возьмем из последнего заказа)
            const lastOrder = db.prepare('SELECT plan_id FROM bot_db.orders WHERE user_id = ? AND status = "COMPLETED" ORDER BY created_at DESC LIMIT 1').get(tgId) as { plan_id: string } | undefined;

            db.prepare('INSERT INTO bot_db.auto_renewals (user_id, enabled, plan_id) VALUES (?, ?, ?)')
                .run(tgId, enabled ? 1 : 0, lastOrder?.plan_id || 'plan_30');
        }

        db.prepare('DETACH DATABASE bot_db').run();
        return true;
    } catch (e) {
        try { db.prepare('DETACH DATABASE bot_db').run(); } catch (de) { }
        return false;
    }
}

/**
 * Сохранить ID метода платежа в базу бота
 */
export function saveBotPaymentMethod(tgId: number, paymentMethodId: string) {
    const db = getDatabase();
    const botDbPath = getBotDbPath();

    if (!fs.existsSync(botDbPath)) return false;

    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

        db.prepare('UPDATE bot_db.subscriptions SET payment_method_id = ? WHERE user_id = ?')
            .run(paymentMethodId, tgId);

        db.prepare('DETACH DATABASE bot_db').run();
        return true;
    } catch (e) {
        try { db.prepare('DETACH DATABASE bot_db').run(); } catch (de) { }
        return false;
    }
}

/**
 * Продлить подписку в базе бота (для автопродления)
 */
export function extendBotSubscription(tgId: number, addDays: number) {
    const db = getDatabase();
    const botDbPath = getBotDbPath();

    if (!fs.existsSync(botDbPath)) return false;

    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

        const sub = db.prepare('SELECT expires_at FROM bot_db.subscriptions WHERE user_id = ?').get(tgId) as { expires_at: number } | undefined;
        if (sub) {
            // Если подписка уже истекла, считаем от текущего времени, иначе прибавляем к expires_at
            const nowSeconds = Math.floor(Date.now() / 1000);
            const baseTime = sub.expires_at > nowSeconds ? sub.expires_at : nowSeconds;
            const newExpiresAt = baseTime + (addDays * 24 * 60 * 60);

            db.prepare('UPDATE bot_db.subscriptions SET expires_at = ?, is_active = 1 WHERE user_id = ?')
                .run(newExpiresAt, tgId);
        }

        db.prepare('DETACH DATABASE bot_db').run();
        return true;
    } catch (e) {
        try { db.prepare('DETACH DATABASE bot_db').run(); } catch (de) { }
        return false;
    }
}
