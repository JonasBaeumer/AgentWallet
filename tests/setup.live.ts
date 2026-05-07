// Overrides setup.ts for live Telegram integration tests
require('dotenv').config();
process.env.TELEGRAM_MOCK = 'false';
