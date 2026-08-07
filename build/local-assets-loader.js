/**
 * The published `osrs-sdk` bundle hardcodes a remote CDN in `Assets.getAssetUrl`:
 *
 *     var url = "https://oldschool-cdn.com/".concat(asset);
 *
 * Every model, hitsplat and sound the simulator needs is fetched from there at
 * runtime, which makes the app unusable offline. Those assets are vendored into
 * `src/public/` instead, so this loader rewrites the base to a document-relative
 * path at build time. Doing it here (rather than patching node_modules) keeps the
 * fix intact across `npm install`.
 */

const CDN_BASE = "https://oldschool-cdn.com/";
const LOCAL_BASE = "./";

module.exports = function localAssetsLoader(source) {
  if (!source.includes(CDN_BASE)) {
    this.emitError(
      new Error(
        `local-assets-loader: expected to find "${CDN_BASE}" in ${this.resourcePath}. ` +
          "The osrs-sdk asset base may have changed - re-check Assets.getAssetUrl.",
      ),
    );
    return source;
  }
  return source.split(CDN_BASE).join(LOCAL_BASE);
};
