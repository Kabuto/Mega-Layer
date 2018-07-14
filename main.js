/*

TODO list:

* Render signal names at endpoints
* Fix undo/redo
* Support for structure elements
* Add multiselect/rubberband support for dots for dragging them all at once, add suppport for mirroring (maybe also rotating and maybe even scaling) for the points being dragged
* Find a better project name

*/

function init() {
	let db = new ClientDatabase();

	let tracesSvgMap = new Map();
	let tracesLayer = new SVGLayer();
	
	let lineWidth = 4;
	let halfLineWidth = lineWidth*.5;
	let lineWidthPx = lineWidth + "px";
	let halfLineWidthPx = (lineWidth*.5) + "px";
	
	let lineGroup = tracesLayer.append("g");
	let pointGroup = tracesLayer.append("g");

	let updateLayers = () => {
		let layers = [...db.getIdsOfType("layer")].map(id => [id, db.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0)).map(entry => entry[0]);
		let lastLayerSvgItem = null;
		for (let layer of layers) {
			let layerSvgItem = tracesSvgMap.get(layer);
			if (!layerSvgItem) {
				layerSvgItem = tracesLayer.appendTo(lineGroup, "g");
				tracesSvgMap.set(layer, layerSvgItem);
			}
			if (layerSvgItem.previousSibling != lastLayerSvgItem) {
				lineGroup.insertBefore(layerSvgItem, lastLayerSvgItem ? lastLayerSvgItem.nextSibling : lineGroup.firstChild);
			}
			lastLayerSvgItem = layerSvgItem;
		}
	};	
	
	let recomputeNames = () => {
		recomputeNamesTimeout = null;
		// Scan the database for groups of connected objects
		// Scan each group for names, assign a name to the group
		// Then scan the database for endpoints
		// Draw a name for each endpoint, avoiding other points and names
		
		
	};
	
	// We use a SVG-based data backend for now
	// This layer resembles all geometry that's currently stored in the database. Editing uses a different layer on top.
	// We might choose to replace this with a tile-based layer and do partial updates (even within tiles)
	// oldDataSupplier is a method that returns old data (from before the update) for any object when needed.
	let recomputeNamesTimeout = null;
	db.addChangeListener((id, oldData, newData, oldDataSupplier) => {
		let svgItem;
		// Added
		if (!oldData && !newData) return;
		if (recomputeNamesTimeout == null) {
			recomputeNamesTimeout = setTimeout(recomputeNames, 10);
		}
		if ((newData || oldData).type == "layer") {
			repaintLayers = true;
			return;
		}
		if (!oldData) {
			switch (newData.type) {
			case "point":
				svgItem = tracesLayer.appendTo(pointGroup, "circle", {class: "data-layer-point", r: halfLineWidth});
				break;
			case "line":
				let layer = db.get(newData.$layer$);
				let layerObj = null;
				if (layer) {
					layerObj = tracesSvgMap.get(newData.$layer$);
					if (!layerObj) {
						updateLayers();
						layerObj = tracesSvgMap.get(newData.$layer$);
					}
				}
				let p1 = db.get(newData.$point$1);
				let p2 = db.get(newData.$point$2);
				svgItem = tracesLayer.appendTo(layerObj || lineGroup, "line", {class: "data-layer-line", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y}, {stroke: layer && layer.color || "black", strokeWidth: lineWidthPx});
				break;
			default:
				throw new Error("Unsupported SVG item");
			}
			tracesSvgMap.set(id, svgItem);
		} else {
			svgItem = tracesSvgMap.get(id);
		}
		// Deleted
		if (!newData) {
			if (svgItem) svgItem.parentNode.removeChild(svgItem);
			tracesSvgMap.delete(id);
		}
		// Update object (and referrers too if some exist)
		if (newData) {
			switch (newData.type) {
			case "point":
				svgItem.setAttribute('cx', newData.x);
				svgItem.setAttribute('cy', newData.y);
				for (let id2 of db.getReferrers(id)) {
					let data = db.get(id2);
					let svgItem = tracesSvgMap.get(id2);
					if (!svgItem) continue;
					switch (data.type) {
					case "line":
						if (id == data.$point$1) {
							svgItem.setAttribute('x1', newData.x);
							svgItem.setAttribute('y1', newData.y);
						}
						if (id == data.$point$2) {
							svgItem.setAttribute('x2', newData.x);
							svgItem.setAttribute('y2', newData.y);
						}
						break;
					}
				}
				break;
			case "line":
				let p1 = db.get(newData.$point$1);
				let p2 = db.get(newData.$point$2);
				let line = tracesSvgMap.get(id);
				line.setAttribute('x1', p1.x);
				line.setAttribute('y1', p1.y);
				line.setAttribute('x2', p2.x);
				line.setAttribute('y2', p2.y);
				if (oldData && oldData.$layer$ != newData.$layer$) {
					let layer = db.get(newData.$layer$);
					let layerObj = null;
					if (layer) {
						layerObj = tracesSvgMap.get(newData.$layer$);
						if (!layerObj) {
							updateLayers();
							layerObj = tracesSvgMap.get(newData.$layer$);
						}
					}
					line.style.stroke = layer && layer.color || "black";
					(layerObj || lineGroup).appendChild(line);
				}
				break;
			case "layer":
				updateLayers();
				if (oldData) {
					for (let id2 of db.getReferrers(id)) {
						let data = db.get(id2);
						if (data.type == "line") {
							let line = tracesSvgMap.get(id2);
							if (line) {
								line.style.stroke = newData.color || "black";
							}
						}
					}
				}
				break;
			}
		}
	});
	
	let editLayer = new SVGLayer();

	let geometryHelper = {
		lineWidth: lineWidth,
		halfLineWidth: halfLineWidth,
		lineWidthPx: lineWidthPx,
		halfLineWidthPx: halfLineWidthPx,

		distance(a,b) {
			let dx = a.x-b.x;
			let dy = a.y-b.y;
			return Math.sqrt(dx*dx+dy*dy);
		},
		
		getPointAt(e, except) {
			let nearestPoint = null, nearestPointDistance = halfLineWidth;
			for (let id of db.getIdsOfType("point")) {
				let data = db.get(id);
				let dist = this.distance(e,data);
				if (dist < nearestPointDistance && id != except) {
					nearestPointDistance = dist;
					nearestPoint = id;
				}
			}
			return nearestPoint;
		},
	
		getLineAt(e, except) {
			let nearestLine = null, nearestLineDistance = halfLineWidth, nearestPointOnLine = null;
			for (let id of db.getIdsOfType("line")) {
				// only needs to cover the rect area, no rounded caps needed as they are already handled by getPointAt
				let data = db.get(id);
				if (data.$point$1 == except || data.$point$2 == except) continue;
				let a = db.get(data.$point$1);
				let b = db.get(data.$point$2);
				let dx = b.x-a.x;
				let dy = b.y-a.y;
				if (dx == 0 && dy == 0) continue;
				let dxa = a.x-e.x;
				let dya = a.y-e.y;
				// distance to line, assuming its length being infinite
				let dist = Math.abs(dx*dya - dy*dxa)/Math.sqrt(dx*dx+dy*dy);
				let pointOnLine = -(dx*dxa + dy*dya)/(dx*dx + dy*dy);
				if (dist < nearestLineDistance && pointOnLine > 0 && pointOnLine < 1) {
					nearestLineDistance = dist;
					nearestLine = id;
					nearestPointOnLine = pointOnLine;
				}
			}
			if (nearestLine == null) return null;
			let data = db.get(nearestLine);
			let a = db.get(data.$point$1);
			let b = db.get(data.$point$2);
			return ({id: nearestLine, x: a.x+(b.x-a.x)*nearestPointOnLine, y: a.y+(b.y-a.y)*nearestPointOnLine});
		}
	};

	let layerState = {
		hiddenLayers: new Set(),
		mapHidden: false,
		activeLayer: null
	};
	

	
	// Next up: edit tools
	
	// TODO add multilayer editing functionality
	// Idea: numbers = layer hotkeys
	// press digit for selecting that layer, forcing it visible if not already
	// press shift+digit for selecting that layer and viewing it exclusively, do again for viewing all layers
	// press ctrl+1-0 for toggling visibility of that layer
	// Idea: F keys for selecting tools
	
	// TODO rubberband for edit tool on mousedown when not in line mode?
	
	let editTools = [
		{name: "none"}, 
		new ViewTool(db, editLayer, geometryHelper),
		new LineTool(db, editLayer, geometryHelper, layerState),
		new SettingsTool(db)
	];
	
	// 0 = no tool, to be switched later
	let currentTool = 0;
	
	let mapLayer = new MapLayer(config.map.tileSize, config.map.tileProvider);
	
	let settings = localStorage.getItem("settings");
	settings = settings ? JSON.parse(settings) : {};
	
	let mapView = new MapView(window.innerWidth, window.innerHeight, config.map.width, config.map.height, [
		//new ImageLayer("example.jpg", 10),
		mapLayer,
		tracesLayer,
		editLayer
	], {
		mousedown: (e) => { 		if (editTools[currentTool].mousedown) editTools[currentTool].mousedown(e);		},
		mousemove: (e) => {			if (editTools[currentTool].mousemove) editTools[currentTool].mousemove(e);		},
		mouseup: (e) => {			if (editTools[currentTool].mouseup) editTools[currentTool].mouseup(e);			},
		dragstart: (e) => {			if (editTools[currentTool].dragstart) editTools[currentTool].dragstart(e);			},
		drag: (e) => {				if (editTools[currentTool].drag) editTools[currentTool].drag(e);			},
		dragend: (e) => {			if (editTools[currentTool].dragend) editTools[currentTool].dragend(e);			},
	}, settings);
	window.mapView = mapView;
	window.addEventListener("resize", e => mapView.resize(window.innerWidth, window.innerHeight));

	window.addEventListener("keypress", e => {
		if (e.keyCode >= 112 && (e.keyCode-111) < editTools.length) {
			editTools[currentTool].deactivate();
			editTools[currentTool].div.style.background = "#999";
			currentTool = e.keyCode-111;
			editTools[currentTool].div.style.background = "#666";
			editTools[currentTool].activate();
			e.preventDefault();
			return;
		}
		if (suspendKeyEvents) return;
		console.log(e);
		// escape aborts
		if (e.keyCode == 27 && editTools[currentTool].abort) editTools[currentTool].abort();
		// del deletes currently selected objects
		else if (e.keyCode == 46 && editTools[currentTool].delete) editTools[currentTool].delete();
		// Ctrl+Z/Y to undo/redo
		else if (e.charCode == 122 && e.ctrlKey && !e.shiftKey) db.undo();
		else if (e.charCode == 121 && e.ctrlKey && !e.shiftKey) db.redo();
		else return;
		e.preventDefault();
	});
	
	mapView.div.style.position = "fixed";
	mapView.div.style.left = "0";
	mapView.div.style.top = "0";
	mapView.div.style.right = "0";
	mapView.div.style.bottom = "0";
	document.body.style.overflow = "hidden";
	document.documentElement.style.overflow = "hidden";

	let loadingHint = document.createElement("div");
	loadingHint.textContent = "loading...";
	loadingHint.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;text-align:center;background:rgba(0,0,0,.5);color:white;font-size:100px;";
	mapView.div.appendChild(loadingHint);

	document.body.appendChild(mapView.div);
	
	db.addGeneralUpdateListener(() => {
		if (editTools[currentTool].change3) editTools[currentTool].change3(); 
	});
	db.addUpdateListener((oldState, newState, getOldData, getNewData) => {
		if (editTools[currentTool].change2) editTools[currentTool].change2(oldState, newState, getOldData, getNewData); 
	});
	db.addChangeListener((id, oldData, newData, oldDataSupplier) => {
		if (editTools[currentTool].change) editTools[currentTool].change(id, oldData, newData, oldDataSupplier); 
	});

	db.init(backendProvider).then(() => {
		if (loadingHint.parentNode) loadingHint.parentNode.removeChild(loadingHint);
		if (editTools[currentTool].deactivate) editTools[currentTool].deactivate();
		currentTool = 1;
		if (editTools[currentTool].activate) editTools[currentTool].activate();
		editTools[currentTool].div.style.background = "#666";
	}).catch(e => console.error(e));

	let LayerTool = {
		div: null,
		init() {
			
		}
	};

	let suspendKeyEvents = false;
	let layerToolbox = document.createElement("div");
	layerToolbox.style.cssText = "position:fixed;right:10px;top:10px;border:1px solid #666;background:#999;";
	document.body.appendChild(layerToolbox);
	
	let repaintLayers = false;
	let repaintLayersFunc = () => {
		if (layerState.activeLayer != null && db.get(layerState.activeLayer) && !repaintLayers) return;
		repaintLayers = false;
		if (!db.get(layerState.activeLayer)) layerState.activeLayer = null;
		let layers = [...db.getIdsOfType("layer")].map(id => [id, db.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0));
		for (let k of layerState.hiddenLayers) if (!db.get(k)) layerState.hiddenLayers.delete(k);
		
		while (layerToolbox.lastChild) layerToolbox.removeChild(layerToolbox.lastChild);
		for (let [id, data] of layers) {
			let p = document.createElement("div");
			let visibilityControl = p.appendChild(document.createElement("span"));
			visibilityControl.textContent = "👁";
			if (layerState.hiddenLayers.has(id)) visibilityControl.style.opacity = 0.3;
			let svgItem = tracesSvgMap.get(id);
			if (svgItem) svgItem.style.visibility = layerState.hiddenLayers.has(id) ? "hidden" : "visible"; 
			visibilityControl.onclick = () => {
				if (layerState.hiddenLayers.has(id)) layerState.hiddenLayers.delete(id); else layerState.hiddenLayers.add(id);
				repaintLayers = true;
				repaintLayersFunc();
			};
			p.appendChild(visibilityControl);
			/*let viewExclusivelyControl = p.appendChild(document.createElement("span"));
			viewExclusivelyControl.textContent = "#";
			if (layerState.hiddenLayers.size == layers.length-1 && !layerState.hiddenLayers.has(id)) {
				viewExclusivelyControl.onclick = () => {
					layerState.hiddenLayers = new Set();
					setActiveLayer(id, true);
				};
			} else {
				viewExclusivelyControl.style.opacity = 0.3;
				viewExclusivelyControl.onclick = () => {
					layerState.hiddenLayers = new Set(layers.map(l => l[0]));
					layerState.hiddenLayers.delete(id);
					setActiveLayer(id, true);
				};
			}
			p.appendChild(viewExclusivelyControl);*/
			let nameControl = p.appendChild(document.createElement("span"));
			nameControl.textContent = data.name;
			nameControl.onclick = () => setActiveLayer(id);
			if (id == layerState.activeLayer) { p.className = "active"; p.style.background = "#666"; }
			
			let colorIndicator = nameControl.insertBefore(document.createElement("span"), nameControl.firstChild);
			colorIndicator.style.cssText = "display:inline-block;width:10px;height:10px;border: 1px solid black;";
			colorIndicator.style.backgroundColor = data.color;
			
			
			p.appendChild(nameControl);
			layerToolbox.appendChild(p);
		}
		{
			// add map layer entry
			let p = document.createElement("div");
			let visibilityControl = p.appendChild(document.createElement("span"));
			visibilityControl.textContent = "👁";
			if (layerState.mapHidden) visibilityControl.style.opacity = 0.3;
			mapLayer.container.style.visibility = layerState.mapHidden ? "hidden" : "visible"; 
			visibilityControl.onclick = () => {
				layerState.mapHidden = !layerState.mapHidden;
				repaintLayers = true;
				repaintLayersFunc();
			};
			p.appendChild(visibilityControl);
			/*let viewExclusivelyControl = p.appendChild(document.createElement("span"));
			viewExclusivelyControl.textContent = "#";
			if (layerState.hiddenLayers.size == layers.length) {
				viewExclusivelyControl.onclick = () => {
					layerState.hiddenLayers = new Set();
					setActiveLayer(null, true);
				};
			} else {
				viewExclusivelyControl.style.opacity = 0.3;
				viewExclusivelyControl.onclick = () => {
					layerState.hiddenLayers = new Set(layers.map(l => l[0]));
					setActiveLayer(null, true);
				};
			}
			p.appendChild(viewExclusivelyControl);*/
			let nameControl = p.appendChild(document.createElement("span"));
			nameControl.textContent = "map";
			nameControl.onclick = () => setActiveLayer(null);
			//if (id == layerState.activeLayer) { p.className = "active"; p.style.background = "#666"; }
			
			let colorIndicator = nameControl.insertBefore(document.createElement("span"), nameControl.firstChild);
			colorIndicator.style.cssText = "display:inline-block;width:10px;height:10px;border: 1px solid transparent;";
			
			
			p.appendChild(nameControl);
			layerToolbox.appendChild(p);
		}
	};
	let setActiveLayer = (id, force) => {
		if (id != null && (!db.get(id) || db.get(id).type != "layer")) throw new Error();
		if (id == layerState.activeLayer && !force) return;
		layerState.activeLayer = id;
		repaintLayers = true;
		repaintLayersFunc();
	};
	window.addEventListener("keydown", e => {
		if (suspendKeyEvents) return;
		if (e.keyCode < 48 || e.keyCode > 57) return;
		let num = (e.keyCode+1)%10;
		let layers = [...db.getIdsOfType("layer")].map(id => [id, db.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0));
		let id = num < layers.length ? layers[num][0] : null;
		if (e.ctrlKey) {
			if (id != null) {
				if (layerState.hiddenLayers.has(id)) layerState.hiddenLayers.delete(id); else layerState.hiddenLayers.add(id);
			} else {
				layerState.mapHidden = !layerState.mapHidden;
			}
			repaintLayers = true;
			repaintLayersFunc();
		/*} else if (e.shiftKey) {
			if (id != null) {
				layerState.hiddenLayers = (layerState.hiddenLayers.size == layers.length-1 && !layerState.hiddenLayers.has(id)) ? new Set() : new Set(layers.map(l => l[0]));
				layerState.hiddenLayers.delete(id);
			} else {
				layerState.hiddenLayers = layerState.hiddenLayers.size == layers.length ? new Set() : new Set(layers.map(l => l[0]));
			}
			setActiveLayer(id, true);*/
		} else {
			setActiveLayer(id);
		}
		e.preventDefault();
	});
	
	for (let i = 1; i < editTools.length; i++) {
		let div = document.createElement("div");
		div.textContent = editTools[i].name;
		div.style.cssText = "position:fixed;left:10px;top:" + ((i-1)*30+10) + "px;width:20px;height:20px;overflow:hidden;border:1px solid black;background:#999;";
		editTools[i].div = div;
		document.body.appendChild(div);
		div.setAttribute("data-index", i);
		div.onclick = function() {
			editTools[currentTool].deactivate();
			editTools[currentTool].div.style.background = "#999";
			currentTool = +this.getAttribute("data-index");
			editTools[currentTool].div.style.background = "#666";
			editTools[currentTool].activate();
		};
	}
	
	
	
	db.addGeneralUpdateListener(repaintLayersFunc);
}