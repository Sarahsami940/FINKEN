import { consistencyScenarios } from './scenarios';
import { MemoryAdapter } from './storage';
import { AppStore } from './store';

// The scenarios on browser storage, kept in memory for the test.
const storage = new MemoryAdapter();
consistencyScenarios(
  'browser storage',
  async () => ({
    store: new AppStore(storage),
    reopen: async () => new AppStore(storage),
    settle: () => new Promise((r) => setTimeout(r, 0)),
    guest: true,
    readTransactions: (ids) => storage.getMany('transactions', ids),
  }),
  { localStorage: storage },
);
