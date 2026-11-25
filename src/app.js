import { createApp, reactive, ref, computed, watch, onMounted, nextTick, shallowRef } from '../lib/vue.esm-browser.prod.js';
import { DELETION_EMAIL, DELETION_SUBJECT, DEFAULT_FILTERS, NODE_FLY_DURATION_SECONDS, NODE_FOCUS_ZOOM, NODE_PROCESSING_CHUNK_SIZE, SEARCH_RESULT_LIMIT } from './config.js';
import {
	addToDeletionRequest, buildDeletionBody, deletionMaxNodes, deletionRequest, getComposeLinks, getPendingKeys, getUserAction,
	isDeletionRequested, isDeletionRequestFull, markDeletionRequestSent, undoDeletionRequestSent,
	isInDeletionRequest, removeFromDeletionRequest, toggleInDeletionRequest,
} from './deletion.js';
import {
	ANTENNA_TYPES, BUILDINGS_MAX_DISTANCE, COVERAGE_OPTIONS, COVERAGE_SLIDERS, FADE_MARGIN_DB as COVERAGE_FADE_MARGIN, RECEIVER as COVERAGE_RECEIVER,
	closeCoverage, computeCoverage, computeLinkProfile, coverage, releaseCoverage, getCoverageBounds, getCoverageRadio, getLinkBars,
	getLocalRadioParams, getSensitivity, hasSameRadio, requestPointCoverage, applyCoverageSettings, encodeCoverageSettings, requestCoverage,
	MAX_COVERAGE_SITES, addCoverageSite, closeAllCoverage, computeOverlap, selectCoverageSite,
} from './coverage.js';
import {
	DirectionHandle, createHighlightLayer, createSearchPin, createNodeLayer, createNodePopup, getNodeFocusZoom, interpolateMapLine, NODE_NAMES_ZOOM,
	setCoverageOverlay, setLinkQuality, setNodeNames, setPlanningOverlay,
} from './map.js';
import { addProfileEnd, closeProfile, profile, setProfileStart, swapProfileEnds } from './profile.js';
import { drawProfileChart, getBlockedRanges, getClearance, getProfileLines } from './profile-chart.js';
import { isDarkTheme, onThemeChange } from './theme.js';
import { NodeSearchResults } from './node-search-results.js';
import { SettingSlider } from './setting-slider.js';
import { useDock } from './dock.js';
import { createProfile3d } from './profile-3d.js';
import { createCoverage3d } from './coverage-3d.js';
import {
	computeStats, countRadioKeys, radioKey, fetchNodes, filterNodes, groupByType, prepareNode, searchNodes,
} from './nodes.js';
import { PLACE_SEARCH_DELAY_MS, PLACE_SEARCH_MIN_LENGTH, formatCoordinates, parseCoordinates, searchPlaces } from './places.js';
import { findPresets, getRadioPresets, loadPresets, presetsLoaded } from './presets.js';
import { clearMapPosition, decodeSite, encodeSite, getFiltersFromUrl, setMapPosition, writeUrlParams } from './url-state.js';
import { compassPoint, forEachChunked } from './utils.js';
const NODE_NAMES_STORAGE_KEY = 'showNodeNames';

function loadShowNodeNames() {
	try { return localStorage.getItem(NODE_NAMES_STORAGE_KEY) !== 'false'; } catch { return true; }
}

// node types whose antennas are usually above buildings and trees (repeaters, room servers)
const ELEVATED_NODE_TYPES = new Set([2, 3]);

function cloneDefaultFilters() {
	return structuredClone(DEFAULT_FILTERS);
}

function sameMembers(a, b) {
	if(a.length !== b.length) return false;
	const set = new Set(a.map(String));
	return b.every(v => set.has(String(v)));
}

function isDefaultFilter(state) {
	return sameMembers(state.nodeFilter, DEFAULT_FILTERS.nodeFilter) &&
		state.presetFilter === DEFAULT_FILTERS.presetFilter &&
		state.fromDate === DEFAULT_FILTERS.fromDate &&
		state.fromInsertDate === DEFAULT_FILTERS.fromInsertDate &&
		state.onlyDuplicates === DEFAULT_FILTERS.onlyDuplicates;
}

