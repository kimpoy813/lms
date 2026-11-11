// Runs in every test worker before any application module is imported.
import { inject } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.STORAGE_DIR = inject('storageDir');
process.env.APP_URL = 'http://localhost:5173';
process.env.PASSWORD_HASH_COST = '10';
process.env.SCHEDULER_ENABLED = 'false';
process.env.MAX_UPLOAD_MB = '2';
// Never inherit real integrations from the developer's shell.
delete process.env.SMTP_HOST;
process.env.AI_PROVIDER ??= 'none';
process.env.CODE_RUNNER_PROVIDER ??= 'none';
