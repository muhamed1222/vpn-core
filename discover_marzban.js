
import axios from 'axios';

async function main() {
    const apiBase = 'https://vpn.outlivion.space/api';
    const username = 'outliviondev';
    const password = 'A246123b';

    const endpoints = [
        '/nodes/settings',
        '/nodes/usage',
        '/nodes/template',
        '/nodes/config',
        '/nodes/usage/details',
        '/admin/settings'
    ];

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

        for (const ep of endpoints) {
            try {
                process.stdout.write(`Testing ${ep}... `);
                const res = await axios.get(`${apiBase}${ep}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                console.log('SUCCESS');
                console.log(JSON.stringify(res.data, null, 2));
            } catch (err) {
                console.log(`FAILED (${err.response?.status || 'ERR'})`);
            }
        }

        // List nodes again to see if any info is there
        const nodesRes = await axios.get(`${apiBase}/nodes`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Nodes:', JSON.stringify(nodesRes.data, null, 2));

    } catch (err) {
        console.error('Error:', err.response?.data || err.message);
    }
}

main();
