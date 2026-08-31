"use strict";

/**
 * Config for the headless wave-68 harness (`npm run test:wave68`, `npm run test:wave68-sweep`).
 *
 * Everything the wave harness needs - jsdom, browser shims, asset stubs - plus the one difference
 * that earns it a file: it runs ONLY the triple-Jad harness. The baseline config ignores
 * wave68Run.test.ts for the same reason it ignores zukRun.test.ts, so `npm run test:harness` still
 * costs exactly what it always did and a Jad wave never rides along with it.
 */
const harnessConfig = require("./jest.harness.config.js");

module.exports = {
  ...harnessConfig,
  testMatch: ["<rootDir>/test/harness/wave68Run.test.ts"],
  testPathIgnorePatterns: [],
};
