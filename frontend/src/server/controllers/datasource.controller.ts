import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { DataSourceType } from '@prisma/client';
import { assertPublicUrl } from '../lib/urlSafety';
import { sealConfig, openConfig, redactDataSource } from '../lib/dataSourceSecrets';
import {
  LOOKUP_IDENTIFIER_TYPES,
  LookupError,
  LookupIdentifierType,
  locationRefFor,
  lookupIntegrationFor,
  lookupPatient,
} from '../services/connectLookup.service';

// INTEGRATION sources belong to an EMR connection (Klargy Connect): it
// creates, updates and switches them off, never this API.
const MANAGED_TYPE = 'INTEGRATION';
const managedRefusal = { error: 'Connected-system lookups are set up by the EMR connection, not here.' };

// Get all data sources for an organization
export const getDataSources = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.params;

    const dataSources = await prisma.dataSource.findMany({
      where: { organizationId },
      include: {
        fieldMappings: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Desk staff only need to know what they can look people up in.
    if (!['ORG_ADMIN', 'SUPER_ADMIN'].includes(req.user?.role ?? '')) {
      return res.json(dataSources.map(({ id, name, type, isActive }) => ({ id, name, type, isActive })));
    }
    res.json(dataSources.map(redactDataSource));
  } catch (error) {
    next(error);
  }
};

// Get a single data source
export const getDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
      include: {
        fieldMappings: true,
        organization: {
          select: { id: true, name: true },
        },
      },
    });

    if (!dataSource) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    res.json(redactDataSource(dataSource));
  } catch (error) {
    next(error);
  }
};

// Create a new data source
export const createDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.params;
    const { name, description, type, config, isActive } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    if (!Object.values(DataSourceType).includes(type)) {
      return res.status(400).json({ 
        error: `Invalid type. Must be one of: ${Object.values(DataSourceType).join(', ')}` 
      });
    }
    if (type === MANAGED_TYPE) return res.status(400).json(managedRefusal);

    const dataSource = await prisma.dataSource.create({
      data: {
        organizationId,
        name,
        description,
        type: type as DataSourceType,
        config: sealConfig(config || {}),
        isActive: isActive !== false,
      },
      include: {
        fieldMappings: true,
      },
    });

    res.status(201).json(redactDataSource(dataSource));
  } catch (error) {
    next(error);
  }
};

// Update a data source
export const updateDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, description, type, config, isActive } = req.body;

    const existing = await prisma.dataSource.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    if (type && !Object.values(DataSourceType).includes(type)) {
      return res.status(400).json({ 
        error: `Invalid type. Must be one of: ${Object.values(DataSourceType).join(', ')}` 
      });
    }
    if ((type && type !== existing.type && (type === MANAGED_TYPE || existing.type === MANAGED_TYPE)) || (existing.type === MANAGED_TYPE && config)) {
      return res.status(400).json(managedRefusal);
    }

    const dataSource = await prisma.dataSource.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(type && { type: type as DataSourceType }),
        ...(config && { config: sealConfig(config, existing.config) }),
        ...(isActive !== undefined && { isActive }),
      },
      include: {
        fieldMappings: true,
      },
    });

    res.json(redactDataSource(dataSource));
  } catch (error) {
    next(error);
  }
};

// Delete a data source
export const deleteDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.dataSource.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    await prisma.dataSource.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// Test a data source connection
export const testDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const testParams = req.body;

    const dataSource = await prisma.dataSource.findUnique({ where: { id } });
    if (!dataSource) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const config = openConfig(dataSource.config) as Record<string, unknown>;
    let testResult: { success: boolean; message: string; data?: unknown };

    switch (dataSource.type) {
      case 'API':
        testResult = await testApiDataSource(config, testParams);
        break;
      case 'DATABASE':
        testResult = { success: false, message: 'Database connection testing not yet implemented' };
        break;
      case 'WEBHOOK':
        testResult = { success: true, message: 'Webhook endpoint is ready to receive data' };
        break;
      case 'INTEGRATION': {
        const integration = await lookupIntegrationFor(dataSource.organizationId, integrationIdOf(config));
        testResult = integration
          ? { success: true, message: `Lookups go to ${integration.name}.` }
          : { success: false, message: 'The EMR connection is switched off or has no lookup address.' };
        break;
      }
      default:
        testResult = { success: false, message: 'Unknown data source type' };
    }

    res.json(testResult);
  } catch (error) {
    next(error);
  }
};

