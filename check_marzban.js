
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

        console.log('Getting nodes...');
        const nodesRes = await axios.get(`${apiBase}/nodes`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('Current Nodes:', JSON.stringify(nodesRes.data, null, 2));

        // Let's also try to get settings (certificate for new nodes)
        try {
            const settingsRes = await axios.get(`${apiBase}/nodes/settings`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log('Node Settings (Certificate):', JSON.stringify(settingsRes.data, null, 2));
        } catch (err) {
            console.log('Failed to get nodes settings. Maybe different path?');
        }

    } catch (err) {
        console.error('Error:', err.response?.data || err.message);
    }
}

main();
