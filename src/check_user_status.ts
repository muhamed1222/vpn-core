// @ts-nocheck
import { MarzbanService } from './integrations/marzban/service.js';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(process.cwd(), '.env') });

const marzbanService = new MarzbanService(
    'https://vpn.outlivion.space', // Убираем /api, так как MarzbanClient добавляет /api сам
    'outliviondev',
    'A246123b',
    'https://vpn.outlivion.space',
    '/bot-api/sub'
);

async function check() {
    const tgId = 782245481;
    try {
        const status = await marzbanService.getUserStatus(tgId);
        console.log('User Status:', JSON.stringify(status, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

check();
