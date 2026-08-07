"use strict";

/**
 * Browser APIs the game expects that jsdom does not provide.
 *
 * Loaded via jest `setupFiles`, so these exist BEFORE osrs-sdk is imported - the SDK
 * constructs its controller singletons (and their canvases) at module load, so defining
 * these later is too late and imports die with "Class extends value undefined" or
 * "OffscreenCanvas is not defined".
 *
 * Everything here is rendering-only surface. Nothing the simulation reads back comes out
 * of these stubs: draw calls vanish, measurements return zeros. If the engine ever starts
 * making decisions off pixel data this file must fail loudly rather than lie - hence no
 * attempt to fake getImageData contents.
 */

function makeStubContext() {
  const noop = () => undefined;
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === "measureText") {
          return () => ({ width: 0 });
        }
        if (prop === "getImageData" || prop === "createImageData") {
          return (a, b, w, h) => {
            const width = Math.max(1, prop === "getImageData" ? w : a);
            const height = Math.max(1, prop === "getImageData" ? h : b);
            return { data: new Uint8ClampedArray(width * height * 4), width, height };
          };
        }
        if (typeof prop === "string") {
          return noop;
        }
        return undefined;
      },
      // Style assignments (fillStyle, font, ...) are accepted and dropped.
      set() {
        return true;
      },
    },
  );
}

class OffscreenCanvasShim {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return makeStubContext();
  }
  transferToImageBitmap() {
    return {};
  }
}

globalThis.OffscreenCanvas = OffscreenCanvasShim;

// jsdom only returns a real 2d context when the optional native `canvas` package is
// installed; without it getContext returns null and the SDK crashes drawing the UI.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function () {
    return makeStubContext();
  };
}

// World.tickRegion constructs an Audio for the metronome setting; keep the class total
// so even a misconfigured run cannot crash on sound.
globalThis.Audio = class {
  play() {}
  pause() {}
};

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = () => 0;
}

// The SDK's asset registry logs "Preloading asset: ..." through console.debug at module
// import time - before any test body can silence it - and a full boot registers hundreds.
// Nothing else in the stack uses debug, so drop the channel wholesale.
console.debug = () => undefined;

// Constructing items and mobs registers model preloads, and Assets fetches them eagerly.
// Headless there is nothing to render, so the download must simply never happen - a
// pending promise parks the preload chain without the unhandled rejection a reject() or
// a fake empty model would cause downstream.
globalThis.fetch = () => new Promise(() => undefined);
