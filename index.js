import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import polyline from "@mapbox/polyline";
import * as turf from "@turf/turf";

let map = new maplibregl.Map({
	container: "map",
	style: "https://styles.trailsta.sh/openmaptiles-osm.json",
	center: [-121.900644, 37.331569],
	zoom: 18,
});

let popup = new maplibregl.Popup({
	closeButton: false
}).addTo(map);

addEventListener("load", () => {
	let examples = document.getElementById("examples");
	examples.value = "";
	
	examples.addEventListener("change", (event) => {
		let dataset = event.target.selectedOptions?.[0]?.dataset;
		let origin = [
			parseFloat(dataset.originLongitude), 
			parseFloat(dataset.originLatitude)
		];
		let destination = [
			parseFloat(dataset.destinationLongitude), 
			parseFloat(dataset.destinationLatitude)
		];
		fitWaypoints(origin, destination);
	});
	
	document.querySelectorAll(".coordinates").forEach(input => {
		input.value = "";
		input.addEventListener("change", () => {
			examples.value = "";
			acceptWaypoints();
		});
	});
	
	document.getElementById("calculate").addEventListener("click", async () => {
		clear();
		let response = await getRoute();
		plotRoute(response);
		receiveRoute(response);
	});
	
	document.getElementById("clear").addEventListener("click", () => {
		document.getElementById("examples").value = "";
		document.querySelectorAll(".coordinates").forEach(input => {
			input.value = "";
		});
		
		clear();
	});
});

// The options that openstreetmap-website sends to the FOSSGIS Valhalla instance, with some modifications.
const pedestrianCostingOptions = {
	use_ferry: 1, 
	use_living_streets: 0.5,
	use_tracks: 0,
	service_penalty: 15,
	service_factor: 1,
	shortest: false,
	use_hills: 0.5,
	walking_speed: 5.1,
	walkway_factor: 0.25, // a quarter of the cost
	sidewalk_factor: 0.25, // a quarter of the cost
	alley_factor: 2,
	driveway_factor: 5,
	step_penalty: 0,
	max_hiking_difficulty: 1,
	use_lit: 0,
	transit_start_end_max_distance: 2145,
	transit_transfer_max_distance: 800
};

function acceptWaypoints() {
	let origin = [
		parseFloat(document.getElementById("origin-longitude").value ?? 0),
		parseFloat(document.getElementById("origin-latitude").value ?? 0)
	];
	let destination = [
		parseFloat(document.getElementById("destination-longitude").value ?? 0),
		parseFloat(document.getElementById("destination-latitude").value ?? 0)
	];
	fitWaypoints(origin, destination);
}

function fitWaypoints(origin, destination) {
	document.getElementById("origin-latitude").value = origin[1];
	document.getElementById("origin-longitude").value = origin[0];
	document.getElementById("destination-latitude").value = destination[1];
	document.getElementById("destination-longitude").value = destination[0];
	
	let straightLine = turf.lineString([origin, destination]);
	map.fitBounds(turf.bbox(straightLine), {
		maxDuration: 1,
		padding: 20
	});
}

function clear() {
	document.querySelectorAll("#raw li, #matched li").forEach(list => list.remove());
	map.getSource("route")?.setData(turf.featureCollection([]));
	map.getSource("maneuvers")?.setData(turf.featureCollection([]));
	map.getSource("match")?.setData(turf.featureCollection([]));
	map.getSource("struts")?.setData(turf.featureCollection([]));
}

async function getRoute() {
	let originLatitude = parseFloat(document.getElementById("origin-latitude").value);
	let originLongitude = parseFloat(document.getElementById("origin-longitude").value);
	let destinationLatitude = parseFloat(document.getElementById("destination-latitude").value);
	let destinationLongitude = parseFloat(document.getElementById("destination-longitude").value);
	
	let routeOptions = {
		costing: "pedestrian",
		costing_options: {
			pedestrian: pedestrianCostingOptions
		},
		exclude_polygons: [],
		locations: [
			{
				lon: originLongitude,
				lat: originLatitude,
				type: "break"
			},
			{
				lon: destinationLongitude,
				lat: destinationLatitude,
				type: "break"
			}
		],
		units: "miles",
		alternates: 0,
		id: "valhalla_directions"
	};
	
	let request = new Request("https://valhalla1.openstreetmap.de/route?json=" + JSON.stringify(routeOptions));
	let response = await fetch(request);
	if (!response.ok) {
		throw new Error("Error fetching route: " + response.status);
	}
	return response.json();
}

