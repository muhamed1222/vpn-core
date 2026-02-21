// @ts-nocheck
import axios from 'axios';
import dotenv from 'dotenv';
import { join } from 'path';

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

async function checkAll() {
    try {
        const token = await getToken();
        const response = await axios.get(`${MARZBAN_URL}/api/users`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const users = response.data.users;
        const stats = {
            total: users.length,
            active: 0,
            expired: 0,
            unlimited: 0,
            anomalies: 0
        };

        const now = Math.floor(Date.now() / 1000);
        const year2030 = Math.floor(new Date('2030-01-01').getTime() / 1000);

        users.forEach(u => {
            if (!u.expire) stats.unlimited++;
            else if (u.expire > year2030) stats.anomalies++;
            else if (u.expire < now) stats.expired++;
            else stats.active++;
        });

        console.log('Statistics:', JSON.stringify(stats, null, 2));

    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkAll();
