# Inferno Simulator

A self-contained, offline simulator for the Old School RuneScape Inferno, built on an
open-source re-implementation of the OSRS engine (`osrs-sdk`).

Once dependencies are installed, the project requires **no internet connection**: every
model, texture, sound and font is served from the local dev server.

## Running it

    npm install     # only step that needs a network connection
    npm start       # http://localhost:8000

To produce a static build in `dist/`:

    npm run build

`dist/` is fully self-contained and can be served by any static file server.

## What it does

- Play any Inferno wave, with random or specific spawns.
- Practice the TzKal-Zuk fight, including the shield phase and healers.
- Simulate Jad and triple-Jad waves.
- Configure gear loadouts, prayers, pillars and tile markers.
- Optional experimental 3D view.

## Project layout

    build/                       Webpack helper loaders
    src/
      index.ts                   Entry point: wires up the world, region and UI
      public/                    Static root, copied verbatim into dist/
        index.html
        manifest.json
        webappicon.png
        assets/fonts/            RuneScape web fonts
        assets/images/           Hitsplats and interface sprites
        assets/sounds/           Combat sounds
        models/                  .glb models for mobs, players, projectiles, scene
      content/inferno/           Inferno-specific simulation code
        js/                      Region, waves, settings, pillars, Zuk shield
        js/mobs/                 Mob implementations
        assets/                  Sprites and sounds bundled by webpack
        sidebar.html             Region control panel markup
      @types/                    Ambient type declarations
    test/                        Jest tests

### Offline assets

`osrs-sdk` ships a compiled bundle whose `Assets.getAssetUrl` hardcodes a remote CDN
(`https://oldschool-cdn.com/`). Those assets are vendored into `src/public/` and
[build/local-assets-loader.js](build/local-assets-loader.js) rewrites that base to a
document-relative path at build time, so the fix survives `npm install`. The loader
fails loudly if the SDK ever changes its asset base.

`assets.md` documents how the models and sounds were originally extracted.

## Known issues

- The Jest suite does not currently run: importing `osrs-sdk` in `test/setupFiles.ts`
  throws `Class extends value undefined`, because the SDK's UMD bundle does not receive
  its `three` external correctly under Jest. This is a packaging issue in the
  dependency, not in this project's code, and predates the offline conversion.

## Development notes

    npm run lint
    npm run prettier
