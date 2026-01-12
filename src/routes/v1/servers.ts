import { FastifyInstance } from 'fastify';

interface Server {
  id: string;
  country_code: string;
  country_name: string;
  region: string;
  ping: number; // Средний пинг (заглушка)
  is_online: boolean;
}

const SERVERS: Server[] = [
  {
    id: 'nl-ams-01',
    country_code: 'NL',
    country_name: 'Нидерланды',
    region: 'Europe',
    ping: 45,
    is_online: true,
  },
  {
    id: 'de-fra-01',
    country_code: 'DE',
    country_name: 'Германия',
    region: 'Europe',
    ping: 52,
    is_online: true,
  },
  {
    id: 'us-nyc-01',
    country_code: 'US',
    country_name: 'США',
    region: 'Americas',
    ping: 110,
    is_online: true,
  },
  {
    id: 'tr-ist-01',
    country_code: 'TR',
    country_name: 'Турция',
    region: 'Asia',
    ping: 65,
    is_online: true,
  },
];

export async function serversRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    return {
      ok: true,
      servers: SERVERS,
    };
  });
}
