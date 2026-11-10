import { createApp, reactive, ref, computed, watch, onMounted, nextTick, shallowRef } from '../lib/vue.esm-browser.prod.js';
import { DELETION_EMAIL, DELETION_SUBJECT, DEFAULT_FILTERS, NODE_FLY_DURATION_SECONDS, NODE_FOCUS_ZOOM, NODE_PROCESSING_CHUNK_SIZE, SEARCH_RESULT_LIMIT } from './config.js';
import {
	addToDeletionRequest, buildDeletionBody, deletionMaxNodes, deletionRequest, getComposeLinks, getPendingKeys, getUserAction,
	isDeletionRequested, isDeletionRequestFull, markDeletionRequestSent, undoDeletionRequestSent,
	isInDeletionRequest, removeFromDeletionRequest, toggleInDeletionRequest,
} from './deletion.js';
import {
	COVERAGE_OPTIONS, FADE_MARGIN_DB as COVERAGE_FADE_MARGIN, RECEIVER as COVERAGE_RECEIVER,
	closeCoverage, computeCoverage, computeLinkProfile, coverage, releaseCoverage, getCoverageBounds, getCoverageRadio, getLinkBars,
	getLocalRadioParams, getSensitivity, hasSameRadio, requestPointCoverage, applyCoverageSettings, encodeCoverageSettings, requestCoverage,
} from './coverage.js';
import {
	createHighlightLayer, createNodeLayer, createNodePopup, getNodeFocusZoom, interpolateMapLine, NODE_NAMES_ZOOM,
	setCoverageOverlay, setLinkQuality, setNodeNames, setPlanningOverlay,
} from './map.js';
import { PROFILE_HEIGHTS, addProfileEnd, closeProfile, profile, setProfileStart, swapProfileEnds } from './profile.js';
import { drawProfileChart, getClearance, getProfileLines } from './profile-chart.js';
import { isDarkTheme, onThemeChange } from './theme.js';
import { NodeSearchResults } from './node-search-results.js';
import {
	collectFrequencies, computeStats, fetchNodes, filterNodes, groupByType, prepareNode, searchNodes,
} from './nodes.js';
import { findPresets, getRadioPresets, loadPresets, presetsLoaded } from './presets.js';
import { clearMapPosition, decodeSite, encodeSite, getFiltersFromUrl, setMapPosition, writeUrlParams } from './url-state.js';
import { forEachChunked } from './utils.js';
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
		sameMembers(state.freqFilter, DEFAULT_FILTERS.freqFilter) &&
		state.fromDate === DEFAULT_FILTERS.fromDate &&
		state.fromInsertDate === DEFAULT_FILTERS.fromInsertDate &&
		state.onlyDuplicates === DEFAULT_FILTERS.onlyDuplicates;
}

