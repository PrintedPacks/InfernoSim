"use strict";

import * as THREE from "three";
import { GLTFModel, Viewport, Region, Player, Model } from "osrs-sdk";

import { InfernoSceneModel } from "./InfernoScene";
import { Splat } from "./InfernoHealerSpark";
import { ShieldModel } from "./ZukShield";
import { BlobModel, JalAk } from "./mobs/JalAk";
import { MeleerModel, JalImKot } from "./mobs/JalImKot";
import { HealerModel, Spark, JalMejJak } from "./mobs/JalMejJak";
import { BatModel, JalMejRah } from "./mobs/JalMejRah";
import { NibblerModel, JalNib } from "./mobs/JalNib";
import {
  JadModel,
  JadRangeProjectileModel,
  JadMageProjectileModel1,
  JadMageProjectileModel2,
  JadMageProjectileModel3,
  JalTokJad,
} from "./mobs/JalTokJad";
import { RangerModel, RangeProjectileModel, JalXil } from "./mobs/JalXil";
import { MagerModel, MageProjectileModel, JalZek } from "./mobs/JalZek";
import { ZukModel, ZukBall, TzKalZuk } from "./mobs/TzKalZuk";
import { YtHurKot } from "./mobs/YtHurKot";

/**
 * Every model the Inferno can spawn, including ones that only appear part-way through a
 * wave. The SDK only preloads mobs that exist when the region initialises, so without
 * this the first appearance of each NPC type parses its GLB on the main thread.
 */
const INFERNO_MODELS: string[] = [
  InfernoSceneModel,
  NibblerModel,
  BatModel,
  BlobModel,
  MeleerModel,
  RangerModel,
  MagerModel,
  JadModel,
  ZukModel,
  ShieldModel,
  HealerModel,
  Spark,
  Splat,
  ZukBall,
  RangeProjectileModel,
  MageProjectileModel,
  JadRangeProjectileModel,
  JadMageProjectileModel1,
  JadMageProjectileModel2,
  JadMageProjectileModel3,
];

// Far below the arena, so a frame drawn mid-warmup shows nothing.
const WARMUP_LOCATION = { x: 0, y: 0, z: -10000 };

type ProgressFn = (loaded: number, total: number) => void;

function get3dScene(): THREE.Scene | null {
  const delegate = Viewport.viewport?.getDelegate() as unknown as { scene?: THREE.Scene };
  return delegate?.scene ?? null;
}

export async function preloadInfernoModels(onProgress?: ProgressFn): Promise<void> {
  if (!get3dScene()) {
    return;
  }
  const total = INFERNO_MODELS.length;
  let loaded = 0;
  for (const model of INFERNO_MODELS) {
    try {
      await GLTFModel.preload(model);
    } catch (e) {
      console.warn(`Failed to preload model ${model}`, e);
    }
    onProgress?.(++loaded, total);
  }
}

/**
 * One instance of every mob type the Inferno can spawn.
 *
 * These are constructed but deliberately never added to the region - they exist only so
 * their real models can be built and drawn once.
 */
function buildWarmupMobs(region: Region, player: Player) {
  const at = { x: 0, y: 0 };
  const aggro = { aggro: player };
  return [
    () => new JalNib(region, at, aggro),
    () => new JalMejRah(region, at, aggro),
    () => new JalAk(region, at, aggro),
    () => new JalImKot(region, at, aggro),
    () => new JalXil(region, at, aggro),
    () => new JalZek(region, at, aggro),
    () => new TzKalZuk(region, at, aggro),
    () => new JalMejJak(region, at, { aggro: player, spawnDelay: 2 }),
    () => new YtHurKot(region, at, aggro),
    () =>
      new JalTokJad(region, at, {
        aggro: player,
        attackSpeed: 8,
        stun: 1,
        healers: 0,
        isZukWave: false,
      }),
  ];
}

/**
 * Draw one of every mob type into the live scene so that the renderer's compileAsync pass -
 * which Viewport3d.initialise() runs straight after this - links the shader programs those
 * mobs will actually use.
 *
 * Compiling a plain clone of the GLTF is not enough: three.js keys programs on skinning,
 * bone count and morph targets, so a non-skinned copy warms a different program than the
 * live mob needs. Building the real Mob and asking it for its real model is what makes the
 * warmed program match the one used when the wave starts.
 *
 * Must be called before Viewport.viewport.initialise(). Returns handles for cleanup.
 */
export async function warmUpMobModels(region: Region, player: Player): Promise<Model[]> {
  const scene = get3dScene();
  if (!scene) {
    return [];
  }

  const warmed: Model[] = [];
  for (const build of buildWarmupMobs(region, player)) {
    try {
      const mob = build();
      // Cheap once preloadInfernoModels has filled the cache.
      await mob.preload();
      const model = mob.get3dModel();
      if (!model) {
        continue;
      }
      // Inserts the real mesh into the scene; from here compileAsync can see it.
      model.draw(scene, 0, 0, WARMUP_LOCATION, 0, 0, true, []);
      warmed.push(model);
    } catch (e) {
      // A mob that will not warm is not fatal - it just pays its cost on first spawn.
      console.warn("Failed to warm up mob model", e);
    }
  }
  return warmed;
}

export function disposeWarmupModels(warmed: Model[]): void {
  const scene = get3dScene();
  if (!scene) {
    return;
  }
  for (const model of warmed) {
    try {
      model.destroy(scene);
    } catch (e) {
      console.warn("Failed to dispose warmup model", e);
    }
  }
}