export function mountApp(selector, { map, urlParams }) {
	return createApp({
		components: { NodeSearchResults, SettingSlider },
		setup() {
			const app = reactive({
				...cloneDefaultFilters(),
				search: '',
				urlParams,
				loading: false,
				searchInViewport: false,
				filterOpen: false,
				searchFocused: false,
				// names of all nodes when zoomed in close (a display setting: kept, not a filter)
				showNodeNames: loadShowNodeNames(),
			});

			// Large arrays of plain objects are kept out of Vue's deep reactivity
			const nodes = shallowRef([]);
			const nodesByType = shallowRef({});

			// the community radio presets (loaded once): the node filter, picked points' radio settings
			const radioPresets = shallowRef([]);
			loadPresets().then(() => { radioPresets.value = getRadioPresets(); }, console.error);
			// the preset filter's choices: presets with the same radio settings as one (named after the first,
			// labelled with all their names, comma separated like in the node popup), with how many nodes use them
			const presetFilterOptions = computed(() => {
				const counts = countRadioKeys(nodes.value);
				const groups = new Map();
				for(const { name, params } of radioPresets.value) {
					const key = radioKey(params);
					if(groups.has(key)) groups.get(key).names.push(name);
					else groups.set(key, { name, names: [name], count: counts.get(key) ?? 0 });
				}
				return [...groups.values()].map(group => ({ ...group, label: group.names.join(', ') }));
			});
			// the dropdown's value: the group of the chosen preset (a link may name any preset of a group)
			const presetFilterChoice = computed({
				get: () => presetFilterOptions.value.find(group => group.names.includes(app.presetFilter))?.name ?? app.presetFilter,
				set: name => { app.presetFilter = name; },
			});
			// (until the presets are loaded, a preset from the URL doesn't filter yet)
			const presetFilterKey = computed(() => {
				const preset = app.presetFilter && radioPresets.value.find(p => p.name === app.presetFilter);
				return preset ? radioKey(preset.params) : null;
			});

			// With default filters every node is shown (including ones older than the default dates)
			const filteredNodes = computed(() =>
				isDefaultFilter(app) ? nodes.value : filterNodes(nodesByType.value, app, presetFilterKey.value)
			);
			const filtersActive = computed(() => filteredNodes.value.length !== nodes.value.length);

			const stats = computed(() =>
				nodes.value.length ? computeStats(nodes.value, nodesByType.value) : null
			);

			const searchResults = computed(() => {
				if(!app.search) return [];
				return searchNodes(filteredNodes.value, app.search, {
					bounds: app.searchInViewport ? map.getBounds() : null,
					limit: SEARCH_RESULT_LIMIT,
				});
			});

			// coordinates typed or pasted into the search, offered as a point to go to
			const searchPoint = computed(() => parseCoordinates(app.search));

			// places (towns, streets, peaks, ...): looked up once typing stops, the ones near the map's
			// centre first (only in view with "Search in current view only")
			const searchPlaceResults = shallowRef([]);
			let placeSearchTimer = null, placeSearchAbort = null;
			watch([() => app.search, () => app.searchInViewport], ([query]) => {
				clearTimeout(placeSearchTimer);
				placeSearchAbort?.abort();
				query = query.trim();
				if(query.length < PLACE_SEARCH_MIN_LENGTH || searchPoint.value) {
					searchPlaceResults.value = [];
					return;
				}
				placeSearchTimer = setTimeout(async () => {
					const abort = placeSearchAbort = new AbortController();
					const { lng, lat } = map.getCenter();
					const bounds = app.searchInViewport ? map.getBounds() : null;
					try {
						searchPlaceResults.value = await searchPlaces(query, {
							near: { lat, lon: lng, zoom: map.getZoom() + 1 },
							bounds: bounds && [Math.max(-180, bounds.getWest()), bounds.getSouth(), Math.min(180, bounds.getEast()), bounds.getNorth()],
							signal: abort.signal,
						});
					} catch(error) {
						if(error.name !== 'AbortError') {
							console.error(error);
							searchPlaceResults.value = [];
						}
					}
				}, PLACE_SEARCH_DELAY_MS);
			});
			const showSearchResults = computed(() => app.searchFocused &&
				(searchPoint.value || searchResults.value.length > 0 || searchPlaceResults.value.length > 0));

			// clicking the pin opens the map menu for it
			const searchPin = createSearchPin(map, {
				onClick: ({ lat, lon }, label, ev) => openMapMenu({ lat, lng: lon }, ev.clientX, ev.clientY, label),
			});
			// flies to a picked point or place and pins it
			function goToSearchResult({ lat, lon, zoom, bounds = null }, label) {
				nodePopup.close();
				app.search = '';
				searchPlaceResults.value = [];
				searchPin.show({ lat, lon }, label);
				const camera = bounds && map.cameraForBounds(bounds, { padding: 40, maxZoom: 17 });
				map.flyTo({
					...(camera ? { center: camera.center, zoom: camera.zoom } : { center: [lon, lat], zoom }),
					duration: NODE_FLY_DURATION_SECONDS * 1000,
				});
			}
			const POINT_ZOOM = 14;
			function onSearchPoint(point) {
				goToSearchResult({ ...point, zoom: POINT_ZOOM }, formatCoordinates(point));
			}
			function onSearchPlace(place) {
				goToSearchResult(place, [place.name, place.area].filter(Boolean).join(', '));
			}
			// Enter: the point if coordinates were typed, else the first result
			function onSearchEnter() {
				if(searchPoint.value) onSearchPoint(searchPoint.value);
				else if(searchResults.value.length) onSearchSelect(searchResults.value[0]);
				else if(searchPlaceResults.value.length) onSearchPlace(searchPlaceResults.value[0]);
			}

			const nodeLayer = createNodeLayer(map, { clusteringZoom: app.clusteringZoom, onNodeClick });
			const deletionHighlight = createHighlightLayer(map);

			const nodePopup = createNodePopup(map, {
				onOpen(node) {
					app.urlParams.public_key = node.public_key;
					clearMapPosition(app.urlParams);

					// presets are only needed for the popup's "Radio preset" row - fetch on first use, then re-render
					if(!presetsLoaded()) {
						loadPresets().then(() => nodePopup.refresh(), console.error);
					}
				},
				onClose() {
					delete app.urlParams.public_key;
					setMapPosition(app.urlParams, map);
				},
			});

			function onNodeClick(node) {
				if(deletionRequest.pickingOnMap) {
					toggleInDeletionRequest(node.public_key);
					return;
				}
				// a node with coverage shown: its settings in the panel
				const site = coverage.sites.find(s => s.publicKey === node.public_key);
				if(site) selectCoverageSite(site.id);
				nodePopup.open(node);
			}

			watch(() => app.clusteringZoom, zoom => {
				app.urlParams.cluster = zoom;
				nodeLayer.setClusteringZoom(zoom);
			});


			watch(
				[() => app.nodeFilter, () => app.presetFilter, () => app.fromDate, () => app.fromInsertDate, () => app.onlyDuplicates],
				() => {
					app.urlParams.nodes = app.nodeFilter.join(',');
					// (the frequency filter it replaced)
					delete app.urlParams.freq;
					if(app.presetFilter) {
						app.urlParams.radio = app.presetFilter;
					} else {
						delete app.urlParams.radio;
					}
					app.urlParams.date = app.fromDate;
					app.urlParams.dateInsert = app.fromInsertDate;
					if(app.onlyDuplicates) {
						app.urlParams.dupes = 1;
					} else {
						delete app.urlParams.dupes;
					}
				}
			);

			watch(() => app.urlParams, writeUrlParams, { deep: true });

			const deletionDialog = ref(null);
			const composeLinks = computed(() => getComposeLinks(deletionRequest.body));
			const userAction = computed(() => getUserAction(deletionRequest.publicKeys));
			const copiedField = ref('');
			let copiedTimer = null;

			const nodesByKey = computed(() => new Map(nodes.value.map(node => [node.public_key, node])));

			// keys that aren't on the map (yet) are still listed, so they can be removed
			const deletionNodes = computed(() => deletionRequest.publicKeys.map(key =>
				nodesByKey.value.get(key) ?? { public_key: key, adv_name: app.loading ? 'Loading…' : 'Node not on the map' }
			));

			const deletionSearch = reactive({ query: '', focused: false });
			// searches all nodes - a node to delete may well be hidden by the current filters
			const deletionSearchResults = computed(() => {
				if(!deletionSearch.query) return [];
				return searchNodes(nodes.value, deletionSearch.query, { limit: SEARCH_RESULT_LIMIT });
			});

			function selectDeletionNode(node) {
				addToDeletionRequest(node.public_key);
				deletionSearch.query = '';
			}

			// The results float over the dialog as a popover: the dialog is a transformed scroll container,
			// so anything positioned inside it would be clipped
			const deletionSearchBox = ref(null);
			const deletionResultsPopover = ref(null);
			const showDeletionResults = computed(() => deletionSearch.focused && deletionSearchResults.value.length > 0);

			function positionDeletionResults() {
				const popover = deletionResultsPopover.value;
				if(!popover?.matches(':popover-open')) return;
				const rect = deletionSearchBox.value.getBoundingClientRect();
				const top = rect.bottom + 4;
				Object.assign(popover.style, {
					top: `${top}px`,
					left: `${rect.left}px`,
					width: `${rect.width}px`,
					maxHeight: `${Math.max(120, innerHeight - top - 16)}px`,
				});
			}

			watch(showDeletionResults, show => {
				const popover = deletionResultsPopover.value;
				if(show && !popover.matches(':popover-open')) {
					popover.showPopover();
					positionDeletionResults();
				} else if(!show && popover.matches(':popover-open')) {
					popover.hidePopover();
				}
			}, { flush: 'post' });

			// Esc clears the search first instead of closing the whole dialog
			function onDeletionSearchEsc(ev) {
				if(deletionSearch.query) {
					ev.preventDefault();
					deletionSearch.query = '';
				}
			}

			const pendingCount = computed(() => getPendingKeys().length);
			const deletionSearchInput = ref(null);

			// the body is regenerated from the node list, so manual edits last until the list changes
			watch(() => getPendingKeys().join(), () => {
				deletionRequest.body = buildDeletionBody(getPendingKeys());
				deletionRequest.confirmingSingle = false;
			});

			// a single-node request is confirmed once - most people deleting a node have more of them
			function goToSendStep() {
				if(pendingCount.value === 1 && !deletionRequest.confirmingSingle) {
					deletionRequest.confirmingSingle = true;
					return;
				}
				deletionRequest.confirmingSingle = false;
				deletionRequest.step = 'send';
			}

			async function addMoreNodes() {
				deletionRequest.confirmingSingle = false;
				deletionRequest.step = 'collect';
				await nextTick();
				deletionSearchInput.value?.focus();
			}

			// deferred: re-rendering the dialog from inside the click would remove the link before the
			// browser follows it
			function onComposeLinkClick() {
				setTimeout(markDeletionRequestSent);
			}

			watch(
				[deletionNodes, () => deletionRequest.pickingOnMap],
				([selected, picking]) => {
					// placeholders for keys that aren't on the map have no coordinates
					deletionHighlight.setNodes(selected.filter(node => node.lat != null));
					deletionHighlight.setVisible(picking);
				}
			);

			watch(() => deletionRequest.pickingOnMap, picking => {
				document.body.classList.toggle('deletion-picking', picking);
			});

			watch(isDeletionRequestFull, full => {
				document.body.classList.toggle('deletion-full', full);
			}, { immediate: true });

			function startPickingOnMap() {
				nodePopup.close();
				deletionRequest.pickingOnMap = true;
				deletionRequest.open = false;
			}

			function finishPickingOnMap() {
				deletionRequest.pickingOnMap = false;
				deletionRequest.open = true;
			}

			watch(() => deletionRequest.open, open => {
				if(open) {
					deletionDialog.value.showModal();
				} else {
					deletionDialog.value.close();
				}
			});

			// fired by close(), Esc and the dialog's close button alike
			function onDeletionDialogClose() {
				deletionRequest.open = false;
				deletionRequest.confirmingSingle = false;
				if(deletionRequest.step === 'sent') {
					deletionRequest.step = 'collect';
					deletionRequest.sentKeys = [];
				}
				delete app.urlParams.delete;
			}

			async function copyText(field, text) {
				await navigator.clipboard.writeText(text);
				copiedField.value = field;
				clearTimeout(copiedTimer);
				copiedTimer = setTimeout(() => { copiedField.value = ''; }, 1500);
			}

			function onSearchSelect(node) {
				if(deletionRequest.pickingOnMap) addToDeletionRequest(node.public_key);
				showNode(node);
			}

			function clearFilters() {
				Object.assign(app, cloneDefaultFilters());
			}

			const selectedRadioPreset = computed(() => radioPresets.value.find(p => p.name === coverage.radioPreset) ?? null);

			// Presets to offer for picked points: the ones used by nodes within PRESET_RADIUS_KM of
			// them, most used first ({ ...preset, count }); all of them where there are no nodes around.
			// The chosen preset stays on the list.
			const PRESET_RADIUS_KM = 250;
			function getPresetsNear(points) {
				const all = radioPresets.value;
				if(points.length === 0) return all;
				const counts = new Map();
				for(const node of nodes.value) {
					if(!node.params) continue;
					const near = points.some(({ lat, lon }) =>
						Math.hypot((node.lon - lon) * Math.cos(lat * Math.PI / 180), node.lat - lat) * 111.2 <= PRESET_RADIUS_KM);
					if(!near) continue;
					for(const preset of findPresets(node.params)) counts.set(preset.name, (counts.get(preset.name) ?? 0) + 1);
				}
				if(counts.size === 0) return all;
				const near = all.filter(p => counts.has(p.name) || p.name === coverage.radioPreset)
					.map(p => ({ ...p, count: counts.get(p.name) ?? 0 }));
				return near.sort((a, b) => b.count - a.count);
			}
			const coveragePresets = computed(() => getPresetsNear(coverage.point ? [coverage.point] : []));
			// a preset brings its band along
			watch(selectedRadioPreset, preset => {
				if(preset) coverage.settings.frequency = preset.radio.freq < 600 ? 433 : 868;
			});

			// A picked point as a coverage / profile site: the chosen radio preset, or the radio
			// settings of the repeaters around it
			// (preset: the selected coverage site's, unless given)
			function getPointSite({ lat, lon }, settings = coverage.settings, preset = selectedRadioPreset.value) {
				return {
					lat,
					lon,
					adv_name: `point ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
					params: preset?.radio ?? getLocalRadioParams(lat, lon, nodes.value, settings),
					isPoint: true,
				};
			}
			const sameSpot = (a, b) => !!a && !!b && a.lat === b.lat && a.lon === b.lon;
			// set while a dropped point gets its new position: the map stays where it is
			let keepView = false;

			// Coverage of the sites: each is recomputed when its node, point, radio preset or a setting
			// changes; results of superseded requests are dropped
			// site id -> { key (what it was computed for), request, result }
			const siteStates = new Map();
			let nextCoverageRequest = 0;
			// the shown estimates: [{ site, node, result }] in the sites' order
			const coverageResults = shallowRef([]);
			let overlapResult = null;
			let overlapRequest = 0;

			function getSiteNode(site) {
				if(site.publicKey) return nodesByKey.value.get(site.publicKey) ?? null;
				if(!site.point) return null;
				const preset = radioPresets.value.find(p => p.name === site.radioPreset);
				return getPointSite(site.point, site.settings, preset ?? null);
			}

			// a site's estimate is new or gone
			function showCoverage() {
				const results = [];
				for(const site of coverage.sites) {
					const state = siteStates.get(site.id);
					if(state?.result) results.push({ site, node: state.node, result: state.result });
				}
				coverageResults.value = results;
				drawCoverage();
				updateLinkQuality();
			}
			// the selected site's radio shadow in the 3D view (experimental, off until switched on; remembered)
			const coverage3d = createCoverage3d(map);
			const coverageShadow3d = ref((() => { try { return localStorage.getItem('coverageShadow3d') === '1'; } catch { return false; } })());
			watch(coverageShadow3d, on => {
				try { localStorage.setItem('coverageShadow3d', on ? '1' : '0'); } catch {}
				drawCoverage();
			});
			// the estimates on the map: the selected site's stronger, overlaps highlighted when asked for
			function drawCoverage() {
				coverage3d.set(coverageShadow3d.value && coverageResults.value.find(({ site }) => site.id === coverage.activeId)?.result.shadow || null);
				setCoverageOverlay(map, {
					sites: coverageResults.value.map(({ site, result }) => ({ id: site.id, active: site.id === coverage.activeId, result })),
					overlap: coverage.highlightOverlaps ? overlapResult : null,
				});
			}

			// where two or more sites reach: worked out again when the estimates change
			async function updateOverlap() {
				const request = ++overlapRequest;
				const results = coverageResults.value.map(({ result }) => result);
				let overlap = null;
				if(coverage.highlightOverlaps && results.length > 1) {
					// let the map show the new estimates first
					await new Promise(resolve => setTimeout(resolve, 50));
					if(request !== overlapRequest) return;
					overlap = await computeOverlap(results);
				}
				if(request !== overlapRequest) {
					releaseCoverage(overlap);
					return;
				}
				const previous = overlapResult;
				overlapResult = overlap;
				coverage.overlapKm2 = overlap ? Math.round(overlap.areaKm2) : coverage.highlightOverlaps && results.length > 1 ? 0 : null;
				drawCoverage();
				releaseCoverage(previous);
			}
			watch([coverageResults, () => coverage.highlightOverlaps], updateOverlap);
			watch(() => coverage.activeId, drawCoverage);

			// fits the map to sites' estimates ([{ node, distanceKm }]), with room for the panels around it
			async function fitCoverage(sites) {
				// the popup would cover the coverage area
				nodePopup.close();
				// the panels are docked beside the map: room for the stats bar and search box above
				await nextTick();
				const top = 110, bottom = 30;
				const bounds = sites.map(({ node, distanceKm }) => getCoverageBounds(node.lon, node.lat, distanceKm));
				map.fitBounds([
					[Math.min(...bounds.map(b => b[0][0])), Math.min(...bounds.map(b => b[0][1]))],
					[Math.max(...bounds.map(b => b[1][0])), Math.max(...bounds.map(b => b[1][1]))],
				], {
					padding: { top, bottom, left: 20, right: 20 },
				});
			}

			async function computeSite(site, node, key) {
				const request = ++nextCoverageRequest;
				const state = siteStates.get(site.id) ?? {};
				siteStates.set(site.id, { ...state, key, request });
				const { nodeDisplay, ...settings } = site.settings;
				site.name = node.adv_name;
				site.radio = getCoverageRadio(node, settings);
				site.loading = true;
				site.error = '';
				try {
					const result = await computeCoverage(node, settings);
					if(siteStates.get(site.id)?.request !== request) {
						releaseCoverage(result);
						return;
					}
					console.debug('coverage', JSON.stringify(result.stats));
					releaseCoverage(siteStates.get(site.id).result);
					siteStates.set(site.id, { key, request, node, result });
					if(result.incomplete) site.error = 'Some terrain data could not be loaded, the estimate is incomplete.';
					showCoverage();
				} catch(e) {
					if(siteStates.get(site.id)?.request !== request) return;
					console.error(e);
					releaseCoverage(siteStates.get(site.id).result);
					siteStates.set(site.id, { key, request });
					site.error = `Coverage could not be computed: ${e.message}`;
					showCoverage();
				} finally {
					if(siteStates.get(site.id)?.request === request) site.loading = false;
				}
			}

			watch(
				// the display mode doesn't change the estimates
				() => [coverage.sites.map(site => {
					const { nodeDisplay, ...settings } = site.settings;
					return { site, key: JSON.stringify([site.publicKey, site.point, settings, site.radioPreset]), node: getSiteNode(site) };
				}), radioPresets.value],
				([sites]) => {
					// sites that are gone
					const ids = new Set(sites.map(({ site }) => site.id));
					let removed = false;
					for(const [id, state] of siteStates) {
						if(ids.has(id)) continue;
						releaseCoverage(state.result);
						siteStates.delete(id);
						removed = true;
					}
					// sites to show on the map (all at once: a shared link brings several)
					const toFit = [];
					for(const { site, key, node } of sites) {
						const state = siteStates.get(site.id);
						if(state?.key === key) continue;
						if(!node) {
							// a node that isn't on the map (anymore)
							if(site.publicKey && nodes.value.length) closeCoverage(site.id);
							continue;
						}
						const previous = state?.key ? JSON.parse(state.key) : null;
						// the map moves to a new site, a moved one (unless it was dragged) and a new distance
						const moved = !previous || previous[0] !== site.publicKey || (JSON.stringify(previous[1]) !== JSON.stringify(site.point) && !keepView);
						if(moved || previous[2].distanceKm !== site.settings.distanceKm) toFit.push({ node, distanceKm: site.settings.distanceKm });
						computeSite(site, node, key);
					}
					if(toFit.length) fitCoverage(toFit);
					if(removed) showCoverage();
				},
			);

			// nodes in reach of any site's estimate (with the same radio settings): [{ node, bars }] with the
			// best site's bars, null without estimates
			const reachableLinks = shallowRef(null);
			// the sites that are nodes (picked points have planning marks instead)
			const siteNodes = computed(() => coverageResults.value.map(({ node }) => node).filter(node => !node.isPoint));

			// "reachable only" display: just the sites and the nodes in their reach, nothing clustered
			const showReachableOnly = computed(() => reachableLinks.value !== null && coverage.settings.nodeDisplay === 'reachable');
			const displayedNodes = computed(() => showReachableOnly.value
				? [...new Set([...siteNodes.value, ...reachableLinks.value.map(link => link.node)])]
				: filteredNodes.value);

			// badges after the nodes: they follow the nodes' placement (spread out ones)
			watch([displayedNodes, showReachableOnly], ([nodes, reachableOnly]) => {
				nodeLayer.setClustering(!reachableOnly, nodes);
				// names only in the "reachable only" display, where there are few nodes to label
				setLinkQuality(map, reachableLinks.value ?? [], { labels: reachableOnly, sources: siteNodes.value });
			});

			// the "reachable only" display has names of its own
			watch([() => app.showNodeNames, showReachableOnly], ([show, reachableOnly]) => {
				setNodeNames(map, show && !reachableOnly);
			}, { immediate: true });
			watch(() => app.showNodeNames, show => {
				try { localStorage.setItem(NODE_NAMES_STORAGE_KEY, String(show)); } catch {}
			});

			// Link quality for visible nodes with the same radio settings as an estimate; the counts per site
			function updateLinkQuality() {
				const results = coverageResults.value;
				for(const site of coverage.sites) {
					if(!results.some(r => r.site.id === site.id)) site.linkCounts = null;
				}
				if(!results.length) {
					reachableLinks.value = null;
					return;
				}
				const best = new Map();
				for(const { site, node: siteNode, result } of results) {
					const counts = { 1: 0, 2: 0, 3: 0 };
					for(const node of filteredNodes.value) {
						if(node === siteNode || !hasSameRadio(node, result.radio)) continue;
						// repeaters and room servers are usually on roofs and masts, above the clutter
						const margin = result.marginAt(node.lon, node.lat, { clutter: !ELEVATED_NODE_TYPES.has(node.type) });
						const bars = margin === null ? 0 : getLinkBars(margin);
						if(!bars) continue;
						counts[bars]++;
						best.set(node, Math.max(best.get(node) ?? 0, bars));
					}
					site.linkCounts = counts;
				}
				// the sites themselves get no badge
				for(const node of siteNodes.value) best.delete(node);
				reachableLinks.value = [...best].map(([node, bars]) => ({ node, bars }));
			}

			// visible nodes changed (filters)
			watch(filteredNodes, updateLinkQuality);
			// how the estimate is made: behind the (i) button
			const coverageInfoOpen = ref(false);
			const coverageSensitivity = computed(() => coverage.radio ? Math.round(getSensitivity(coverage.radio)) : null);

			// --- Point-to-point profile ---

			// the ends as sites ({ lat, lon, adv_name, params }): nodes, or picked points
			function resolveProfileEnd(end) {
				if(!end) return null;
				if(end.publicKey) return nodesByKey.value.get(end.publicKey) ?? null;
				return getPointSite(end);
			}
			const profileEnds = computed(() => [resolveProfileEnd(profile.a), resolveProfileEnd(profile.b)]);
			// the radio preset applies when no end is a node with its own radio settings
			const profileUsesPreset = computed(() => profileEnds.value.every(end => !end || end.isPoint || !end.params));
			const profilePresets = computed(() => getPresetsNear([profile.a, profile.b]
				.map((end, i) => end && (end.publicKey ? profileEnds.value[i] : end))
				.filter(Boolean)));
			// { result, samples, clearance, radio, ends, heights }
			const profileView = shallowRef(null);
			const profileHover = ref(null);
			let profileRequest = 0;

			// radio values: from the first end that's a node with radio params, else from the area
			function getProfileRadio(ends, settings) {
				const node = ends.find(end => end && !end.isPoint && end.params) ?? ends.find(end => end?.params) ?? ends[0];
				return getCoverageRadio(node, settings);
			}

			watch(
				[profileEnds, () => profile.heightA, () => profile.heightB, () => { const { nodeDisplay, distanceKm, ...settings } = coverage.settings; return settings; }],
				async ([[a, b], heightA, heightB, settings], [previousEnds]) => {
					const request = ++profileRequest;
					profileHover.value = null;
					if(!a || !b) {
						profileView.value = null;
						profile.loading = false;
						return;
					}
					// only for new ends: not for setting changes or a dragged point
					const endsChanged = !sameSpot(a, previousEnds?.[0]) || !sameSpot(b, previousEnds?.[1]);
					if(endsChanged && !keepView) {
						nodePopup.close();
						map.fitBounds([[Math.min(a.lon, b.lon), Math.min(a.lat, b.lat)], [Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)]], {
							// room for the search box above (the profile panel is docked beside the map)
							padding: { top: 110, left: 40, right: 40, bottom: 40 },
							maxZoom: 13,
						});
					}
					const radio = getProfileRadio([a, b], settings);
					profile.loading = true;
					profile.error = '';
					try {
						const result = await computeLinkProfile(
							{ lat: a.lat, lon: a.lon, height: heightA },
							{ lat: b.lat, lon: b.lon, height: heightB },
							settings, radio,
						);
						if(request !== profileRequest) return;
						console.debug('profile', JSON.stringify(result.stats));
						const samples = getProfileLines(result, heightA, heightB);
						profileView.value = {
							result, samples, clearance: getClearance(samples), blocked: getBlockedRanges(samples), radio,
							ends: [a, b], heights: [heightA, heightB], bars: getLinkBars(result.margin),
							sensitivity: Math.round(getSensitivity(radio)),
						};
						if(result.incomplete) profile.error = 'Some terrain data could not be loaded, the profile is incomplete.';
					} catch(e) {
						if(request !== profileRequest) return;
						console.error(e);
						profileView.value = null;
						profile.error = `Profile could not be computed: ${e.message}`;
					} finally {
						if(request === profileRequest) profile.loading = false;
					}
				},
			);

			// the coverage and profile panels, docked to a side of the screen
			const dockOpen = computed(() => (coverage.sites.length > 0 || !!profile.a) && !deletionRequest.pickingOnMap);
			const { dock, dockSide, dockSides, setDockSide, startDockResize, toggleDockCollapsed } = useDock(() => dockOpen.value);
			// something new to show (a site added, a profile end picked): the collapsed dock opens
			watch([() => coverage.sites.length, () => profile.a, () => profile.b], ([sites, a, b], [previousSites, previousA, previousB]) => {
				if(sites > previousSites || (a && a !== previousA) || (b && b !== previousB)) dock.collapsed = false;
			});
			// the X in the dock's bar: everything in it
			function closeDock() {
				closeAllCoverage();
				closeProfile();
			}

			// the chart: redrawn on new data, hover, theme and size changes
			const profileCanvas = ref(null);
			let chartHitTest = () => null;
			const darkTheme = ref(isDarkTheme());
			onThemeChange(dark => { darkTheme.value = dark; });
			function drawChart() {
				const canvas = profileCanvas.value;
				if(!canvas || !profileView.value) return;
				chartHitTest = drawProfileChart(canvas, profileView.value.samples, { dark: darkTheme.value, hover: profileHover.value });
			}
			watch([profileView, profileHover, darkTheme], () => nextTick(drawChart));
			const chartResize = new ResizeObserver(() => drawChart());
			watch(profileCanvas, (canvas, previous) => {
				if(previous) chartResize.unobserve(previous);
				if(canvas) chartResize.observe(canvas);
			});
			function onChartPointer(ev) {
				const rect = ev.currentTarget.getBoundingClientRect();
				profileHover.value = chartHitTest(ev.clientX - rect.left);
			}
			function onChartLeave() {
				profileHover.value = null;
			}

			// planning marks on the map: the coverage sites that are picked points (numbered when there are
			// several sites), the profile ends with the line between them (red where the line of sight is
			// blocked) and the hovered spot
			// marks are told apart by a key: 'A', 'B' or the coverage site's id
			const markKey = ({ label, site }) => site ?? label;
			// a picked point being dragged: { key, lngLat }
			const dragPreview = shallowRef(null);
			const siteLabel = site => coverage.sites.length > 1 ? String(coverage.sites.indexOf(site) + 1) : '';
			// the profile through the air in the 3D view
			const profile3d = createProfile3d(map);
			watch(
				[() => coverage.sites.map(site => [site, site.point, siteLabel(site)]), profileEnds, profileHover, profileView, dragPreview],
				([sites, [a, b], hover, view, drag]) => {
					const at = (key, end) => drag?.key === key ? drag.lngLat : end && [end.lon, end.lat];
					const points = [];
					for(const [site, point, label] of sites) {
						const lngLat = at(site.id, point);
						if(lngLat) points.push({ lngLat, label, site: site.id });
					}
					for(const [label, end] of [['A', a], ['B', b]]) {
						const lngLat = at(label, end);
						if(lngLat) points.push({ lngLat, label });
					}
					const lineA = at('A', a), lineB = at('B', b);
					const line = lineA && lineB ? [lineA, lineB] : null;
					// the profile is for this line (not one being dragged or still being computed)
					const current = line && view && !drag && sameSpot(view.ends[0], a) && sameSpot(view.ends[1], b);
					const hoverPoint = current && hover !== null
						? interpolateMapLine(line[0], line[1], hover / (view.samples.length - 1))
						: null;
					setPlanningOverlay(map, { points, line, blocked: current ? view.blocked : [], hover: hoverPoint });
					profile3d.set(current ? { a: line[0], b: line[1], samples: view.samples, hover } : null);
				},
			);

			// turn handle of a directional antenna, on the selected coverage site
			const directionHandle = new DirectionHandle(map, bearing => { coverage.settings.direction = bearing; });
			watch(
				[() => coverage.settings.antennaType, () => coverage.settings.direction, () => coverage.activeId, () => coverage.publicKey, () => coverage.point, dragPreview],
				([type, direction, activeId, publicKey, point, drag]) => {
					const site = publicKey ? nodesByKey.value.get(publicKey) : point;
					const lngLat = !site ? null : drag?.key === activeId && point ? drag.lngLat : [site.lon, site.lat];
					directionHandle.update(type !== 'omni' ? lngLat : null, direction);
				},
				{ immediate: true },
			);

			// Picked points (not nodes) can be dragged around; the profile / coverage follows on release.
			// A coverage site's point that's clicked (not moved) gets selected.
			function getDraggableEnd(key) {
				if(key === 'A') return profile.a?.publicKey ? null : profile.a;
				if(key === 'B') return profile.b?.publicKey ? null : profile.b;
				return coverage.sites.find(site => site.id === key)?.point ?? null;
			}
			let dragging = null;
			function startDrag(ev) {
				const feature = ev.features?.[0];
				const key = feature ? markKey(feature.properties) : null;
				if(key === null || !getDraggableEnd(key)) return;
				ev.preventDefault();
				clearTimeout(pressTimer);
				closeMapMenu();
				dragging = { key, start: ev.point, moved: false };
				dragPreview.value = { key, lngLat: [ev.lngLat.lng, ev.lngLat.lat] };
				map.getContainer().classList.add('plan-dragging');
			}
			function moveDrag(ev) {
				if(!dragging) return;
				// a few pixels of jitter are still a click
				if(!dragging.moved && Math.hypot(ev.point.x - dragging.start.x, ev.point.y - dragging.start.y) < 4) return;
				dragging.moved = true;
				dragPreview.value = { key: dragging.key, lngLat: [ev.lngLat.lng, ev.lngLat.lat] };
			}
			function endDrag() {
				if(!dragging) return;
				const { key, moved } = dragging;
				const [lon, lat] = dragPreview.value.lngLat;
				dragging = null;
				dragPreview.value = null;
				map.getContainer().classList.remove('plan-dragging');
				if(typeof key === 'number') selectCoverageSite(key);
				if(!moved) return;
				keepView = true;
				if(key === 'A') profile.a = { lat, lon };
				else if(key === 'B') profile.b = { lat, lon };
				else coverage.point = { lat, lon };
				// the watchers run before the next render
				nextTick(() => { keepView = false; });
			}
			map.on('mousedown', 'planning-points', startDrag);
			map.on('touchstart', 'planning-points', ev => {
				if(ev.originalEvent.touches.length === 1) startDrag(ev);
			});
			map.on('mousemove', moveDrag);
			map.on('touchmove', moveDrag);
			map.on('mouseup', endDrag);
			map.on('touchend', endDrag);
			// grab cursor over the points that can be moved
			map.on('mousemove', 'planning-points', ev => {
				map.getContainer().classList.toggle('plan-hover', !!getDraggableEnd(markKey(ev.features[0].properties)));
			});
			map.on('mouseleave', 'planning-points', () => map.getContainer().classList.remove('plan-hover'));

			// --- Map menu: right click (long press on touch screens) anywhere on the map ---
			// pin: the label of the search pin it was opened on (it can be removed from the menu)
			const mapMenu = reactive({ open: false, x: 0, y: 0, lat: 0, lon: 0, pin: null });
			function openMapMenu(lngLat, clientX, clientY, pin = null) {
				Object.assign(mapMenu, { open: true, x: clientX, y: clientY, lat: lngLat.lat, lon: lngLat.lng, pin });
				// keep it on screen
				nextTick(() => {
					const menu = document.querySelector('.map-menu');
					if(!menu) return;
					mapMenu.x = Math.min(mapMenu.x, innerWidth - menu.offsetWidth - 8);
					mapMenu.y = Math.min(mapMenu.y, innerHeight - menu.offsetHeight - 8);
				});
			}
			function closeMapMenu() {
				mapMenu.open = false;
			}
			map.on('contextmenu', ev => {
				ev.preventDefault();
				openMapMenu(ev.lngLat, ev.originalEvent.clientX, ev.originalEvent.clientY);
			});
			// iOS doesn't send contextmenu for a long press
			let pressTimer = null, pressStart = null;
			map.on('touchstart', ev => {
				clearTimeout(pressTimer);
				if(ev.originalEvent.touches.length !== 1) return;
				const touch = ev.originalEvent.touches[0];
				pressStart = { x: touch.clientX, y: touch.clientY };
				pressTimer = setTimeout(() => {
					if(!mapMenu.open && !dragging) openMapMenu(ev.lngLat, pressStart.x, pressStart.y);
				}, 600);
			});
			map.on('touchmove', ev => {
				const touch = ev.originalEvent.touches[0];
				if(!pressStart || !touch || Math.hypot(touch.clientX - pressStart.x, touch.clientY - pressStart.y) > 10) clearTimeout(pressTimer);
			});
			map.on('touchend', () => clearTimeout(pressTimer));
			map.on('movestart', () => { clearTimeout(pressTimer); closeMapMenu(); });
			map.on('click', closeMapMenu);
			addEventListener('keydown', ev => { if(ev.key === 'Escape') closeMapMenu(); });

			function mapMenuCoverage() {
				requestPointCoverage(mapMenu.lat, mapMenu.lon);
				closeMapMenu();
			}
			function mapMenuProfileFrom() {
				setProfileStart({ lat: mapMenu.lat, lon: mapMenu.lon });
				closeMapMenu();
			}
			function mapMenuProfileTo() {
				addProfileEnd({ lat: mapMenu.lat, lon: mapMenu.lon });
				closeMapMenu();
			}
			function mapMenuRemovePin() {
				searchPin.clear();
				closeMapMenu();
			}
			function mapMenuCopy() {
				navigator.clipboard.writeText(`${mapMenu.lat.toFixed(5)}, ${mapMenu.lon.toFixed(5)}`);
				closeMapMenu();
			}

			// --- Sharing: coverage and profile in the URL ---
			function setUrlParam(key, value) {
				if(value === null || value === undefined || value === '') delete app.urlParams[key];
				else app.urlParams[key] = value;
			}
			// coverage sites, their settings and presets: one value per site, separated by ';'; the selected
			// site's number (from 1) with several of them; the profile uses the selected site's settings
			// and preset (or the ones new sites start with)
			watch(
				[
					() => coverage.sites.map(site => site.publicKey ?? encodeSite(site.point)).join(';'),
					() => encodeSite(profile.a), () => encodeSite(profile.b), () => `${profile.heightA},${profile.heightB}`,
					() => (coverage.sites.length ? coverage.sites.map(site => site.settings) : [coverage.settings]).map(encodeCoverageSettings).join(';'),
					() => (coverage.sites.length ? coverage.sites.map(site => site.radioPreset) : [coverage.radioPreset]).join(';'),
					() => coverage.sites.length > 1 ? coverage.sites.findIndex(site => site.id === coverage.activeId) + 1 : null,
					() => coverage.sites.length > 1 && coverage.highlightOverlaps,
				],
				([sites, a, b, heights, settings, presets, active, overlaps]) => {
					const planning = !!(sites || a);
					setUrlParam('cov', sites);
					setUrlParam('pa', a);
					setUrlParam('pb', a ? b : null);
					setUrlParam('ph', a ? heights : null);
					setUrlParam('covs', planning ? settings : null);
					setUrlParam('preset', planning && presets.replaceAll(';', '') ? presets : null);
					setUrlParam('cova', active);
					setUrlParam('covo', overlaps ? 1 : null);
				},
			);
			// a shared link: its settings, coverage and profile (once the nodes are there)
			function applySharedPlanning(params) {
				const settings = String(params.covs ?? '').split(';');
				// no preset in a shared link: the nearby repeaters' settings, like for whoever shared it
				const presets = String(params.preset ?? '').split(';');
				const sites = String(params.cov ?? '').split(';').map(decodeSite).filter(Boolean).slice(0, MAX_COVERAGE_SITES);
				if(!sites.length) {
					if(params.covs) applyCoverageSettings(settings[0]);
					if(params.pa) coverage.radioPreset = presets[0];
				}
				sites.forEach((site, i) => {
					const added = addCoverageSite(site.publicKey ? site : { point: site });
					applyCoverageSettings(settings[i] ?? settings[0], added.settings);
					added.radioPreset = presets[i] ?? '';
				});
				const active = coverage.sites[Number(params.cova) - 1];
				if(active) selectCoverageSite(active.id);
				coverage.highlightOverlaps = params.covo === '1';
				// (no heights in the URL: the defaults stay - an empty value would read as 0)
				const [heightA, heightB] = params.ph ? String(params.ph).split(',').map(Number) : [];
				const { min, max } = COVERAGE_SLIDERS.antennaHeight;
				if(Number.isInteger(heightA) && heightA >= min && heightA <= max) profile.heightA = heightA;
				if(Number.isInteger(heightB) && heightB >= min && heightB <= max) profile.heightB = heightB;
				const a = decodeSite(params.pa), b = decodeSite(params.pb);
				if(a) profile.a = a;
				if(a && b) profile.b = b;
			}

			function showNode(node) {
				// the previous node's popup would otherwise drift off-screen during the flight
				nodePopup.close();
				app.search = '';
				// while picking nodes for deletion, only fly to the node - a popup would cover its neighbours
				const openPopup = !deletionRequest.pickingOnMap;
				if(openPopup) {
					app.urlParams.public_key = node.public_key;
					// the focus zoom shows the node on its own (not clustered, spread out from overlapping nodes),
					// so the popup can open right after the flight
					map.once('moveend', () => nodePopup.open(node));
				}
				map.flyTo({
					center: [node.lon, node.lat],
					zoom: getNodeFocusZoom(node, NODE_FOCUS_ZOOM),
					duration: NODE_FLY_DURATION_SECONDS * 1000,
				});
			}

			async function downloadNodes() {
				app.loading = true;
				try {
					const list = await fetchNodes();

					await forEachChunked(list, NODE_PROCESSING_CHUNK_SIZE, prepareNode);

					nodesByType.value = groupByType(list);
					nodes.value = list;
				}
				catch(e) {
					console.error(e);
					alert(`There was an error loading map nodes: ${e.message}`);
				}
				finally {
					app.loading = false;
				}
			}

			map.on('moveend', () => {
				if(!app.urlParams.public_key) {
					setMapPosition(app.urlParams, map);
				}
			});

			onMounted(async () => {
				document.addEventListener('click', () => { app.filterOpen = false; });
				// the search box moves when the dialog scrolls or resizes (e.g. a node gets added to the list)
				new ResizeObserver(positionDeletionResults).observe(deletionDialog.value);
				deletionDialog.value.addEventListener('scroll', positionDeletionResults);
				window.addEventListener('resize', positionDeletionResults);
				document.addEventListener('keydown', ev => {
					if(ev.key === 'Escape' && deletionRequest.pickingOnMap) {
						// the reopened dialog would otherwise take this same keypress as its own Esc and close again
						ev.preventDefault();
						finishPickingOnMap();
					}
				});
				if(deletionRequest.open) deletionDialog.value.showModal();

				await downloadNodes();
				Object.assign(app, getFiltersFromUrl(urlParams));
				applySharedPlanning({ ...urlParams });

				// let watchers render the markers before trying to reveal a node
				await nextTick();
				if(urlParams.public_key) {
					const node = filteredNodes.value.find(n => n.public_key === urlParams.public_key);
					if(node) showNode(node);
				}
			});

			return {
				app, stats, searchResults, filtersActive, presetFilterOptions, presetFilterChoice,
				onSearchSelect, clearFilters, closeAllCoverage, selectCoverageSite, searchPoint, searchPlaceResults, showSearchResults, onSearchPoint, onSearchPlace, onSearchEnter,
				coverage, closeCoverage, compassPoint, coverageOptions: COVERAGE_OPTIONS, coverageSliders: COVERAGE_SLIDERS, coverageAntennaTypes: ANTENNA_TYPES, coverageReceiver: COVERAGE_RECEIVER, coverageFadeMargin: COVERAGE_FADE_MARGIN, buildingsMaxKm: BUILDINGS_MAX_DISTANCE / 1000,
				coverageSensitivity, coverageInfoOpen, coverageShadow3d,
				dockOpen, dock, dockSide, dockSides, setDockSide, startDockResize, toggleDockCollapsed, closeDock,
				profile, profileEnds, profileView, profileCanvas, onChartPointer, onChartLeave,
				closeProfile, swapProfileEnds, coveragePresets, profilePresets, profileUsesPreset,
				mapMenu, mapMenuCoverage, mapMenuRemovePin, mapMenuProfileFrom, mapMenuProfileTo, mapMenuCopy,
				nodeNamesZoom: NODE_NAMES_ZOOM,
				deletionRequest, deletionDialog, composeLinks, userAction, copiedField, copyText, onDeletionDialogClose,
				deletionNodes, deletionSearch, deletionSearchResults, selectDeletionNode, onDeletionSearchEsc,
				deletionSearchBox, deletionResultsPopover, showDeletionResults, isDeletionRequestFull, deletionMaxNodes,
				deletionSearchInput, pendingCount, isDeletionRequested, goToSendStep, addMoreNodes, onComposeLinkClick,
				markDeletionRequestSent, undoDeletionRequestSent,
				isInDeletionRequest, removeFromDeletionRequest, startPickingOnMap, finishPickingOnMap,
				deletionEmail: DELETION_EMAIL,
				deletionSubject: DELETION_SUBJECT,
			};
		},
	}).mount(selector);
}