async function receiveRoute(response) {
	console.log(response);
	
	let list = document.getElementById("raw");
	let leg = response.trip.legs[0];
	populateInstructions(list, leg);
	
	let pedestrianResponse = await getMatch('pedestrian', response);
	let autoResponse = await getMatch('auto', response);
	plotMatch(response, pedestrianResponse, autoResponse);
	receiveMatch(response, pedestrianResponse, autoResponse);
}

function plotRoute(response) {
	let leg = response.trip.legs[0];
	let lineString = polyline.toGeoJSON(leg.shape, 6);
	
	let routeCoords = polyline.decode(leg.shape, 6);
	let maneuverPoints = leg.maneuvers
		.map(m => routeCoords[m.begin_shape_index])
		.map(c => [c[1], c[0]]);
	
	let routeSource = map.getSource("route");
	if (routeSource) {
		routeSource.setData(lineString);
	} else {
		map.addSource("route", {
			type: "geojson",
			data: lineString
		});
		map.addSource("maneuvers", {
			type: "geojson",
			data: turf.multiPoint(maneuverPoints)
		});
	}
	if (!map.getLayer("route")) {
		map.addLayer({
			id: "route",
			type: "line",
			source: "route",
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
			paint: {
				"line-width": 4,
				"line-color": "purple",
				"line-opacity": 0.8
			}
		});
		map.addLayer({
			id: "maneuvers",
			type: "symbol",
			source: "maneuvers",
			layout: {
				"symbol-placement": "point",
				"text-field": "⌘",
				"text-overlap": "cooperative"
			},
			paint: {
				"text-color": "white",
				"text-halo-color": "purple",
				"text-halo-width": 1
			}
		});
	}
	map.fitBounds(turf.bbox(lineString), {
		padding: 20
	});
}

async function getMatch(costingModel, routeResponse) {
	let leg = routeResponse.trip.legs[0];
	let matchOptions = {
		encoded_polyline: leg.shape,
		shape_match: "map_snap",
		costing: costingModel,
		costing_options: {
			auto: {
				// Pedestrians can normally disregard restrictions that apply to the street.
				ignore_restrictions: true,
				ignore_non_vehicular_restrictions: true,
				// Sidewalks normally allow contraflow movement.
				ignore_oneways: true
			},
			pedestrian: pedestrianCostingOptions
		},
		directions_options: {
			units: "miles"
		}
	};
	
	let request = new Request("https://valhalla1.openstreetmap.de/trace_attributes?json=" + JSON.stringify(matchOptions));
	let response = await fetch(request);
	if (!response.ok) {
		throw new Error("Error matching route: " + response.status);
	}
	
	return response.json();
}

function receiveMatch(routeResponse, pedestrianResponse, autoResponse) {
	console.log(autoResponse, pedestrianResponse);
	
	let routeLeg = routeResponse.trip.legs[0];
	for (let maneuver of routeLeg.maneuvers) {
		annotateManuever(maneuver, pedestrianResponse, autoResponse);
	}
	routeLeg.maneuvers.forEach((maneuver, i, maneuvers) => {
		let prevManeuver = routeLeg.maneuvers[i - 1];
		let nextManeuver = routeLeg.maneuvers[i + 1];
		rewriteInstruction(maneuver, prevManeuver, nextManeuver);
	});
	
	let list = document.getElementById("matched");
	populateInstructions(list, routeLeg);
}

function plotMatch(routeResponse, pedestrianResponse, autoResponse) {
	let lineString = polyline.toGeoJSON(autoResponse.shape, 6);
	let routeCoords = polyline.decode(routeResponse.trip.legs[0].shape, 6);
	let struts = [];
	for (let i = 0; i < routeCoords.length; i++) {
		let pedestrianPoint = pedestrianResponse.matched_points[i];
		let autoPoint = autoResponse.matched_points[i];
		struts.push(turf.lineString([
			[pedestrianPoint.lon, pedestrianPoint.lat],
			[autoPoint.lon, autoPoint.lat]
		]));
	}
	struts = turf.featureCollection(struts);
	
	let matchSource = map.getSource("match");
	if (matchSource) {
		matchSource.setData(lineString);
		let strutPointsSource = map.getSource("struts");
		strutPointsSource.setData(struts);
	} else {
		map.addSource("match", {
			type: "geojson",
			data: lineString
		});
		map.addSource("struts", {
			type: "geojson",
			data: struts
		});
	}
	if (!map.getLayer("match")) {
		map.addLayer({
			id: "match",
			type: "line",
			source: "match",
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
			paint: {
				"line-width": 4,
				"line-color": "green",
				"line-opacity": 0.8,
				"line-dasharray": [1, 1]
			}
		}, "route");
		map.addLayer({
			id: "struts",
			type: "line",
			source: "struts",
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
			paint: {
				"line-width": 2,
				"line-color": "gray",
				"line-opacity": 0.6,
				"line-dasharray": [1, 2]
			}
		}, "route");
		map.addLayer({
			id: "strut-points",
			type: "circle",
			source: "struts",
			paint: {
				"circle-radius": 4,
				"circle-color": "gray"
			}
		}, "route");
	}
}

