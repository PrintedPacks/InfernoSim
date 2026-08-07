"use strict";

import * as THREE from "three";
import { Location, Player, Region, TileMarker, Viewport } from "osrs-sdk";

import { GRID_SIZE, ScoredTile } from "./TileScorer";

/**
 * Debug view of what the positioning layer sees. Purely an instrument - nothing here feeds
 * back into a decision.
 *
 * It draws the exact list `TileScorer.scoreCandidates` produced this tick rather than
 * recomputing anything, so the picture cannot drift from the decision's real input. Tiles are
 * shaded by score and the chosen tile is called out, which means any scoring function can be
 * eyeballed for sanity instead of being inferred from how the bot behaves.
 *
 * Rendering rides on TileMarker, which is already CollisionType.NONE and
 * LineOfSightMask.NONE - so however many of these are on screen, none of them can alter
 * pathing, line of sight, or anything else the simulation reads.
 */

const COLOUR_CHOSEN = "#ffff00";
const COLOUR_PLAYER = "#ffffff";
const COLOUR_FLAT = "#3a7bd5";

class GridTile extends TileMarker {
  /** In the candidate set, and therefore drawn at all. */
  candidate = false;

  private shade = COLOUR_FLAT;
  private label = "";

  constructor(region: Region, location: Location) {
    // saveable = false. Saveable markers are pushed onto TileMarker.saveableMarkers and
    // persisted into settings, which is the last thing a debug overlay should be doing.
    super(region, location, COLOUR_FLAT, 1, false);
  }

  place(x: number, y: number, shade: string, label: string) {
    this.location.x = x;
    this.location.y = y;
    this.shade = shade;
    this.label = label;
    this.candidate = true;
  }

  get color(): string {
    return this.shade;
  }

  visible(): boolean {
    return this.candidate;
  }

  /** The 2D renderer calls draw() straight off and never consults visible(). */
  draw() {
    if (!this.candidate) {
      return;
    }
    super.draw();
  }

  /**
   * Print the score on the tile itself.
   *
   * The `screenPosition` the renderer hands over is deliberately NOT used in 3d. It comes from
   * Viewport3d.get2dOffset, which gets the tile right but the height wrong: it projects at
   * `Renderable.height`, and that getter defaults to `size`, which is 1 for a tile marker. So
   * the number is drawn a full tile up in the air rather than lying on the floor.
   *
   * The centre is `(x + 0.5, y - 0.5)`, not `(x, y)`. TileMarkerModel builds its square from
   * local `x` in [0, size] and `z` in [-size, 0], then positions it at `location` - so
   * `location` is a corner of the square, and half a tile has to be added to reach the middle.
   *
   * projectToScreen returns coordinates in canvasDimensions space, which is precisely how the
   * UI canvas is sized, so its output needs no rescaling.
   *
   * Falls back to the supplied position for the 2d viewport, which exposes no projection.
   */
  drawUILayer(
    tickPercent: number,
    screenPosition: Location,
    context: OffscreenCanvasRenderingContext2D,
  ) {
    if (!this.candidate || !this.label) {
      return;
    }
    const at = GridTile.projectTileCentre(this.location.x, this.location.y) ?? screenPosition;

    context.save();
    context.font = "11px OSRS, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineWidth = 2.5;
    context.strokeStyle = "#000000";
    context.strokeText(this.label, at.x, at.y);
    context.fillStyle = this.shade;
    context.fillText(this.label, at.x, at.y);
    context.restore();
  }

  /** Screen position of a tile's centre, matching where TileMarkerModel puts its square. */
  private static projectTileCentre(x: number, y: number): { x: number; y: number } | null {
    const delegate = Viewport.viewport?.getDelegate() as unknown as {
      projectToScreen?: (v: THREE.Vector3) => { x: number; y: number };
    };
    if (!delegate?.projectToScreen) {
      return null;
    }
    try {
      return delegate.projectToScreen(new THREE.Vector3(x + 0.5, -0.49, y - 0.5));
    } catch (e) {
      return null;
    }
  }
}

export class TileGrid {
  private static shown = false;
  private static tiles: GridTile[] = [];
  private static region: Region | null = null;
  private static drawn = 0;

  static isVisible(): boolean {
    return TileGrid.shown;
  }

