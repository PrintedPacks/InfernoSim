"use strict";

/**
 * Jest stand-in for webpack's html-loader: a .html import evaluates to the file's text.
 *
 * The sidebar markup matters, not just its presence - InfernoRegion.initialiseRegion
 * reads real values out of it (loadout select, pillar checkboxes), so this must export
 * the genuine file rather than a placeholder string.
 */
module.exports = {
  process(sourceText) {
    return { code: "module.exports = " + JSON.stringify(sourceText) + ";" };
  },
};