function annotateManuever(maneuver, pedestrianResponse, autoResponse) {
	let shapeIndex = maneuver.begin_shape_index;
	let autoPoint = autoResponse.matched_points[shapeIndex];
	let autoEdge = autoPoint && autoResponse.edges[autoPoint.edge_index];
	
	// If the maneuver doesn’t match a street edge, it may be at a street intersection.
	if (!autoEdge || (autoEdge.end_node && autoEdge.end_node.type === "street_intersection")) {
		// Announce the name of the street past the intersection along the route, not the street approaching the intersection.
		// Get the street matching the midpoint between this maneuver and the next one.
		shapeIndex = Math.ceil((maneuver.begin_shape_index + maneuver.end_shape_index) / 2);
		autoPoint = autoResponse.matched_points[shapeIndex];
		autoEdge = autoPoint && autoResponse.edges[autoPoint.edge_index];
	}
	
	// If the street edge is unnamed, there’s nothing to annotate the maneuver with.
	let name = autoEdge?.names?.[0];
	if (!name) {
		return;
	}
	
	maneuver.pedestrianPoint = pedestrianResponse.matched_points[shapeIndex];
	maneuver.pedestrianEdge = maneuver.pedestrianPoint && pedestrianResponse.edges[autoPoint.edge_index]; 
	maneuver.autoPoint = autoPoint;
	maneuver.autoEdge = autoEdge;
}

function rewriteInstruction(maneuver, prevManeuver, nextManeuver) {
	let autoEdge = maneuver.autoEdge;
	if (!autoEdge) {
		return false;
	}
	
	let autoName = autoEdge?.names?.[0];
	
	// If the maneuver matches a street edge that’s internal to an intersection, then it’s probably a crossing.
	// Ideally we’d check here if the matching pedestrian edge has a `use` of `pedestrian_crossing`, but this leads to a false positive whenever the route turns at a four-way junction with two crosswalks, avoiding the crosswalks. 
	if (autoEdge.internal_intersection) {
		let name = maneuver.name;
		
		// If the previous and next maneuvers are on the same street, then we’re probably crossing that street.
		let prevAutoName = prevManeuver?.autoEdge?.names?.[0];
		let nextAutoName = nextManeuver?.autoEdge?.names?.[0];
		if (!name && prevAutoName == nextAutoName) {
			name = prevAutoName;
		}
		
		let match = maneuver.instruction.match(/^Turn (left|right)/);
		let direction = '';
		if (match) {
			direction = ` to your ${match[1]}`;
		}
		
		maneuver.rewritten_instruction = `At ${autoName}, cross ${name || "the street"}${direction}.`;
		return true;
	}
	
	let match = maneuver.instruction.match(/^Turn (left|right) onto the crosswalk./);
	if (match) {
		maneuver.rewritten_instruction = `Cross ${autoName} at the crosswalk to your ${match[1]}.`;
		return true;
	}
	
	match = maneuver.instruction.match(/^Turn (left|right) onto the (walkway|crosswalk)./);
	if (match) {
		maneuver.rewritten_instruction = `Turn ${match[1]} and follow ${autoName}.`;
		return true;
	}
	
	match = maneuver.instruction.match(/^Walk (\w+) on the (walkway|crosswalk)./);
	if (match) {
		maneuver.rewritten_instruction = `Walk ${match[1]} along ${autoName}.`;
		return true;
	}
	
	return false;
}

function populateInstructions(list, leg) {
	let coords = polyline.decode(leg.shape, 6);
	for (let maneuver of leg.maneuvers) {
		let item = document.createElement("li");
		if (maneuver.rewritten_instruction) {
			item.className = "rewritten";
		}
		item.appendChild(document.createTextNode(maneuver.rewritten_instruction || maneuver.instruction));
		list.appendChild(item);
		item.addEventListener("click", () => {
			console.log(maneuver.pedestrianPoint, maneuver.pedestrianEdge, maneuver.autoPoint, maneuver.autoEdge);
			
			let coord = coords[maneuver.begin_shape_index];
			popup.setLngLat([coord[1], coord[0]]);
			if (maneuver.rewritten_instruction) {
				popup.setHTML(`<p><del>${maneuver.instruction}</del></p><p><ins>${maneuver.rewritten_instruction}</ins></p>`);
			} else {
				popup.setHTML(`<p>${maneuver.instruction}</p>`);
			}
			map.easeTo({
				center: [coord[1], coord[0]],
				zoom: 18
			});
		});
	}
}
