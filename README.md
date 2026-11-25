# map.meshcore.dev
Official MeshCore Map (frontend), running at https://map.meshcore.io

## Installation
This is fully static and build-free site, cloning it to web location that can serve static content should be enough.
It uses backend api deployed on https://map.meshcore.io/api/v1/nodes and radio presets from https://api.meshcore.nz/api/v1/config

## Code structure
All code is native ES modules in `src/`, loaded directly by the browser:
* `main.js` - entry point, creates the map and mounts the app
* `app.js` - Vue app: state, filters, search, URL sync, deletion request dialog
* `config.js` - API endpoints, defaults and other constants
* `nodes.js` - fetching and preparing nodes, filtering, search and stats
* `map.js` - MapLibre map, base map styles, 3D view with terrain (experimental), mountain peaks, map layer switches, node icons, clustering and popups
* `popup.js` - node popup content
* `coverage.js` - repeater coverage estimate: up to 6 sites with their own settings (incl. omni, yagi and panel antennas), where they overlap, link quality, runs the model in a worker
* `coverage-model.js`, `coverage-worker.js` - the coverage model (terrain, forests, LoRa link budget, diffraction) and its Web Worker
* `mvt.js` - minimal vector tile reader (land cover and buildings for the coverage model and profile)
* `profile.js`, `profile-chart.js` - point-to-point profile between two nodes or picked points, and its chart
* `profile-3d.js`, `coverage-3d.js`, `webgl-layer.js` - 3D view WebGL layers: the profile (line of sight through the air, Fresnel zone tube, curtain down to the ground) and the selected coverage site's radio shadow (how high above the ground the line of sight passes)
* `horizon-cutoff.js` - 3D view: no symbols (nodes, peaks, place names) beyond the horizon, in the sky and the far fog
* `deletion.js` - node deletion request (selected nodes, email details and compose links)
* `node-search-results.js` - search autocomplete list (nodes, plus a typed point and places in the main search), shared by the main search and the deletion dialog
* `places.js` - place search (towns, streets, peaks...) with [Photon](https://photon.komoot.io) and reading typed or pasted coordinates
* `setting-slider.js` - slider with its value for the coverage and profile settings (applied on release)
* `dock.js` - dock for the coverage and profile panels: left, right or bottom of the screen (bottom on phones), resizable, collapsible to its bar, remembered
* `presets.js`, `url-state.js`, `utils.js`, `node-utils.js` - helpers

## Libraries used
* [Vue3](https://github.com/vuejs/core)
* [Beer.css](https://github.com/beercss/beercss)
* [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
* [msgpackr](https://github.com/kriszyp/msgpackr)
* qr.js (ESM version by Horacio Gonzalez)
* [Material icons](https://fonts.google.com/icons)
