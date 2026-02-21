// @ts-nocheck
import axios from 'axios';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(process.cwd(), '.env') });

const MARZBAN_URL = 'https://vpn.outlivion.space';

async function getToken() {
    const params = new URLSearchParams();
    params.append('username', 'outliviondev');
    params.append('password', 'A246123b');
    const response = await axios.post(`${MARZBAN_URL}/api/admin/token`, params);
    return response.data.access_token;
}

async function checkOldest() {
    try {
        const token = await getToken();
        const response = await axios.get(`${MARZBAN_URL}/api/users`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const users = response.data.users.filter(u => u.expire);
        users.sort((a, b) => a.expire - b.expire);

        console.log('Oldest 5:');
        users.slice(0, 5).forEach(u => {
            console.log(`User: ${u.username}, Expire: ${new Date(u.expire * 1000).toLocaleString()}`);
        });

    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkOldest();
