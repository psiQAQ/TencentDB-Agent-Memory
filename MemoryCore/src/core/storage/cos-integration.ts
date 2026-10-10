import type { ICredentialProvider, IStorageBackend, StorageLogger } from "./types.js";

/** Public contract used by the optional COS deployment integration. */
export interface SharedCosClient {
  getClient(): Promise<unknown>;
  ensureGenerationLogRetention(days: number): Promise<void>;
}

interface CosIntegration {
  SharedCosClient: new (options: {
    credentialProvider: ICredentialProvider;
    logger?: StorageLogger;
    cosEndpointDomain?: string;
  }) => SharedCosClient;
  CosStorageBackend: new (options: {
    credentialProvider?: ICredentialProvider;
    sharedClient?: SharedCosClient;
    prefix?: string;
    logger?: StorageLogger;
  }) => IStorageBackend & { deleteByPrefix(prefix: string): Promise<number> };
}

export async function loadCosIntegration(): Promise<CosIntegration> {
  const modulePath = "../../integrations/cos/cos-backend.js";
  const integration = await import(modulePath) as CosIntegration;
  if (typeof integration.CosStorageBackend !== "function" || typeof integration.SharedCosClient !== "function") {
    throw new Error("COS integration must export CosStorageBackend and SharedCosClient constructors");
  }
  return integration;
}
