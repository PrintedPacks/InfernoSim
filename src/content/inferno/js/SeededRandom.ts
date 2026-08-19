"use strict";

import { Random } from "osrs-sdk";

/**
 * The seeded randomness the harness and the browser share.
 *
 * ONE IMPLEMENTATION ON PURPOSE. A seed is only useful if it means the same fight everywhere, and
 * two copies of a PRNG drift the moment one of them is edited - so the harness imports this rather
 * than keeping its own.
 */

/** Deterministic PRNG (mulberry32) - splittable enough for two independent streams. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed both randomness sources, exactly as the harness does.
 *
 * TWO STREAMS, because the engine uses two: `Random.get()` for anything it rolls itself, and
 * `Math.random` for the places that reach past it - lodash shuffles, Jad's stun order. Seeding one
 * and not the other leaves half the fight unreproducible. The xor keeps the two streams from
 * marching in step with each other.
 *
 * Call before any world object exists; a mob constructed first has already rolled.
 */
export function seedEverything(seed: number) {
  Random.setRandom(mulberry32(seed));
  Math.random = mulberry32(seed ^ 0x9e3779b9);
}
