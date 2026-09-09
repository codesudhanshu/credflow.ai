import type { FastifyPluginAsync } from 'fastify';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { UsageService } from '../../services/usage.service.js';
import { resolveRange, UsageQueryParams } from '../schemas/usage.schema.js';

export const usageRoutes: FastifyPluginAsync = async (app) => {
  const { clock, db } = app.deps;
  if (!db) throw new Error('usageRoutes requires a database connection');

  const cols = collections(db);
  const service = new UsageService(cols, new ApiKeysRepo(cols));

  app.get('/', async (req) => {
    const params = UsageQueryParams.parse(req.query);
    const range = resolveRange(params.from, params.to, clock.now());
    return service.report({
      apiKey: params.api_key,
      from: range.from,
      to: range.to,
      groupBy: params.group_by,
    });
  });
};
