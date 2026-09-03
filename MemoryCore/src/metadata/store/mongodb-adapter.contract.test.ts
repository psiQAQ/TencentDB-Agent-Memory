import { afterAll, beforeAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoMetadataStore } from './mongodb-adapter.js';
import { runMetadataStoreContract } from './metadata-store.contract.js';

let server: MongoMemoryServer;
let sequence = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

runMetadataStoreContract(
  'MongoDB',
  async () => {
    const client = new MongoClient(server.getUri());
    await client.connect();
    sequence += 1;
    return new MongoMetadataStore(client, `metadata_contract_${sequence}`, {
      useTransactions: false,
      ownsClient: true,
    });
  },
  async (store) => { await store.close(); },
);
