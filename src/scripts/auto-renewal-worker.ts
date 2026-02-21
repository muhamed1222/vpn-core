import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { YooKassaClient } from '../integrations/yookassa/client.js';
import { MarzbanService } from '../integrations/marzban/service.js';
import axios from 'axios';
import { getPlanPrice } from '../config/plans.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { join } from 'path';
import cron from 'node-cron';

// Load config
const envPath = join(process.cwd(), '.env');
dotenv.config({ path: envPath });

import { getDatabase } from '../storage/db.js';
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
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const processedTgIds = new Set<string>();

        // 1. Prisma Sweep (Web DB)
        const expiringSubscriptions = await prisma.subscription.findMany({
            where: {
                status: 'ACTIVE',
                autoRenewEnabled: true,
                paymentMethodId: { not: null },
                currentPeriodEnd: { lte: tomorrow, gt: now }
            },
            include: { user: true }
        });

        console.log(`[AutoRenewalWorker] Found ${expiringSubscriptions.length} subscriptions due for renewal.`);

        for (const sub of expiringSubscriptions) {
            if (!sub.user.vpnTgId || !sub.paymentMethodId) continue;

            const tgId = sub.user.vpnTgId.toString();
            processedTgIds.add(tgId);
            const planId = sub.productId;
            const amount = getPlanPrice(planId);
            const newOrderId = uuidv4();

            console.log(`[AutoRenewalWorker] Attempting to charge ${amount.value} RUB for user ${tgId}, plan ${planId}`);

            try {
                const paymentParams: any = {
                    amount: {
                        value: amount.value,
                        currency: amount.currency
                    },
                    capture: true,
                    payment_method_id: sub.paymentMethodId,
                    description: `Автопродление подписки: Тариф ${planId}`,
                    receipt: {
                        customer: {
                            email: sub.user.email || `${tgId}@outlivion.space`,
                        },
                        items: [{
                            description: `VPN подписка — тариф ${planId}`,
                            quantity: '1.00',
                            amount: { value: amount.value, currency: amount.currency },
                            vat_code: 1, // 1 = без НДС
                            payment_subject: 'service',
                            payment_mode: 'full_payment',
                        }],
                    },
                    metadata: {
                        orderId: newOrderId,
                        autoRenew: 'true',
                        type: 'auto_renewal',
                        planId: planId,
                        tgId: tgId,
                        subscriptionId: sub.id
                    }
                };

                const payment = await yookassaClient.createPayment(paymentParams, newOrderId);

                if (payment.status === 'succeeded' || payment.status === 'pending') {
                    console.log(`[AutoRenewalWorker] Payment ${payment.id} initiated for ${tgId}. Status: ${payment.status}`);
                    await notifyUser(tgId, `🔄 Выполняется автопродление вашей подписки...\nСумма: ${amount.value} RUB`);

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

                await prisma.subscription.update({
                    where: { id: sub.id },
                    data: {
                        status: 'PAST_DUE',
                        lastRenewalError: chargeErr.message
                    }
                });

                await notifyUser(
                    tgId,
                    `⚠️ <b>Ошибка автопродления</b>\n\nНе удалось списать ${amount.value} RUB с вашей сохраненной карты. Статус подписки изменён на <b>PAST_DUE</b>.\n\nПожалуйста, оплатите подписку вручную, чтобы не потерять доступ!`
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

                    const nowMs = Date.now();
                    const tomorrowMs = nowMs + 24 * 60 * 60 * 1000;

                    const botSubsAll = db.prepare(`
                    SELECT ar.user_id, ar.plan_id, s.payment_method_id, s.expires_at
                    FROM bot_db.auto_renewals ar
                    JOIN bot_db.subscriptions s ON s.user_id = ar.user_id
                    WHERE ar.enabled = 1 
                      AND s.payment_method_id IS NOT NULL 
                      AND s.expires_at > ? 
                      AND s.expires_at < ?
                `).all(nowMs / 1000, tomorrowMs / 1000) as any[];

                    const botSubs = botSubsAll.filter((s: any) => !processedTgIds.has(s.user_id.toString()));

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
                                receipt: {
                                    customer: {
                                        email: `${tgId}@outlivion.space`
                                    },
                                    items: [{
                                        description: `VPN подписка — тариф ${planId}`,
                                        quantity: '1.00',
                                        amount: { value: amount.value, currency: amount.currency },
                                        vat_code: 1,
                                        payment_subject: 'service',
                                        payment_mode: 'full_payment',
                                    }],
                                },
                                metadata: {
                                    orderId: newOrderId,
                                    autoRenew: 'true',
                                    type: 'auto_renewal',
                                    planId: planId,
                                    tgId: tgId.toString(),
                                    subscriptionId: `bot_${tgId.toString()}`
                                }
                            };

                            await yookassaClient.createPayment(paymentParams, newOrderId);
                            await notifyUser(tgId, `🔄 Выполняется автопродление вашей подписки...\nСумма: ${amount.value} RUB`);
                        } catch (chargeErr: any) {
                            console.error(`[AutoRenewalWorker] [Bot] Charge failed for user ${tgId}:`, chargeErr.message);

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

export async function deactivateLapsedSubscriptions() {
    console.log('[AutoRenewalWorker] Starting deactivation sweep...');
    try {
        const gracePeriod = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days

        const lapsed = await prisma.subscription.findMany({
            where: {
                status: 'PAST_DUE',
                currentPeriodEnd: { lte: gracePeriod },
            },
            include: { user: true }
        });

        console.log(`[AutoRenewalWorker] Found ${lapsed.length} lapsed subscriptions due for deactivation.`);

        for (const sub of lapsed) {
            await prisma.subscription.update({
                where: { id: sub.id },
                data: { status: 'CANCELED' },
            });

            if (sub.user?.vpnTgId) {
                const tgId = Number(sub.user.vpnTgId);
                await marzbanService.deactivateUser(tgId);

                await notifyUser(
                    tgId,
                    `❌ <b>Подписка отменена</b>\n\nВаша подписка была отменена из-за отсутствия оплаты и истечения льготного периода.`
                );
            }
        }
    } catch (err) {
        console.error('[AutoRenewalWorker] Deactivation sweep error:', err);
    }
}

// Initialize cron jobs automatically when this module is imported
export function initWorker() {
    console.log('[AutoRenewalWorker] Initializing cron jobs...');

    // Every day at 10:00 UTC
    cron.schedule('0 10 * * *', async () => {
        await processAutoRenewals();
    });

    // Every day at 11:00 UTC for PAST_DUE -> CANCELED
    cron.schedule('0 11 * * *', async () => {
        await deactivateLapsedSubscriptions();
    });
}

// @ts-ignore
const isMain = typeof require !== 'undefined' && require.main === module;
if (isMain) {
    Promise.all([
        processAutoRenewals(),
        deactivateLapsedSubscriptions()
    ]).then(() => process.exit(0)).catch(() => process.exit(1));
}
