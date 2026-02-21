// @ts-nocheck
import { MarzbanService } from './integrations/marzban/service.js';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(process.cwd(), '.env') });

const marzbanService = new MarzbanService(
    'https://vpn.outlivion.space',
    'outliviondev',
    'A246123b',
    'https://vpn.outlivion.space',
    '/bot-api/sub'
);

async function fix() {
    const tgId = 782245481;
    const days = 30;
    const now = Math.floor(Date.now() / 1000);
    const newExpire = now + (days * 86400);

    try {
        console.log(`Fixing user ${tgId}...`);
        const status = await marzbanService.getUserStatus(tgId);
        if (!status) {
            console.error('User not found');
            return;
        }

        console.log(`Current expire: ${new Date(status.expire * 1000).toLocaleString()}`);

        // We update manually because renewUser adds days to existing (which is 2033)
        const result = await marzbanService.client.updateUser(status.username, {
            expire: newExpire,
            status: 'active'
        });

        console.log(`Fixed! New expire: ${new Date(result.expire * 1000).toLocaleString()}`);

    } catch (e) {
        console.error('Error:', e.message);
    }
}

fix();