export function mountApp(selector, { map, urlParams }) {
	return createApp({
		components: { NodeSearchResults },
		setup() {
			const app = reactive({
				...cloneDefaultFilters(),
				search: '',
				availableFreqs: [],
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

			// With default filters every node is shown (including ones older than the default dates)
			const filteredNodes = computed(() =>
				isDefaultFilter(app) ? nodes.value : filterNodes(nodesByType.value, app)
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
				nodePopup.open(node);
			}

			watch(() => app.clusteringZoom, zoom => {
				app.urlParams.cluster = zoom;
				nodeLayer.setClusteringZoom(zoom);
			});


			watch(
				[() => app.nodeFilter, () => app.freqFilter, () => app.fromDate, () => app.fromInsertDate, () => app.onlyDuplicates],
				() => {
					app.urlParams.nodes = app.nodeFilter.join(',');
					app.urlParams.freq = app.freqFilter.join(',');
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

			// radio presets for picked points (the community presets, loaded once)
			const radioPresets = shallowRef([]);
			loadPresets().then(() => { radioPresets.value = getRadioPresets(); }, console.error);
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
			function getPointSite({ lat, lon }, settings = coverage.settings) {
				return {
					lat,
					lon,
					adv_name: `point ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
					params: selectedRadioPreset.value?.radio ?? getLocalRadioParams(lat, lon, nodes.value, settings),
					isPoint: true,
				};
			}
			const sameSpot = (a, b) => !!a && !!b && a.lat === b.lat && a.lon === b.lon;
			// set while a dropped point gets its new position: the map stays where it is
			let keepView = false;

			// Repeater coverage: recomputed when the node or a setting changes; results of superseded
			// requests are dropped
			let coverageRequest = 0;
			// the current estimate and the node it's for, to rate links to the visible nodes
			let coverageResult = null;
			const coverageNode = shallowRef(null);
			// shows an estimate (null: none) and frees the previous one's image
			function setCoverageResult(result, node) {
				const previous = coverageResult;
				coverageResult = result;
				coverageNode.value = node;
				setCoverageOverlay(map, result);
				if(previous !== result) releaseCoverage(previous);
				updateLinkQuality();
			}
			// nodes in reach of the estimate (with the same radio settings): [{ node, bars }], null without an estimate
			const reachableLinks = shallowRef(null);

			// "reachable only" display: just the repeater and the nodes in its reach, nothing clustered
			const showReachableOnly = computed(() => reachableLinks.value !== null && coverage.settings.nodeDisplay === 'reachable');
			// (a picked point isn't a node: it has a planning mark instead)
			const displayedNodes = computed(() => showReachableOnly.value
				? [...(coverageNode.value?.isPoint ? [] : [coverageNode.value]), ...reachableLinks.value.map(link => link.node)]
				: filteredNodes.value);

			// badges after the nodes: they follow the nodes' placement (spread out ones)
			watch([displayedNodes, showReachableOnly], ([nodes, reachableOnly]) => {
				nodeLayer.setClustering(!reachableOnly, nodes);
				// names only in the "reachable only" display, where there are few nodes to label
				const source = coverageNode.value?.isPoint ? null : coverageNode.value;
				setLinkQuality(map, reachableLinks.value ?? [], { labels: reachableOnly, source });
			});

			// the "reachable only" display has names of its own
			watch([() => app.showNodeNames, showReachableOnly], ([show, reachableOnly]) => {
				setNodeNames(map, show && !reachableOnly);
			}, { immediate: true });
			watch(() => app.showNodeNames, show => {
				try { localStorage.setItem(NODE_NAMES_STORAGE_KEY, String(show)); } catch {}
			});

			// Link quality for visible nodes with the same radio settings as the estimate
			function updateLinkQuality() {
				if(!coverageResult) {
					reachableLinks.value = null;
					coverage.linkCounts = null;
					return;
				}
				const links = [];
				const counts = { 1: 0, 2: 0, 3: 0 };
				for(const node of filteredNodes.value) {
					if(node === coverageNode.value || !hasSameRadio(node, coverageResult.radio)) continue;
					// repeaters and room servers are usually on roofs and masts, above the clutter
					const margin = coverageResult.marginAt(node.lon, node.lat, { clutter: !ELEVATED_NODE_TYPES.has(node.type) });
					const bars = margin === null ? 0 : getLinkBars(margin);
					if(!bars) continue;
					links.push({ node, bars });
					counts[bars]++;
				}
				reachableLinks.value = links;
				coverage.linkCounts = counts;
			}

			// visible nodes changed (filters)
			watch(filteredNodes, updateLinkQuality);
			// the settings take a lot of room on short screens - start collapsed there
			const coverageSettingsOpen = ref(innerHeight > 820);
			// how the estimate is made: behind the (i) button
			const coverageInfoOpen = ref(false);
			const coverageSensitivity = computed(() => coverage.radio ? Math.round(getSensitivity(coverage.radio)) : null);

			watch(
				// the display mode doesn't change the estimate
				[() => coverage.publicKey, () => coverage.point, () => { const { nodeDisplay, ...settings } = coverage.settings; return settings; }, selectedRadioPreset],
				async ([publicKey, point, settings], [previousKey, previousPoint, previousSettings]) => {
					const request = ++coverageRequest;
					const node = publicKey ? nodesByKey.value.get(publicKey) : point ? getPointSite(point, settings) : null;
					if(!node) {
						setCoverageResult(null, null);
						if(publicKey) closeCoverage();
						return;
					}

					coverage.name = node.adv_name;
					coverage.radio = getCoverageRadio(node, settings);
					const moved = publicKey !== previousKey || (point !== previousPoint && !keepView);
					if(moved || settings.distanceKm !== previousSettings?.distanceKm) {
						// the popup would cover the coverage area
						nodePopup.close();
						// with the profile panel open too, there's little room left: settings collapsed
						if(profile.a && moved) {
							coverageSettingsOpen.value = false;
							await nextTick();
						}
						// room for the stats bar, search box and coverage panel above, the profile panel below
						// (with both open, the coverage area may go under the coverage panel)
						const bottom = (document.querySelector('.profile-panel')?.offsetHeight ?? 0) + 30;
						const top = Math.min(
							document.querySelector('.coverage-panel')?.getBoundingClientRect().bottom + 20 || 260,
							Math.max(110, map.getContainer().clientHeight - bottom - 150),
						);
						map.fitBounds(getCoverageBounds(node.lon, node.lat, settings.distanceKm), {
							padding: { top, bottom, left: 20, right: 20 },
						});
					}

					coverage.loading = true;
					coverage.error = '';
					try {
						const result = await computeCoverage(node, settings);
						if(request !== coverageRequest) {
							releaseCoverage(result);
							return;
						}
						console.debug('coverage', JSON.stringify(result.stats));
						setCoverageResult(result, node);
						if(result.incomplete) coverage.error = 'Some terrain data could not be loaded, the estimate is incomplete.';
					} catch(e) {
						if(request !== coverageRequest) return;
						console.error(e);
						setCoverageResult(null, null);
						coverage.error = `Coverage could not be computed: ${e.message}`;
					} finally {
						if(request === coverageRequest) coverage.loading = false;
					}
				},
			);

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
							// room for the search box above and the profile panel (with its chart) below
							padding: { top: 110, left: 40, right: 40, bottom: Math.min(innerHeight * 0.6, 520) + 40 },
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
							result, samples, clearance: getClearance(samples), radio,
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

			// the profile panel's height, for the coverage panel above it (CSS --profile-panel-height)
			const profilePanelResize = new ResizeObserver(([entry]) => {
				document.body.style.setProperty('--profile-panel-height', `${entry.target.offsetHeight}px`);
			});
			watch(() => !!profile.a, open => nextTick(() => {
				const panel = document.querySelector('.profile-panel');
				if(open && panel) profilePanelResize.observe(panel);
				else {
					profilePanelResize.disconnect();
					document.body.style.removeProperty('--profile-panel-height');
				}
			}));

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

			// planning marks on the map: the coverage point, the profile ends, the hovered spot
			// a picked point being dragged: { label, lngLat }
			const dragPreview = shallowRef(null);
			watch(
				[() => coverage.point, profileEnds, profileHover, profileView, dragPreview],
				([point, [a, b], hover, view, drag]) => {
					const at = (label, end) => drag?.label === label ? drag.lngLat : end && [end.lon, end.lat];
					const points = [];
					for(const [label, end] of [['', point], ['A', a], ['B', b]]) {
						const lngLat = at(label, end);
						if(lngLat) points.push({ lngLat, label });
					}
					const lineA = at('A', a), lineB = at('B', b);
					const line = lineA && lineB ? [lineA, lineB] : null;
					const hoverPoint = line && view && hover !== null && !drag
						? interpolateMapLine(line[0], line[1], hover / (view.samples.length - 1))
						: null;
					setPlanningOverlay(map, { points, line, hover: hoverPoint });
				},
			);

			// Picked points (not nodes) can be dragged around; the profile / coverage follows on release
			function getDraggableEnd(label) {
				if(label === 'A') return profile.a?.publicKey ? null : profile.a;
				if(label === 'B') return profile.b?.publicKey ? null : profile.b;
				return coverage.point;
			}
			let dragging = null;
			function startDrag(ev) {
				const label = ev.features?.[0]?.properties.label ?? '';
				if(!getDraggableEnd(label)) return;
				ev.preventDefault();
				clearTimeout(pressTimer);
				closeMapMenu();
				dragging = { label };
				dragPreview.value = { label, lngLat: [ev.lngLat.lng, ev.lngLat.lat] };
				map.getContainer().classList.add('plan-dragging');
			}
			function moveDrag(ev) {
				if(!dragging) return;
				dragPreview.value = { label: dragging.label, lngLat: [ev.lngLat.lng, ev.lngLat.lat] };
			}
			function endDrag() {
				if(!dragging) return;
				const { label } = dragging;
				const [lon, lat] = dragPreview.value.lngLat;
				dragging = null;
				map.getContainer().classList.remove('plan-dragging');
				keepView = true;
				if(label === 'A') profile.a = { lat, lon };
				else if(label === 'B') profile.b = { lat, lon };
				else coverage.point = { lat, lon };
				dragPreview.value = null;
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
				map.getContainer().classList.toggle('plan-hover', !!getDraggableEnd(ev.features[0].properties.label ?? ''));
			});
			map.on('mouseleave', 'planning-points', () => map.getContainer().classList.remove('plan-hover'));

			// --- Map menu: right click (long press on touch screens) anywhere on the map ---
			const mapMenu = reactive({ open: false, x: 0, y: 0, lat: 0, lon: 0 });
			function openMapMenu(lngLat, clientX, clientY) {
				Object.assign(mapMenu, { open: true, x: clientX, y: clientY, lat: lngLat.lat, lon: lngLat.lng });
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
			function mapMenuCopy() {
				navigator.clipboard.writeText(`${mapMenu.lat.toFixed(5)}, ${mapMenu.lon.toFixed(5)}`);
				closeMapMenu();
			}

			// --- Sharing: coverage and profile in the URL ---
			function setUrlParam(key, value) {
				if(value === null || value === undefined || value === '') delete app.urlParams[key];
				else app.urlParams[key] = value;
			}
			watch(
				[
					() => coverage.publicKey ?? encodeSite(coverage.point), () => encodeSite(profile.a), () => encodeSite(profile.b),
					() => `${profile.heightA},${profile.heightB}`, () => encodeCoverageSettings(coverage.settings), () => coverage.radioPreset,
				],
				([coverageSite, a, b, heights, settings, preset]) => {
					// the profile uses the coverage settings and the preset too
					const planning = !!(coverageSite || a);
					setUrlParam('cov', coverageSite);
					setUrlParam('pa', a);
					setUrlParam('pb', a ? b : null);
					setUrlParam('ph', a ? heights : null);
					setUrlParam('covs', planning ? settings : null);
					setUrlParam('preset', planning ? preset : null);
				},
			);
			// a shared link: its settings, coverage and profile (once the nodes are there)
			function applySharedPlanning(params) {
				if(params.covs) applyCoverageSettings(params.covs);
				// no preset in a shared link: the nearby repeaters' settings, like for whoever shared it
				if(params.cov || params.pa) coverage.radioPreset = params.preset ?? '';
				const [heightA, heightB] = String(params.ph ?? '').split(',').map(Number);
				if(PROFILE_HEIGHTS.includes(heightA)) profile.heightA = heightA;
				if(PROFILE_HEIGHTS.includes(heightB)) profile.heightB = heightB;
				const a = decodeSite(params.pa), b = decodeSite(params.pb);
				if(a) profile.a = a;
				if(a && b) profile.b = b;
				const site = decodeSite(params.cov);
				if(site?.publicKey) requestCoverage(site.publicKey);
				else if(site) requestPointCoverage(site.lat, site.lon);
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
					app.availableFreqs = collectFrequencies(list);
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
				app, stats, searchResults, filtersActive,
				onSearchSelect, clearFilters,
				coverage, closeCoverage, coverageOptions: COVERAGE_OPTIONS, coverageReceiver: COVERAGE_RECEIVER, coverageFadeMargin: COVERAGE_FADE_MARGIN,
				coverageSensitivity, coverageSettingsOpen, coverageInfoOpen,
				profile, profileEnds, profileView, profileHeights: PROFILE_HEIGHTS, profileCanvas, onChartPointer, onChartLeave,
				closeProfile, swapProfileEnds, coveragePresets, profilePresets, profileUsesPreset,
				mapMenu, mapMenuCoverage, mapMenuProfileFrom, mapMenuProfileTo, mapMenuCopy,
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
