import { Router } from 'express';
import type { Db } from 'mongodb';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { DeploymentsRepo } from '../../repositories/deployments.repo.js';
import { DeploymentsService } from '../../services/deployments.service.js';
import { resolveTenantId } from '../../services/tenants.service.js';
import type { AppDeps } from '../deps.js';
import { singleHeader } from '../headers.js';
import {
  CreateDeploymentBody,
  DeploymentIdParams,
  serializeDeployment,
} from '../schemas/deployments.schema.js';

/**
 * Handlers only parse, delegate and serialize. Anything that can fail throws;
 * Express 5 forwards a rejected promise to the error handler, so there is no
 * try/catch and no next(err) here.
 */
export function createDeploymentRoutes(deps: AppDeps, db: Db): Router {
  const { env, clock } = deps;
  const cols = collections(db);
  const service = new DeploymentsService(
    new DeploymentsRepo(cols),
    new ApiKeysRepo(cols),
    clock,
    env,
  );

  const router = Router();

  router.post('/', async (req, res) => {
    const { model } = CreateDeploymentBody.parse(req.body);
    const tenantId = await resolveTenantId(
      cols,
      env,
      singleHeader(req.headers['x-account-key']),
    );
    const deployment = await service.create(tenantId, model);
    res.status(201).json({ deployment_id: deployment._id, status: deployment.status });
  });

  router.get('/:id', async (req, res) => {
    const { id } = DeploymentIdParams.parse(req.params);
    const { deployment, apiKey } = await service.get(id);
    res.json(serializeDeployment(deployment, apiKey));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = DeploymentIdParams.parse(req.params);
    const deployment = await service.terminate(id);
    res.json(serializeDeployment(deployment, null));
  });

  return router;
}
