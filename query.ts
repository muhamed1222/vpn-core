import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const user = await prisma.user.findUnique({
        where: { vpnTgId: 7369165195n },
        include: { subscriptions: true, orders: true }
    });

    console.log('--- POSTGRES DB USER ---');
    if (user) {
        console.log(JSON.stringify(user, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    } else {
        console.log('Not found in Postgres');
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
