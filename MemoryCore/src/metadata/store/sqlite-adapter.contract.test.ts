import { SqliteMetadataStore } from './sqlite-adapter.js';
import { runMetadataStoreContract } from './metadata-store.contract.js';

runMetadataStoreContract(
  'SQLite',
  async () => new SqliteMetadataStore(':memory:'),
  async (store) => { await store.close(); },
);
