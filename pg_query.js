const { Client } = require('pg');

async function main() {
    const client = new Client({
        connectionString: 'postgresql://outlivion:outlivion@localhost:5433/outlivion?schema=public'
    });

    await client.connect();

    const res = await client.query('SELECT * FROM "User" WHERE "vpnTgId" = $1', [7369165195]);
    const user = res.rows[0];

    if (!user) {
        console.log("No user found in Postgres.");
    } else {
        console.log("User:", user);
        const subs = await client.query('SELECT * FROM "Subscription" WHERE "userId" = $1', [user.id]);
        console.log("Subscriptions:", subs.rows);
        const orders = await client.query('SELECT * FROM "Order" WHERE "vpnTgId" = $1', [7369165195]);
        console.log("Orders:", orders.rows);
    }

    await client.end();
}

main().catch(console.error);
