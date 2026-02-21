// @ts-nocheck
import { MarzbanService } from './integrations/marzban/service.js';
import dotenv from 'dotenv';
import { join } from 'path';
import axios from 'axios';

dotenv.config({ path: join(process.cwd(), '.env') });

const MARZBAN_URL = 'https://vpn.outlivion.space';
const USERNAME = 'outliviondev';
const PASSWORD = 'A246123b';

async function getToken() {
    const params = new URLSearchParams();
    params.append('username', USERNAME);
    params.append('password', PASSWORD);
    const response = await axios.post(`${MARZBAN_URL}/api/admin/token`, params);
    return response.data.access_token;
}

async function findAnomalies() {
    try {
        const token = await getToken();
        const response = await axios.get(`${MARZBAN_URL}/api/users`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const users = response.data.users;
        const now = Math.floor(Date.now() / 1000);
        const tenYearsFromNow = now + 10 * 365 * 86400;
        const year2030 = Math.floor(new Date('2030-01-01').getTime() / 1000);

        const anomalies = users.filter(u => u.expire && u.expire > year2030);

        console.log(`Total users: ${users.length}`);
        console.log(`Anomalies found: ${anomalies.length}`);

        anomalies.forEach(a => {
            console.log(`User: ${a.username}, Expire: ${new Date(a.expire * 1000).toLocaleString()} (${a.expire})`);
        });

    } catch (e) {
        console.error('Error:', e.message);
    }
}

findAnomalies();
