"use strict";
import { Entity, Settings } from "osrs-sdk";

/**
 * Placeholder arena boundary. Blocks movement and line of sight like a real wall (both are
 * Entity's defaults - unlike TileMarker, nothing here overrides them), and paints itself a
 * distinct colour so the boundary is visible with no map image yet. Stand-in until the real
 * Fight Caves geometry exists.
 */
export class FightCavesWallTile extends Entity {
  get size() {
    return 1;
  }

  get color() {
    return "#5a3a24";
  }

  draw() {
    const ctx = this.region.context;
    ctx.fillStyle = this.color;
    ctx.fillRect(
      this.location.x * Settings.tileSize,
      (this.location.y - this.size + 1) * Settings.tileSize,
      this.size * Settings.tileSize,
      this.size * Settings.tileSize,
    );
  }
}
