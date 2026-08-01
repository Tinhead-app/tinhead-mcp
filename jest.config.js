/**
 * The suites a sceptic can run: `npm ci && npm test`.
 *
 * These are the same files this project runs in its own CI, compiled under the
 * same tsconfig as the server — see tsconfig.test.json for the one field that
 * differs and why.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/packages/tinhead-mcp/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  testTimeout: 30000,
};