// Helper to test API data sources
async function testApiDataSource(
  config: Record<string, unknown>, 
  testParams: Record<string, unknown>
): Promise<{ success: boolean; message: string; data?: unknown }> {
  try {
    const url = config.url as string;
    if (!url) {
      return { success: false, message: 'API URL not configured' };
    }

    const headers: Record<string, string> = {};
    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    // Add auth if configured
    if (config.auth) {
      const auth = config.auth as Record<string, string>;
      if (auth.type === 'bearer' && auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      } else if (auth.type === 'basic' && auth.username && auth.password) {
        const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      } else if (auth.type === 'apiKey' && auth.headerName && auth.apiKey) {
        headers[auth.headerName] = auth.apiKey;
      }
    }

    // Make test request
    const testUrl = testParams.testEndpoint 
      ? `${url}${testParams.testEndpoint}` 
      : url;

    const response = await fetch((await assertPublicUrl(testUrl)).toString(), {
      method: 'GET',
      headers,
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      return { 
        success: true, 
        message: `Connection successful (HTTP ${response.status})`,
        data: data ? (Array.isArray(data) ? data.slice(0, 3) : data) : undefined,
      };
    } else {
      return { 
        success: false, 
        message: `Connection failed (HTTP ${response.status}: ${response.statusText})` 
      };
    }
  } catch (error: any) {
    return { 
      success: false, 
      message: `Connection error: ${error.message || 'Unknown error'}` 
    };
  }
}

// Field Mappings

// Get field mappings for a data source
export const getFieldMappings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dataSourceId } = req.params;

    const mappings = await prisma.fieldMapping.findMany({
      where: { dataSourceId },
      orderBy: { createdAt: 'asc' },
    });

    res.json(mappings);
  } catch (error) {
    next(error);
  }
};

// Create a field mapping
export const createFieldMapping = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dataSourceId } = req.params;
    const { sourcePath, targetField, transform } = req.body;

    if (!sourcePath || !targetField) {
      return res.status(400).json({ error: 'sourcePath and targetField are required' });
    }

    // Verify data source exists
    const dataSource = await prisma.dataSource.findUnique({ where: { id: dataSourceId } });
    if (!dataSource) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    const mapping = await prisma.fieldMapping.create({
      data: {
        dataSourceId,
        sourcePath,
        targetField,
        transform,
      },
    });

    res.status(201).json(mapping);
  } catch (error) {
    next(error);
  }
};

// Update a field mapping
export const updateFieldMapping = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { sourcePath, targetField, transform } = req.body;

    const existing = await prisma.fieldMapping.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Field mapping not found' });
    }

    const mapping = await prisma.fieldMapping.update({
      where: { id },
      data: {
        ...(sourcePath && { sourcePath }),
        ...(targetField && { targetField }),
        ...(transform !== undefined && { transform }),
      },
    });

    res.json(mapping);
  } catch (error) {
    next(error);
  }
};

// Delete a field mapping
export const deleteFieldMapping = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.fieldMapping.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Field mapping not found' });
    }

    await prisma.fieldMapping.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// Fetch data from a data source for a specific user/identifier
