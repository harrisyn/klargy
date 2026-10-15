import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { scope, org, dataSource, fieldMapping } from '../middleware/tenantScope.middleware';
import {
  getDataSources,
  getDataSource,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  testDataSource,
  getFieldMappings,
  createFieldMapping,
  updateFieldMapping,
  deleteFieldMapping,
  fetchFromDataSource,
} from '../controllers/datasource.controller';

const router = Router();

// Mounted at '/', so auth is per route: a router-level use() here would run
// for every request that reaches this router, including unrelated paths.

// Data source routes mounted under /orgs/:organizationId/data-sources
// Desk staff list them too (names only) to offer "Look up in ..." on a ticket.
router.get('/orgs/:organizationId/data-sources', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'), scope(org('params.organizationId')), getDataSources);
router.post('/orgs/:organizationId/data-sources', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(org('params.organizationId')), createDataSource);

// Individual data source routes
router.get('/data-sources/:id', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.id')), getDataSource);
router.put('/data-sources/:id', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.id')), updateDataSource);
router.delete('/data-sources/:id', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.id')), deleteDataSource);
router.post('/data-sources/:id/test', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.id')), testDataSource);
router.post('/data-sources/:id/fetch', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN', 'LOCATION_ADMIN', 'SERVICE_STAFF', 'RECEPTIONIST'), scope(dataSource('params.id')), fetchFromDataSource);

// Field mapping routes
router.get('/data-sources/:dataSourceId/mappings', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.dataSourceId')), getFieldMappings);
router.post('/data-sources/:dataSourceId/mappings', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(dataSource('params.dataSourceId')), createFieldMapping);
router.put('/field-mappings/:id', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(fieldMapping('params.id')), updateFieldMapping);
router.delete('/field-mappings/:id', authenticate, authorize('ORG_ADMIN', 'SUPER_ADMIN'), scope(fieldMapping('params.id')), deleteFieldMapping);

export default router;
