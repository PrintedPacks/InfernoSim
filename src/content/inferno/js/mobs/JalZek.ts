"use strict";

import {
  Assets,
  Mob,
  Projectile,
  MeleeWeapon,
  MagicWeapon,
  Sound,
  UnitBonuses,
  Collision,
  AttackIndicators,
  Random,
  Viewport,
  GLTFModel,
  EntityNames,
  Trainer,
  Model,
} from "osrs-sdk";

import { InfernoMobDeathStore } from "../InfernoMobDeathStore";
import { InfernoRegion } from "../InfernoRegion";

import MagerImage from "../../assets/images/mager.png";
import MagerSound from "../../assets/sounds/mage_ranger_598.ogg";
import { JalZekModelWithLight } from "../JalZekModelWithLight";

const HitSound = Assets.getAssetUrl("assets/sounds/inferno_rangermager_dmg.ogg");

export const MagerModel = Assets.getAssetUrl("models/7699_33000.glb");
export const MageProjectileModel = Assets.getAssetUrl("models/mage_projectile.glb");

export class JalZek extends Mob {
  shouldRespawnMobs: boolean;
  isFlickering = false;
  // flicker only the tick before the attack animation happns
  flickerDurationTicks = 1;
  flickerTicksRemaining = 0;
  extendedGltfModelInstance: JalZekModelWithLight | null = null;

  mobName() {
    return EntityNames.JAL_ZEK;
  }

  shouldChangeAggro(projectile: Projectile) {
    return this.aggro != projectile.from && this.autoRetaliate;
  }

  get combatLevel() {
    return 490;
  }

  dead() {
    super.dead();
    InfernoMobDeathStore.npcDied(this);
    if (this.isFlickering) {
      this.isFlickering = false;
      this.updateUnderglowVisuals();
    }
  }

  setStats() {
    const region = this.region as InfernoRegion;
    this.shouldRespawnMobs = region.wave >= 69;

    this.stunned = 1;

    this.weapons = {
      stab: new MeleeWeapon(),
      magic: new MagicWeapon({
        model: MageProjectileModel,
        modelScale: 1 / 128,
        visualDelayTicks: 2,
        visualHitEarlyTicks: -1, // hits after landing
        sound: new Sound(MagerSound, 0.1),
      }),
    };

    // non boosted numbers
    this.stats = {
      attack: 370,
      strength: 510,
      defence: 260,
      range: 510,
      magic: 300,
      hitpoint: 220,
    };

    // with boosts
    this.currentStats = JSON.parse(JSON.stringify(this.stats));
  }

  get bonuses(): UnitBonuses {
    return {
      attack: {
        stab: 0,
        slash: 0,
        crush: 0,
        magic: 80,
        range: 0,
      },
      defence: {
        stab: 0,
        slash: 0,
        crush: 0,
        magic: 0,
        range: 0,
      },
      other: {
        meleeStrength: 0,
        rangedStrength: 0,
        magicDamage: 1.0,
        prayer: 0,
      },
    };
  }

  get attackSpeed() {
    return 4;
  }

  get attackRange() {
    return 15;
  }

  get size() {
    return 4;
  }

  get image() {
    return MagerImage;
  }

  hitSound(damaged) {
    return new Sound(HitSound, 0.25);
  }

  attackStyleForNewAttack() {
    return "magic";
  }

  canMeleeIfClose() {
    return "stab" as const;
  }

  magicMaxHit() {
    return 70;
  }

  get maxHit() {
    return 70;
  }

  attackAnimation(tickPercent: number, context) {
    context.rotate(tickPercent * Math.PI * 2);
  }

  respawnLocation(mobToResurrect: Mob) {
    for (let x = 15 + 11; x < 22 + 11; x++) {
      for (let y = 10 + 14; y < 23 + 14; y++) {
        if (!Collision.collidesWithAnyMobs(this.region, x, y, mobToResurrect.size)) {
          if (!Collision.collidesWithAnyEntities(this.region, x, y, mobToResurrect.size)) {
            return { x, y };
          }
        }
      }
    }

    return { x: 21, y: 22 };
  }

