/** Jest config for live Telegram integration tests — overrides TELEGRAM_MOCK */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
  setupFiles: [
    '<rootDir>/tests/setup.ts',
    '<rootDir>/tests/setup.live.ts',
  ],
};
