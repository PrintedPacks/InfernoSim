"use strict";

// Binary assets (sprites, sounds, models) resolve to an inert path string, mirroring
// webpack's asset/resource output. Nothing in a headless run ever loads them.
module.exports = "harness-asset-stub";
