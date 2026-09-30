import { createApp } from '../server/app';
import { createStore } from '../server/store';

const store = createStore({
  databaseUrl: process.env.DATABASE_URL,
  dataDir: '/tmp',
});

const { app } = createApp({
  dataDir: '/tmp',
  store,
});

export default app;
