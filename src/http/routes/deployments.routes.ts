import type { FastifyPluginAsync } from 'fastify';
import { collections } from '../../db/collections.js';
import { ApiKeysRepo } from '../../repositories/apiKeys.repo.js';
import { DeploymentsRepo } from '../../repositories/deployments.repo.js';
import { DeploymentsService } from '../../services/deployments.service.js';
import { resolveTenantId } from '../../services/tenants.service.js';
import {
  CreateDeploymentBody,
  DeploymentIdParams,
  serializeDeployment,
} from '../schemas/deployments.schema.js';

export const deploymentRoutes: FastifyPluginAsync = async (app) => {
  const { env, clock, db } = app.deps;
  if (!db) throw new Error('deploymentRoutes requires a database connection');

  const cols = collections(db);
  const service = new DeploymentsService(
    new DeploymentsRepo(cols),
    new ApiKeysRepo(cols),
    clock,
    env,
  );

  app.post('/', async (req, reply) => {
    const { model } = CreateDeploymentBody.parse(req.body);
    const tenantId = await resolveTenantId(
      cols,
      env,
      typeof req.headers['x-account-key'] === 'string'
        ? req.headers['x-account-key']
        : undefined,
    );
    const deployment = await service.create(tenantId, model);
    void reply.code(201);
    return { deployment_id: deployment._id, status: deployment.status };
  });

  app.get('/:id', async (req) => {
    const { id } = DeploymentIdParams.parse(req.params);
    const { deployment, apiKey } = await service.get(id);
    return serializeDeployment(deployment, apiKey);
  });

  app.delete('/:id', async (req) => {
    const { id } = DeploymentIdParams.parse(req.params);
    const deployment = await service.terminate(id);
    return serializeDeployment(deployment, null);
  });
};
