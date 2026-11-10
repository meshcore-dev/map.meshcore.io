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
* `map.js` - MapLibre map, base map styles, node icons, clustering and popups
* `popup.js` - node popup content
* `coverage.js` - repeater coverage estimate: settings, link quality, runs the model in a worker
* `coverage-model.js`, `coverage-worker.js` - the coverage model (terrain, forests, LoRa link budget, diffraction) and its Web Worker
* `mvt.js` - minimal vector tile reader (land cover for the coverage model)
* `profile.js`, `profile-chart.js` - point-to-point profile between two nodes or picked points, and its chart
* `deletion.js` - node deletion request (selected nodes, email details and compose links)
* `node-search-results.js` - search autocomplete list, shared by the main search and the deletion dialog
* `presets.js`, `url-state.js`, `utils.js`, `node-utils.js` - helpers

## Libraries used
* [Vue3](https://github.com/vuejs/core)
* [Beer.css](https://github.com/beercss/beercss)
* [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
* [msgpackr](https://github.com/kriszyp/msgpackr)
* qr.js (ESM version by Horacio Gonzalez)
* [Material icons](https://fonts.google.com/icons)
