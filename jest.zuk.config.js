"use strict";

/**
 * Config for the headless Zuk harness (`npm run test:zuk`, `npm run test:zuk-sweep`).
 *
 * Everything the wave harness needs - jsdom, browser shims, asset stubs - plus the one
 * difference that earns it a file: it runs ONLY the Zuk harness. The wave config ignores
 * zukRun.test.ts for the same reason, so `npm run test:harness` still costs exactly what it
 * always did and a Zuk fight never rides along with the baseline.
 */
const harnessConfig = require("./jest.harness.config.js");

module.exports = {
  ...harnessConfig,
  testMatch: ["<rootDir>/test/harness/zukRun.test.ts"],
  testPathIgnorePatterns: [],
};
