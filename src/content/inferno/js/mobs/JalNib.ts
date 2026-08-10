"use strict";

import { Assets, MeleeWeapon, Unit, AttackBonuses, ProjectileOptions, Random, Projectile, Location, Mob, Region, UnitOptions, Sound, UnitBonuses, Collision, AttackIndicators, Pathing, GLTFModel, EntityNames, LocationUtils } from "osrs-sdk";

import NibblerImage from "../../assets/images/nib.png";
import NibblerSound from "../../assets/sounds/meleer.ogg";

export const NibblerModel = Assets.getAssetUrl("models/7691_33005.glb");

class NibblerWeapon extends MeleeWeapon {
  attack(from: Unit, to: Unit, bonuses: AttackBonuses, options: ProjectileOptions = {}): boolean {
    const damage = Math.floor(Random.get() * 5);
    this.damage = damage;
    to.addProjectile(new Projectile(this, this.damage, from, to, "crush", {
      ...this.projectileOptions,
      ...options
    }));
    return true;
  }
}

export class JalNib extends Mob {
  constructor(region: Region, location: Location, options: UnitOptions) {
    super(region, location, options);
    this.autoRetaliate = false;
  }

  mobName() {
    return EntityNames.JAL_NIB;
  }

  get maxHit() {
    return 4;
  }

  get combatLevel() {
    return 32;
  }

  setStats() {
    this.stunned = 1;
    this.autoRetaliate = false;
    this.weapons = {
      crush: new NibblerWeapon({
        sound: new Sound(NibblerSound, 0.2)
      }),
    };

    // non boosted numbers
    this.stats = {
      attack: 1,
      strength: 1,
      defence: 15,
      range: 1,
      magic: 15,
      hitpoint: 10,
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
        magic: 0,
        range: 0,
      },
      defence: {
        stab: -20,
        slash: -20,
        crush: -20,
        magic: -20,
        range: -20,
      },
      other: {
        meleeStrength: 0,
        rangedStrength: 0,
        magicDamage: 0,
        prayer: 0,
      },
    };
  }

  get consumesSpace(): Unit {
    return null;
  }

  get attackSpeed() {
    return 4;
  }

  get attackRange() {
    return 1;
  }

  get size() {
    return 1;
  }

  get image() {
    return NibblerImage;
  }

  attackStyleForNewAttack() {
    return "crush";
  }

  attackAnimation(tickPercent: number, context) {
    context.translate(Math.sin(tickPercent * Math.PI * 4) * 2, Math.sin(tickPercent * Math.PI * -2));
  }

  attackIfPossible() {
    this.attackStyle = this.attackStyleForNewAttack();

    // `!this.aggro` covers a nibbler spawned after every pillar is already gone - the wave
    // spawner hands out `aggro` from whatever pillars still exist (`region.entities.filter`),
    // and if none do by then, that is undefined/null, not a dying pillar. A pillar going
    // through its own dead() never nulls a nibbler's reference to it (it only marks `dying`
    // and removes itself from `entities` two ticks later), so the ORIGINAL check already
    // handled that case fine - `pillar.dying > -1` reads true off a live-but-dying object.
    // This only fires for the case that object never existed at all. Measured: engine crash,
    // "Cannot read properties of null (reading 'dying')", two separate seeds, both deep into a
    // run (tick 6334 and 7055) - long enough for all three pillars to plausibly be lost.
    if (this.dying === -1 && (!this.aggro || this.aggro.dying > -1)) {
      this.dead(); // cheat way for now. pillar should AOE
    }
    if (this.canAttack() === false) {
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
    this.attackFeedback = AttackIndicators.NONE;

    const aggroPoint = LocationUtils.closestPointTo(this.location.x, this.location.y, this.aggro);
    if (
      !isUnderAggro &&
      Pathing.dist(this.location.x, this.location.y, aggroPoint.x, aggroPoint.y) <= this.attackRange &&
      this.attackDelay <= 0
    ) {
      this.attack() && this.didAttack();
    }
  }

  create3dModel() {
    return GLTFModel.forRenderable(this, NibblerModel);
  }

  override get attackAnimationId() {
    return 2;
  }

  override get deathAnimationId() {
    return 4;
  }
}
