import { Router } from 'express';
import type { Db } from 'mongodb';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { UsageService } from '../../services/usage.service.js';
import type { AppDeps } from '../deps.js';
import { resolveRange, UsageQueryParams } from '../schemas/usage.schema.js';

export function createUsageRoutes(deps: AppDeps, db: Db): Router {
  const { clock } = deps;
  const cols = collections(db);
  const service = new UsageService(cols, new ApiKeysRepo(cols));

  const router = Router();

  router.get('/', async (req, res) => {
    const params = UsageQueryParams.parse(req.query);
    const range = resolveRange(params.from, params.to, clock.now());
    const report = await service.report({
      apiKey: params.api_key,
      from: range.from,
      to: range.to,
      groupBy: params.group_by,
    });
    res.json(report);
  });

  return router;
}
