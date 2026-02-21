const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');
import { YooKassaClient } from '../integrations/yookassa/client.js';
import { MarzbanService } from '../integrations/marzban/service.js';
import axios from 'axios';
import { getPlanPrice } from '../config/plans.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { join } from 'path';

// Load config
const envPath = join(process.cwd(), '.env');
dotenv.config({ path: envPath });

import { getDatabase, initDatabase } from '../storage/db.js';
import * as fs from 'fs';
import { getBotDbPath } from '../storage/botRepo.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const yookassaClient = new YooKassaClient({
    shopId: process.env.YOOKASSA_SHOP_ID || '',
    secretKey: process.env.YOOKASSA_SECRET_KEY || '',
});

const marzbanService = new MarzbanService(
    process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000',
    process.env.MARZBAN_ADMIN_USERNAME || '',
    process.env.MARZBAN_ADMIN_PASSWORD || '',
    process.env.MARZBAN_PUBLIC_URL || 'https://vpn.outlivion.space',
    process.env.SUBSCRIPTION_PROXY_PATH || ''
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

async function notifyUser(tgId: string | number, message: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: tgId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (err: any) {
        console.error(`Failed to notify user ${tgId}:`, err.message);
    }
}

export async function processAutoRenewals() {
    console.log('[AutoRenewalWorker] Starting renewal sweep...');

    try {
        // 1. Find all active subscriptions with auto-renewal enabled and a saved payment method
        // that are expiring in the next 24 hours.
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const expiringSubscriptions = await prisma.subscription.findMany({
            where: {
                status: 'ACTIVE',
                autoRenewEnabled: true,
                paymentMethodId: { not: null },
                currentPeriodEnd: { lte: tomorrow, gt: now } // Expiring between now and 24h from now
            },
            include: { user: true }
        });

        console.log(`[AutoRenewalWorker] Found ${expiringSubscriptions.length} subscriptions due for renewal.`);

        for (const sub of expiringSubscriptions) {
            if (!sub.user.vpnTgId || !sub.paymentMethodId) continue;

            const tgId = sub.user.vpnTgId.toString();
            const planId = sub.productId;
            const amount = getPlanPrice(planId);
            const newOrderId = uuidv4();

            console.log(`[AutoRenewalWorker] Attempting to charge ${amount.value} RUB for user ${tgId}, plan ${planId}`);

            try {
                // 2. Request Yookassa to process a recurring payment using the saved `payment_method_id`
                const paymentParams: any = {
                    amount: {
                        value: amount.value,
                        currency: amount.currency
                    },
                    capture: true,
                    payment_method_id: sub.paymentMethodId,
                    description: `Автопродление подписки: Тариф ${planId}`,
                    metadata: {
                        orderId: newOrderId,
                        autoRenew: 'true',
                        planId: planId,
                        tgId: tgId
                    }
                };

                const payment = await yookassaClient.createPayment(paymentParams, newOrderId);

                // If the payment is immediately pending or succeeded, we consider it initiated successfully
                if (payment.status === 'succeeded' || payment.status === 'pending') {
                    console.log(`[AutoRenewalWorker] Payment ${payment.id} initiated for ${tgId}. Status: ${payment.status}`);

                    // Note: The actual Marzban extension and DB update will typically happen 
                    // via the Webhook (payments.ts) once 'payment.succeeded' is received.
                    // We just need to make sure the user knows it's happening.

                    await notifyUser(tgId, `🔄 Выполняется автопродление вашей подписки...\nСумма: ${amount.value} RUB`);

                    // Reset any previous errors
                    if (sub.lastRenewalError) {
                        await prisma.subscription.update({
                            where: { id: sub.id },
                            data: { lastRenewalError: null }
                        });
                    }
                } else {
                    throw new Error(`Unexpected payment status: ${payment.status}`);
                }

            } catch (chargeErr: any) {
                console.error(`[AutoRenewalWorker] Charge failed for sub ${sub.id}:`, chargeErr.message);

                // 3. Update the database on failure and notify the user to update their card
                await prisma.subscription.update({
                    where: { id: sub.id },
                    data: {
                        autoRenewEnabled: false, // Turn it off so we don't spam failed charges
                        lastRenewalError: chargeErr.message
                    }
                });

                await notifyUser(
                    tgId,
                    `⚠️ <b>Ошибка автопродления</b>\n\nНе удалось списать ${amount.value} RUB с вашей сохраненной карты. Автопродление <b>ОТКЛЮЧЕНО</b>.\n\nПожалуйста, оплатите подписку вручную, чтобы не потерять доступ!`
                );
            }
        }

        // 2. SWEEP SQLITE (Bot database)
        try {
            const botDbPath = getBotDbPath();
            if (fs.existsSync(botDbPath)) {
                console.log(`[AutoRenewalWorker] Sweeping SQLite bot DB: ${botDbPath}`);
                const db = getDatabase();
                try {
                    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);

                    // Find users with auto-renewal enabled and card saved in SQLite
                    // and expiring in next 24h
                    const nowMs = Date.now();
                    const tomorrowMs = nowMs + 24 * 60 * 60 * 1000;

                    const botSubs = db.prepare(`
                    SELECT ar.user_id, ar.plan_id, s.payment_method_id, s.expires_at
                    FROM bot_db.auto_renewals ar
                    JOIN bot_db.subscriptions s ON s.user_id = ar.user_id
                    WHERE ar.enabled = 1 
                      AND s.payment_method_id IS NOT NULL 
                      AND s.expires_at > ? 
                      AND s.expires_at < ?
                `).all(nowMs / 1000, tomorrowMs / 1000) as any[];

                    console.log(`[AutoRenewalWorker] Found ${botSubs.length} bot subscriptions due for renewal.`);

                    for (const sub of botSubs) {
                        const tgId = sub.user_id;
                        const planId = sub.plan_id || 'plan_30';
                        const amount = getPlanPrice(planId);
                        const newOrderId = uuidv4();

                        console.log(`[AutoRenewalWorker] [Bot] Charging ${amount.value} RUB for user ${tgId}, plan ${planId}`);

                        try {
                            const paymentParams: any = {
                                amount: { value: amount.value, currency: amount.currency },
                                capture: true,
                                payment_method_id: sub.payment_method_id,
                                description: `Автопродление подписки: Тариф ${planId}`,
                                metadata: {
                                    orderId: newOrderId,
                                    autoRenew: 'true',
                                    planId: planId,
                                    tgId: tgId.toString()
                                }
                            };

                            await yookassaClient.createPayment(paymentParams, newOrderId);
                            await notifyUser(tgId, `🔄 Выполняется автопродление вашей подписки...\nСумма: ${amount.value} RUB`);
                        } catch (chargeErr: any) {
                            console.error(`[AutoRenewalWorker] [Bot] Charge failed for user ${tgId}:`, chargeErr.message);

                            // Disable auto-renewal on failure
                            db.prepare('UPDATE bot_db.auto_renewals SET enabled = 0 WHERE user_id = ?').run(tgId);

                            await notifyUser(
                                tgId,
                                `⚠️ <b>Ошибка автопродления</b>\n\nНе удалось списать ${amount.value} RUB с вашей сохраненной карты. Автопродление <b>ОТКЛЮЧЕНО</b>.\n\nПожалуйста, оплатите подписку вручную!`
                            );
                        }
                    }

                    db.prepare('DETACH DATABASE bot_db').run();
                } catch (sqErr: any) {
                    console.error('[AutoRenewalWorker] SQLite sweep error:', sqErr.message);
                    try { db.prepare('DETACH DATABASE bot_db').run(); } catch (e) { }
                }
            }
        } catch (botErr: any) {
            console.error('[AutoRenewalWorker] Bot DB sweep error:', botErr.message);
        }
    } catch (error) {
        console.error('[AutoRenewalWorker] Global error during renewal sweep:', error);
    }
}

// If file is called directly (e.g. via cron script)
if (require.main === module) {
    processAutoRenewals().then(() => process.exit(0)).catch(() => process.exit(1));
}