  create3dModel() {
    if (!this.extendedGltfModelInstance) {
      this.extendedGltfModelInstance = new JalZekModelWithLight(this, MagerModel);
    }
    return this.extendedGltfModelInstance;
  }

  updateUnderglowVisuals() {
    if (this.extendedGltfModelInstance) {
      this.extendedGltfModelInstance.setFlickerVisualState(this.isFlickering);
    }
  }

  attackStep() {
    super.attackStep();

    if (this.isFlickering) {
      this.flickerTicksRemaining--;
      // double flicker on the flicker tick
      this.extendedGltfModelInstance?.setFlickerVisualState(true);
      if (this.flickerTicksRemaining <= 0) {
        this.isFlickering = false;
        // reset to normal
        this.extendedGltfModelInstance?.setFlickerVisualState(false);
        // Set attack style before attacking
        this.attackStyle = this.attackStyleForNewAttack();
        this.attackFeedback = AttackIndicators.NONE;
        if (Random.get() < 0.1 && !this.shouldRespawnMobs) {
          const mobToResurrect = InfernoMobDeathStore.selectMobToResurect(this.region);
          if (!mobToResurrect) {
            this.attack() && this.didAttack();
          } else {
            // Set to 50% health
            mobToResurrect.currentStats.hitpoint = Math.floor(mobToResurrect.stats.hitpoint / 2);
            mobToResurrect.dying = -1;
            mobToResurrect.attackDelay = mobToResurrect.attackSpeed;

            mobToResurrect.setLocation(this.respawnLocation(mobToResurrect));
            mobToResurrect.playAnimation(mobToResurrect.idlePoseId);
            mobToResurrect.cancelDeath();
            mobToResurrect.aggro = Trainer.player;

            mobToResurrect.perceivedLocation = mobToResurrect.location;
            // Only add it back if it really left. A mob is pushed to the death store the tick
            // its hitpoints hit zero, but the engine does not drop it from region.mobs until
            // the end of the tick where dying reaches 0 - three or four ticks later. Resurrect
            // one inside that window and it is still in the list, cancelDeath() above has just
            // set dying back to -1 so the end-of-tick sweep will never remove it, and adding it
            // again puts the SAME object in region.mobs twice.
            //
            // That is not a cosmetic duplicate. tickRegion does mobs.forEach(movementStep) and
            // mobs.forEach(attackStep), so a doubled entry is stepped twice per tick: it moves
            // at double speed and its attackDelay counts down twice, which makes a speed 4
            // mager attack every 2 ticks. Measured on wave 66 (a wave whose table is
            // [3,0,0,0,0,2] - three nibblers and exactly TWO magers, every attack magic): the
            // arena listed three Jal-Zeks, two of them on the same tile with the same
            // hitpoints, and the bot died flicking Protect from Magic on a four tick rhythm
            // while the doubled mager fired on the ticks in between.
            if (
              !this.region.mobs.includes(mobToResurrect) &&
              !this.region.newMobs.includes(mobToResurrect)
            ) {
              this.region.addMob(mobToResurrect);
            }
            // (15, 10) to  (21 , 22
            this.attackDelay = 8;
            this.playAnimation(3);
          }
        } else {
          this.attack() && this.didAttack();
        }
        this.attackDelay = this.attackSpeed;
      }
      return;
    }
    this.attackIfPossible();
  }

  attackIfPossible() {
    this.hadLOS = this.hasLOS;
    this.setHasLOS();

    if (!this.aggro || this.stunned > 0 || this.frozen > 0 || this.attackDelay > 0 || this.isDying()) {
      return;
    }

    const isUnderAggro = Collision.collisionMath(
      this.location.x,
      this.location.y,
      this.size,
      this.aggro.location.x,
      this.aggro.location.y,
      1,
    );

    if (!isUnderAggro && this.hasLOS) {
      // start flicker BEFORE initiating attack
      this.isFlickering = true;
      this.flickerTicksRemaining = this.flickerDurationTicks;
      //resetting visual state
      this.extendedGltfModelInstance?.setFlickerVisualState(false);
      // wait for flicker to finish before attacking
      this.attackDelay = this.flickerDurationTicks;
      return;
    }
  }

  override get attackAnimationId() {
    return 2;
  }

  override get deathAnimationId() {
    return 5;
  }
}
