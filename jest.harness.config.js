"use strict";

/**
 * Config for the headless wave-run harness (`npm run test:harness`).
 *
 * Separate from the default jest config on purpose: the harness boots the whole game -
 * osrs-sdk, region, automation - under jsdom, which needs browser shims and asset stubs
 * that ordinary unit tests should not inherit.
 *
 * The main jest suite's known failure ("Class extends value undefined" importing osrs-sdk)
 * does not apply here: it is caused by browser globals the SDK expects at import time -
 * OffscreenCanvas and friends - which test/harness/browserShims.js provides via setupFiles,
 * before any module loads.
 */
module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/test/harness/**/*.test.ts"],
  // Shims must exist before osrs-sdk's import-time singletons construct their canvases.
  setupFiles: ["<rootDir>/test/harness/browserShims.js"],
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    // Same contract as webpack's html-loader: the file's text as the module's export.
    "^.+\\.html$": "<rootDir>/test/harness/rawTextTransform.js",
  },
  moduleNameMapper: {
    "\\.(png|gif|jpg|jpeg|ogg|glb|gltf)$": "<rootDir>/test/harness/assetStub.js",
  },
  globals: {
    "ts-jest": {
      // The harness is a behavioural run, not a type gate - `npm run lint` owns types.
      isolatedModules: true,
    },
  },
  // A full 69-wave run is minutes of simulation; overridable per-run.
  testTimeout: parseInt(process.env.INFERNO_TIMEOUT_MS || "1800000", 10),
};
