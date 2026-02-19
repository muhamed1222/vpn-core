import axios from 'axios';

export async function sendNewDeviceNotification(tgId: number, deviceName: string, ip: string, country: string | null, platform: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn('[Notification] No bot token provided');
        return;
    }

    const message = `
🔔 <b>Новое устройство подключено</b>

📱 <b>Устройство:</b> ${deviceName}
💻 <b>Платформа:</b> ${platform}
🌐 <b>IP:</b> ${ip}
🌍 <b>Страна:</b> ${country || 'Неизвестно'}
⏰ <b>Время:</b> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}

Если это не вы, зайдите в личный кабинет и отключите устройство.
  `.trim();

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: tgId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        console.error('[Notification] Failed to send TG notification', e.message);
    }
}
