import { FastifyInstance } from 'fastify';

export async function rootRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    return {
      ok: true,
      service: 'VPN API',
    };
  });
}

