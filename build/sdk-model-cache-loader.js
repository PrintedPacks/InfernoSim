/**
 * `GLTFModel.preload(model)` in the published osrs-sdk bundle parses the GLB and then
 * throws the result away:
 *
 *     var scene = new THREE.Scene();
 *     gltf = yield loader.loadAsync(model);        // <- never stored
 *
 * The spawn path (`loadAndAddSingleModel`) looks the model up in `globalModelCache`,
 * which the preload never populates, so the full meshopt decode plus geometry and
 * material construction is paid a second time the first time a mob appears. On high
 * Inferno waves several NPC types appear at once and each one stalls the main thread.
 *
 * This loader rewrites that single statement so the preload writes into the cache the
 * spawn path already reads from, and skips the work entirely when it is already warm.
 * It also exposes the cache as `GLTFModel.warmCache` so the app can hand parsed scenes
 * to the real renderer for shader precompilation - see src/content/inferno/js/InfernoPreloader.ts.
 *
 * Applied at build time rather than by patching node_modules, so it survives npm install.
 */

const PARSE = "gltf = _a.sent();";
const PARSE_PATCHED = "gltf = _a.sent(); globalModelCache[model] = globalModelCache[model] || gltf;";

// Region.preload() -> mob.preload() -> GLTFModel.preload() runs after our own warmup has
// already parsed everything. Without this guard the whole GLB is decoded a second time.
const ENTRY = "GLTFModel.preload = function (model) {";
const ENTRY_PATCHED = ENTRY + "\n        if (globalModelCache[model]) { return Promise.resolve(); }";

const RETURN_CLASS = "    return GLTFModel;\n}());";
const RETURN_CLASS_PATCHED =
  "    GLTFModel.warmCache = globalModelCache;\n" + RETURN_CLASS;

module.exports = function sdkModelCacheLoader(source) {
  let out = source;
  let applied = 0;

  // Only the static preload body matches this exact shape; guard on the count so a
  // future SDK version cannot silently half-apply the patch.
  const parseHits = out.split(PARSE).length - 1;
  if (parseHits === 1) {
    out = out.replace(PARSE, PARSE_PATCHED);
    applied++;
  }

  if (out.split(ENTRY).length - 1 === 1) {
    out = out.replace(ENTRY, ENTRY_PATCHED);
    applied++;
  }

  if (out.includes(RETURN_CLASS)) {
    out = out.replace(RETURN_CLASS, RETURN_CLASS_PATCHED);
    applied++;
  }

  if (applied !== 3) {
    this.emitError(
      new Error(
        `sdk-model-cache-loader: expected 3 patch sites in ${this.resourcePath}, applied ${applied}. ` +
          "GLTFModel has changed - re-check preload() and re-derive the patch.",
      ),
    );
  }

  return out;
};
