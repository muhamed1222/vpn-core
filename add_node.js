
import axios from 'axios';

async function main() {
    const apiBase = 'https://vpn.outlivion.space/api';
    const username = 'outliviondev';
    const password = 'A246123b';

    try {
        console.log('Logging in...');
        const params = new URLSearchParams();
        params.append('username', username);
        params.append('password', password);

        const loginRes = await axios.post(`${apiBase}/admin/token`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const token = loginRes.data.access_token;
        console.log('Login successful.');

        console.log('Adding new node...');
        const createRes = await axios.post(`${apiBase}/node`, {
            name: "DE-Node-01",
            address: "89.19.212.151",
            port: 62050,
            api_port: 62051,
            usage_coefficient: 1
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('Node Created:', JSON.stringify(createRes.data, null, 2));

    } catch (err) {
        console.error('Error:', err.response?.data || err.message);
    }
}

main();