  static setVisible(shown: boolean) {
    TileGrid.shown = shown;
  }

  /** How many tiles are actually drawn - the honest size of the candidate set. */
  static candidateCount(): number {
    return TileGrid.drawn;
  }

  /**
   * Draw this tick's scored candidates.
   *
   * Markers are pooled and mutated rather than rebuilt. Entity.getPerceivedLocation() simply
   * reads `location`, so moving them is enough, and it avoids constructing and destroying
   * hundreds of three.js models every single tick. Any marker left over past the end of the
   * candidate list is parked as a non-candidate and therefore not drawn.
   */
  static update(
    region: Region,
    player: Player,
    scored: ScoredTile[],
    chosen: Location | null,
  ) {
    if (!TileGrid.shown || !player) {
      TileGrid.teardown();
      return;
    }
    TileGrid.ensurePool(region);

    // Every candidate ties whenever nothing is in reach and nothing is shooting - an empty
    // arena, or a wave already prayed perfectly - so the ramp has to degrade to a single colour
    // rather than dividing by a zero range.
    let low = Infinity;
    let high = -Infinity;
    for (const entry of scored) {
      low = Math.min(low, entry.score);
      high = Math.max(high, entry.score);
    }
    const range = high - low;

    const count = Math.min(scored.length, TileGrid.tiles.length);
    for (let index = 0; index < count; index++) {
      const { tile, score } = scored[index];
      TileGrid.tiles[index].place(
        tile.x,
        tile.y,
        TileGrid.shadeFor(tile, score, low, range, player, chosen),
        TileGrid.labelFor(score),
      );
    }
    for (let index = count; index < TileGrid.tiles.length; index++) {
      TileGrid.tiles[index].candidate = false;
    }
    TileGrid.drawn = count;
  }

  /**
   * Score as printed on the tile. Kept short - 441 of these share the screen, so anything
   * longer than a few characters turns the grid into a wall of text.
   */
  private static labelFor(score: number): string {
    if (Number.isInteger(score)) {
      return String(score);
    }
    // Trailing zeroes waste width that the neighbouring tile needs.
    return String(Math.round(score * 10) / 10);
  }

  /**
   * Yellow for the tile the bot picked, white for where it is standing, otherwise a red-to-
   * green ramp across the score range present this tick.
   *
   * The ramp is normalised per tick rather than against fixed bounds: scores have no natural
   * scale, and relative ordering is what is being checked by eye.
   *
   * `chosen` is null when the movement layer picked nothing this tick - between waves, or with
   * automation off. NOTHING is painted yellow then, deliberately. Substituting the best-scoring
   * tile made yellow mean two different things: "the tile the bot is walking to" most of the
   * time, and "the tile the bot is ignoring" the rest. Watching the bot walk to a 0.8 tile
   * while the marker sat on a 1 is exactly that, and it looked like a movement bug.
   */
  private static shadeFor(
    tile: Location,
    score: number,
    low: number,
    range: number,
    player: Player,
    chosen: Location | null,
  ): string {
    if (tile.x === player.location.x && tile.y === player.location.y) {
      return COLOUR_PLAYER;
    }
    if (chosen && tile.x === chosen.x && tile.y === chosen.y) {
      return COLOUR_CHOSEN;
    }
    if (range <= 0) {
      return COLOUR_FLAT;
    }
    const fraction = (score - low) / range;
    const red = Math.round(255 * (1 - fraction));
    const green = Math.round(255 * fraction);
    return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}40`;
  }

  /** Built on first show and torn down on hide, so an unused grid costs nothing at all. */
  private static ensurePool(region: Region) {
    if (TileGrid.region === region && TileGrid.tiles.length > 0) {
      return;
    }
    TileGrid.teardown();
    TileGrid.region = region;
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
      const tile = new GridTile(region, { x: 0, y: 0 });
      TileGrid.tiles.push(tile);
      region.addEntity(tile);
    }
  }

  private static teardown() {
    if (TileGrid.tiles.length === 0) {
      return;
    }
    const region = TileGrid.region;
    if (region) {
      for (const tile of TileGrid.tiles) {
        region.removeEntity(tile);
      }
    }
    TileGrid.tiles = [];
    TileGrid.region = null;
    TileGrid.drawn = 0;
  }
}
