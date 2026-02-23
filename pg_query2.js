const { Client } = require('pg');

async function main() {
    const client = new Client({
        connectionString: 'postgresql://outlivion:outlivion@localhost:5433/outlivion?schema=public'
    });

    await client.connect();

    const res = await client.query(`
    SELECT "vpnTgId", "email", "amountMinor", "createdAt", "status", o.id as orderId
    FROM "Payment" p
    JOIN "Order" o ON p."orderId" = o.id
    WHERE p."amountMinor" = 9900
    AND p."createdAt" > '2026-02-15' AND p."createdAt" < '2026-02-17'
    ORDER BY p."createdAt" ASC
  `);

    console.log("Postgres Payments for 99 RUB between Feb 15 and Feb 17:", res.rows);

    // Let's also check Order directly just in case (totalMinor = 9900 or 99)
    const res2 = await client.query(`
    SELECT "vpnTgId", "email", "totalMinor", "createdAt", "status", id
    FROM "Order"
    WHERE "totalMinor" IN (99, 9900)
    AND "createdAt" > '2026-02-15' AND "createdAt" < '2026-02-17'
    ORDER BY "createdAt" ASC
  `);
    console.log("Postgres Orders for 99 RUB between Feb 15 and Feb 17:", res2.rows);

    await client.end();
}

main().catch(console.error);
