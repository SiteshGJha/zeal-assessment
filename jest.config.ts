import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.spec.ts', '<rootDir>/tests/**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  testTimeout: 15000,
};

export default config;
