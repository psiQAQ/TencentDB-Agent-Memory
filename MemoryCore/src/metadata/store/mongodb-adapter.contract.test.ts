import { afterAll, beforeAll, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoMetadataStore } from './mongodb-adapter.js';
import { runMetadataStoreContract } from './metadata-store.contract.js';

let server: MongoMemoryReplSet;
let sequence = 0;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
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
      useTransactions: true,
      ownsClient: true,
    });
  },
  async (store) => { await store.close(); },
);

it('fails closed for lifecycle mutations when MongoDB transactions are disabled', async () => {
  const client = new MongoClient(server.getUri());
  await client.connect();
  const store = new MongoMetadataStore(client, `metadata_no_tx_${++sequence}`, {
    useTransactions: false,
    ownsClient: true,
  });
  await store.init();
  const user = await store.createUser({
    username: 'no-tx-user',
    auth_provider: 'local',
    external_id: 'no-tx-user',
  });
  await expect(store.createTeam({ name: 'blocked', owner_user_id: user.user_id }))
    .rejects.toMatchObject({ name: 'LifecycleTransactionsRequiredError' });
  await store.close();
});