export const fetchFromDataSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { identifier, identifierType = 'phone', userId, locationId } = req.body;

    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
      include: { fieldMappings: true },
    });

    if (!dataSource) {
      return res.status(404).json({ error: 'Data source not found' });
    }

    // A connected system can look someone up by the id it gave them instead.
    if (!identifier && !(dataSource.type === 'INTEGRATION' && typeof userId === 'string' && userId)) {
      return res.status(400).json({ error: 'Identifier is required' });
    }

    if (!dataSource.isActive) {
      return res.status(400).json({ error: 'Data source is not active' });
    }

    const config = openConfig(dataSource.config) as Record<string, unknown>;
    let responseData: Record<string, unknown> | null = null;

    if (dataSource.type === 'API') {
      const result = await fetchFromApi(config, identifier, identifierType);
      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }
      responseData = result.data as Record<string, unknown>;
    } else if (dataSource.type === 'INTEGRATION') {
      const integration = await lookupIntegrationFor(dataSource.organizationId, integrationIdOf(config));
      if (!integration) {
        return res.status(409).json({ error: 'The EMR connection is switched off or has no lookup address.', code: 'LOOKUP_NOT_CONFIGURED' });
      }
      if (!LOOKUP_IDENTIFIER_TYPES.includes(identifierType)) {
        return res.status(400).json({ error: `identifierType must be one of: ${LOOKUP_IDENTIFIER_TYPES.join(', ')}` });
      }
      // The EMR's own id beats a phone number, which several people can share.
      const patientRef =
        typeof userId === 'string' && userId
          ? (await prisma.externalReference.findFirst({
              where: { integrationId: integration.id, resourceType: 'patient', resourceId: userId },
              select: { externalId: true },
            }))?.externalId
          : undefined;
      if (!patientRef && !identifier) return res.status(400).json({ error: 'Identifier is required' });
      try {
        const result = await lookupPatient(integration, {
          identifierType: patientRef ? 'patientRef' : (identifierType as LookupIdentifierType),
          identifier: patientRef ?? String(identifier),
          context: 'staff',
          locationRef: await locationRefFor(integration.id, typeof locationId === 'string' ? locationId : null),
        });
        if (!result.matched) {
          return res.status(404).json({
            error: result.candidates.length
              ? `Several people in ${integration.name} have this phone number. Look them up by MR number instead.`
              : `Nobody matching was found in ${integration.name}.`,
          });
        }
        responseData = result as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof LookupError) return res.status(error.status).json({ error: error.message, code: error.code });
        throw error;
      }
    } else {
      return res.status(400).json({ error: `Fetching from ${dataSource.type} sources not yet implemented` });
    }

    // Apply field mappings to extract identity data
    const identityData: Record<string, unknown> = {};
    for (const mapping of dataSource.fieldMappings) {
      const value = getNestedValue(responseData, mapping.sourcePath);
      if (value !== undefined) {
        identityData[mapping.targetField] = applyTransform(value, mapping.transform);
      }
    }

    res.json({
      raw: responseData,
      mapped: identityData,
    });
  } catch (error) {
    next(error);
  }
};

const integrationIdOf = (config: Record<string, unknown>) =>
  typeof config.integrationId === 'string' ? config.integrationId : undefined;

// Helper to fetch from API data source
async function fetchFromApi(
  config: Record<string, unknown>,
  identifier: string,
  identifierType: string
): Promise<{ success: boolean; message?: string; data?: unknown }> {
  try {
    const url = config.url as string;
    if (!url) {
      return { success: false, message: 'API URL not configured' };
    }

    const headers: Record<string, string> = {};
    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    // Add auth if configured
    if (config.auth) {
      const auth = config.auth as Record<string, string>;
      if (auth.type === 'bearer' && auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      } else if (auth.type === 'basic' && auth.username && auth.password) {
        const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      } else if (auth.type === 'apiKey' && auth.headerName && auth.apiKey) {
        headers[auth.headerName] = auth.apiKey;
      }
    }

    // Build endpoint with query params
    const queryParams = config.queryParams as Record<string, string> || {};
    const searchParam = config.searchParam as string || identifierType;
    queryParams[searchParam] = identifier;

    const endpoint = config.searchEndpoint as string || '';
    const searchParams = new URLSearchParams(queryParams);
    const fullUrl = `${url}${endpoint}?${searchParams.toString()}`;

    const response = await fetch((await assertPublicUrl(fullUrl)).toString(), {
      method: 'GET',
      headers,
    });

    if (response.ok) {
      const data = await response.json();
      return { success: true, data };
    } else {
      return { 
        success: false, 
        message: `API request failed (HTTP ${response.status}: ${response.statusText})` 
      };
    }
  } catch (error: any) {
    return { 
      success: false, 
      message: `API error: ${error.message || 'Unknown error'}` 
    };
  }
}

// Helper to get nested value from object using dot notation
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((current: unknown, key: string) => {
    if (current && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// Helper to apply transformation to a value
function applyTransform(value: unknown, transform: string | null): unknown {
  if (!transform) return value;

  switch (transform) {
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'toNumber':
      return typeof value === 'string' ? parseFloat(value) : value;
    case 'toString':
      return String(value);
    case 'toDate':
      return new Date(value as string).toISOString();
    case 'formatPhone':
      // Remove non-digits and format as phone
      if (typeof value === 'string') {
        const digits = value.replace(/\D/g, '');
        if (digits.length === 10) {
          return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
        }
        return digits;
      }
      return value;
    default:
      return value;
  }
}
