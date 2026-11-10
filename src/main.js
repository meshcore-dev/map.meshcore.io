import { mountApp } from './app.js';
import { createMap } from './map.js';
import { openDeletionRequest } from './deletion.js';
import { installPopupHandlers } from './popup.js';
import { getInitialView, isDeletionRequest, readUrlParams } from './url-state.js';

const urlParams = readUrlParams();

// `?public_key=<key>&delete=1` links open the deletion request dialog right away
if(isDeletionRequest(urlParams)) {
	openDeletionRequest(urlParams.public_key);
}

const map = createMap('map', getInitialView(urlParams));
installPopupHandlers();

// exposed for debugging from the browser console
window.mapLibreMap = map;
window.mapApp = mountApp('#app', { map, urlParams });
