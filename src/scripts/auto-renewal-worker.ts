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

    } catch (error) {
        console.error('[AutoRenewalWorker] Global error during renewal sweep:', error);
    }
}

// If file is called directly (e.g. via cron script)
if (require.main === module) {
    processAutoRenewals().then(() => process.exit(0)).catch(() => process.exit(1));
}
