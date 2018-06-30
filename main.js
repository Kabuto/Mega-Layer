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

	let svgns = "http://www.w3.org/2000/svg";
	let tracesSvgMap = new Map();
	let tracesLayer = new SVGLayer();
	
	let lineWidth = 4;
	let halfLineWidth = lineWidth*.5;
	let lineWidthPx = lineWidth + "px";
	let halfLineWidthPx = (lineWidth*.5) + "px";
	
	let lineGroup = document.createElementNS(svgns, "g");
	tracesLayer.svg.appendChild(lineGroup);
	let pointGroup = document.createElementNS(svgns, "g");
	tracesLayer.svg.appendChild(pointGroup);

	let updateLayers = () => {
		let layers = [...db.getIdsOfType("layer")].map(id => [id, db.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0)).map(entry => entry[0]);
		let lastLayerSvgItem = null;
		for (let layer of layers) {
			let layerSvgItem = tracesSvgMap.get(layer);
			if (!layerSvgItem) {
				layerSvgItem = document.createElementNS(svgns, "g");
				tracesSvgMap.set(layer, layerSvgItem);
				lineGroup.appendChild(layerSvgItem);
			}
			if (layerSvgItem.previousSibling != lastLayerSvgItem) {
				lineGroup.insertBefore(layerSvgItem, lastLayerSvgItem ? lastLayerSvgItem.nextSibling : lineGroup.firstChild);
			}
			lastLayerSvgItem = layerSvgItem;
		}
	};
	
	let appendSVGItem = (parent, name, attrs, style) => {
		let item = document.createElementNS(svgns, name);
		if (attrs) for (let i in attrs) if (attrs[i] != null) item.setAttribute(i, attrs[i]);
		if (style) for (let i in style) if (style[i] != null) item.style[i] = style[i];
		if (parent) parent.appendChild(item);
		return item;
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
				svgItem = appendSVGItem(pointGroup, "circle", {class: "data-layer-point", r: halfLineWidth});
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
				svgItem = appendSVGItem(layerObj || lineGroup, "line", {class: "data-layer-line", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y}, {stroke: layer && layer.color || "black", strokeWidth: lineWidthPx});
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

	let distance = function(a,b) {
		let dx = a.x-b.x;
		let dy = a.y-b.y;
		return Math.sqrt(dx*dx+dy*dy);
	};
	
	let getPointAt = function(e, except) {
		let nearestPoint = null, nearestPointDistance = halfLineWidth;
		for (let id of db.getIdsOfType("point")) {
			let data = db.get(id);
			let dist = distance(e,data);
			if (dist < nearestPointDistance && id != except) {
				nearestPointDistance = dist;
				nearestPoint = id;
			}
		}
		return nearestPoint;
	};
	
	let getLineAt = function(e, except) {
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
	};

	
	
	// Next up: edit tools
	
	// TODO add multilayer editing functionality
	// Idea: numbers = layer hotkeys
	// press digit for selecting that layer, forcing it visible if not already
	// press shift+digit for selecting that layer and viewing it exclusively, do again for viewing all layers
	// press ctrl+1-0 for toggling visibility of that layer
	// Idea: F keys for selecting tools
	
	// TODO rubberband for edit tool on mousedown when not in line mode?
	
	let editTools = [{name: "none"}, {
		name: "view",
		
		activate() {
			this.hoveringGroup = appendSVGItem(editLayer.svg, "g");
			this.selectedGroup = appendSVGItem(editLayer.svg, "g");
		},
		
		deactivate() {
			while (editLayer.svg.lastChild) editLayer.svg.removeChild(editLayer.svg.lastChild);
			this.selected = null;
			this.hovering = null;
			this.selectedGroup = null;
			this.hoveringGroup = null;
			this.lastMousemoveCoords = null;
			if (this.controls) {
				this.controls.parentNode.removeChild(this.controls);
				this.controls = null;
				suspendKeyEvents = false;
			}
			document.body.title = "";
		},
		
		select(line) {
			this.selected = line;
			this.markAllOf(this.selected, this.selectedGroup, " view-tool-selected");
			if (this.controls) {
				this.controls.parentNode.removeChild(this.controls);
				this.controls = null;
			}
			if (this.selected) {
				let signals = new Set();
				for (let id of this.scanConnectedObjects(this.selected)) {
					let data = db.get(id);
					if (data.type == "line" && data.signal) {
						signals.add(data.signal);
					}
				}
			
				let controls = this.controls = document.createElement("div");
				this.controls.style.cssText = "position:fixed;left: 50px; top: 10px; background: #888;";
				this.controls.appendChild(document.createTextNode("Signal (click to edit): "));
				let input = document.createElement("span");
				input.style.cssText = "background:#ccc;";
				input.textContent = [...signals].join(" / ");
				this.controls.appendChild(input);
				controls.onclick = () => {
					let newText = prompt("Enter a new name for this signal", input.textContent);
					if (newText != null) this.updateName(newText);
				};
				document.body.appendChild(controls);
			}
		},
		
		mousedown(e) {
			if (e.button == 0) {
				this.select(this.hovering);
			}
		},
		
		updateName(text) {
			let network = this.scanConnectedObjects(this.selected);
			let named = new Set();
			for (let id of this.scanConnectedObjects(this.selected)) {
				let data = db.get(id);
				if (data.type == "line" && data.signal) {
					named.add(id);
				}
			}
			let updates = [];
			if (named.size > 1) {
				for (let id of named) {
					let data = db.get(id);
					delete data.signal;
					updates.push({id: id, oldData: true, data: data});
				}
				named = new Set();
			}
			let id = named.size == 1 ? [...named][0] : this.selected;
			let data = db.get(id);
			if (text) {
				data.signal = text;
			} else {
				delete data.signal;
			}
			updates.push({id: id, oldData: true, data: data});
			db.modify(updates);
		},
		
		mousemove(e) {
			// TODO add rubberband selection (also for edit tool) - but here including all overlapped items, not just fully contained items
			// TODO allow rubberband to select multiple objects
			// TODO allow ctrl-click
			// TODO indicate hovered objects even when they are selected
			
			// TODO for edit tool, allow moving lines to different layers (context menu)
			
			// TODO add settings menu (loading / saving of data / changing settings)
			let point = getPointAt(e);
			let line = null;
			if (point) {
				let pointData = db.get(point);
				let nearestLineDistance = 0;
				for (let ref of db.getReferrers(point)) {
					let data = db.get(ref);
					if (data.type != "line") continue;
					let otherPointData = db.get(point == data.$point$1 ? data.$point$2 : data.$point$1);
					let dist = distance(pointData, otherPointData);
					let test = {
						x: pointData.x + (otherPointData.x-pointData.x)/dist,
						y: pointData.y + (otherPointData.y-pointData.y)/dist
					};
					let dist2 = distance(test, e);
					if (line == null || dist2 < nearestLineDistance) {
						line = ref;
						nearestLineDistance = dist2;
					}
				}
			}
			if (line == null) {
				let lineInfo = getLineAt(e);
				line = lineInfo ? lineInfo.id : null;
			}
			if (line == this.hovering) return;
			this.hovering = line;
			this.markAllOf(line, this.hoveringGroup, " view-tool-hovering");
			this.lastMousemoveCoords = {x: e.x, y: e.y};
			
			let signals = new Set();
			if (this.hovering) {
				let signals = new Set();
				for (let id of this.scanConnectedObjects(this.hovering)) {
					let data = db.get(id);
					if (data.type == "line" && data.signal) {
						signals.add(data.signal);
					}
				}
				document.body.title = [...signals].join(" / ");
			} else {
				document.body.title = "";
			}
		},
		
		scanConnectedObjects(line) {
			let ldata = db.get(line);
			let queue = [ldata.$point$1, ldata.$point$2];
			let scanned = new Set([line, ldata.$point$1, ldata.$point$2]);
			while (queue.length) {
				for (let ref of db.getReferrers(queue.shift())) {
					if (scanned.has(ref)) continue;
					scanned.add(ref);
					let data = db.get(ref);
					if (data.type != "line") continue;
					if (!scanned.has(data.$point$1)) {
						scanned.add(data.$point$1);
						queue.push(data.$point$1);
					}
					if (!scanned.has(data.$point$2)) {
						scanned.add(data.$point$2);
						queue.push(data.$point$2);
					}
				}
			}
			return scanned;
		},
		
		markAllOf(line, group, classPostfix) {
			this.clear(group);
			if (line == null) return;
			// mark
			for (let id of this.scanConnectedObjects(line)) {
				let data = db.get(id);
				switch (data.type) {
				case "point":
					appendSVGItem(group, "circle", {class: "view-tool-point" + classPostfix, r: halfLineWidth, cx: data.x, cy: data.y});
					break;
				case "line":
					let p1 = db.get(data.$point$1);
					let p2 = db.get(data.$point$2);
					appendSVGItem(group, "line", {class: "view-tool-line" + classPostfix, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y}, {strokeWidth: lineWidthPx});
					break;
				}
			}
		},
		
		change3() {
			this.clear(this.hoveringGroup);
			document.body.title = "";
			// this re-enables hovering
			if (this.lastMousemoveCoords) this.mousemove(this.lastMousemoveCoords);
			let oldSelected = this.selected;
			this.select(oldSelected != null && db.get(oldSelected) ? oldSelected : null);
		},
		
		clear(node) {
			while (node.lastChild) node.removeChild(node.lastChild);
		}
		
	}, {
		name: "lines",

		// the marker that indicates where an action will take place
		dot: null,
		// SVG shapes to indicate all active dots
		dotMap: null,
		// the active lines
		lines: null,
		
		// location/ingredients of the current mousedown action
		point: null,
		// ID of the locally created database object
		pointId: null,
		// associated DB data
		pointData: null,
		// start position of the current mouse action
		startPos: null,
		// state of the current mouse action ("mousedown" / "dragging" / null)
		state: null,

		// previously selected point(s)
		lastPoints: null,
		
		addDot(id, data) {
			let dot = appendSVGItem(editLayer.svg, "circle", {class: "edit-tool-point", r: halfLineWidth, cx: data.x, cy: data.y});
			this.dotMap.set(id, dot);
		},
		
		// called upon activating this layer, followed up by a "mousemove" call to reset all mouse-over activity
		activate() {
			this.dot = appendSVGItem(editLayer.svg, "circle", {class: "edit-tool-marker", r: halfLineWidth});
			this.dotMap = new Map();
			for (let id of db.getIdsOfType("point")) {
				this.addDot(id, db.get(id));
			}
		},
		deactivate() {
			while (editLayer.svg.lastChild) editLayer.svg.removeChild(editLayer.svg.lastChild);
			this.dot = null;
			this.dotMap = null;
			this.lines = null;
		},
		getPoint(e, except) {
			let nearestPoint = getPointAt(e, except);
			if (nearestPoint) return ({type: "point", coords: db.get(nearestPoint), point: nearestPoint, create: () => nearestPoint});
			let nearestLine = except != null || nearestPoint ? null : getLineAt(e, except);
			if (nearestLine) return ({type: "line", coords: nearestLine, line: nearestLine, create: () => {
				let id = db.insert({type: "point", x: nearestLine.x, y: nearestLine.y});
				let data = db.get(nearestLine.id);
				let newData = Object.assign({}, data);
				let newData2 = Object.assign({}, data);
				newData.$point$2 = id;
				newData2.$point$1 = id;
				db.update(nearestLine.id, data, newData);
				db.insert(newData2);
				return id;
			}});
			return ({type: "new", coords: e, create: () => db.insert({type: "point", x: e.x, y: e.y})});
		},
		mousedown(e) {
			// * mousedown activates a point (click point = activate, click line = split line up by creating new point, click elsewhere = create new point there)
			//   * if line mode was active, a line is drawn there from the previous point, unless there's already a line or the starting point was clicked
			// * clicking (i.e. not dragging) starts a new line, unless line mode was active and an existing point or a point on a line was clicked or the line was cancelled
			// * dragging moves the active point but does not start a line when finished
			// * pressing escape will abort
			// * modifying any involved object during mousedown will abort
			// -> create dummy on mousedown, don't create the actual point
			if (e.button == 0) {
				// initiate point action
				this.point = this.getPoint(e);
				if ((activeLayer == null || hiddenLayers.has(activeLayer)) && this.point.type != "point") {
					this.point = null;
					return;
				}				
				
				db.setUncommitted();
				this.pointId = this.point.create();
				this.pointData = db.get(this.pointId);
				this.startPos = {x: e.x, y: e.y};
				// draw point insertion placeholder
				this.state = "mousedown";
				this.dot.setAttribute("class", "edit-tool-marker edit-tool-marker-mousedown");
				this.mousemove(e);
			}
		},
		checkAbort() {
			if (this.point && (!db.isUncommitted() || this.pointId == null)) {
				this.abort();
			}
		},
		abort() {
			// edit action got aborted
			if (db.isUncommitted()) db.rollback();
			this.state = null;
			this.point = null;
			this.pointId = null;
			this.pointData = null;
			this.startPos = null;
			this.dot.setAttribute("class", "edit-tool-marker");
			this.lastPoints = null;
			if (this.lines) {
				this.lines.forEach(l => l.parentNode.removeChild(l));
				this.lines = null;
			}
		},
		delete() {
			// press during drag'n'drop to delete point and adjacent lines
			if (this.state) {
				let id = this.pointId;
				this.state = null;
				this.point = null;
				this.pointId = null;
				this.pointData = null;
				this.startPos = null;
				this.dot.setAttribute("class", "edit-tool-marker");
				this.lastPoints = null;
				if (this.lines) {
					this.lines.forEach(l => l.parentNode.removeChild(l));
					this.lines = null;
				}
				for (let id2 of db.getReferrers(id)) {
					db.delete(id2);
				}
				db.delete(id);
				db.commit();
			}
		},
		mousemove(e) {
			this.checkAbort();
			let updateDotAndLines = pos => {
				this.dot.setAttribute('cx', pos.x);
				this.dot.setAttribute('cy', pos.y);
				if (this.lines) {
					let p0 = db.get(this.lastPoints[0]);
					for (let i = 0; i < this.lastPoints.length; i++) {
						let px = db.get(this.lastPoints[i]);
						this.lines[i].setAttribute('x2', pos.x+px.x-p0.x);
						this.lines[i].setAttribute('y2', pos.y+px.y-p0.y);
					}
				}
			};
			if (this.state == "dragging") {
				this.dragPos = ({
					x: e.x+this.point.coords.x-this.startPos.x, 
					y: e.y+this.point.coords.y-this.startPos.y
				});
				this.dragTarget = this.getPoint(this.dragPos, this.pointId);
				let pos = this.dragTarget.coords;
				updateDotAndLines(pos);
				let newData = Object.assign({}, this.pointData);
				newData.x = pos.x;
				newData.y = pos.y;
				db.update(this.pointId, this.pointData, newData);
				this.pointData = newData;
				return;
			}

			// TODO this causes glitches
			// TODO merge further points too, not just the one being dragged
			let pos = this.getPoint(e).coords;
			if (e.originalEvent.ctrlKey && this.lastPoints) {
				let data = db.get(this.lastPoints[0]);
				if (Math.abs(pos.x-data.x) > Math.abs(pos.y-data.y)) {
					pos.y = data.y;
				} else {
					pos.x = data.x;
				}
			}
			updateDotAndLines(pos);
		},
		dragstart(e) {
			if (this.state == "mousedown") {
				this.state = "dragging";
				console.log("state: " + this.state);
				this.mousemove(e);
			}
		},
		mouseup(e) {
			this.checkAbort();
			if (e.button == 0 && (this.state == "mousedown" || this.state == "dragging")) {
				this.dot.setAttribute("class", "edit-tool-marker");
				let oldState = this.state;
				this.state = null;
				console.log("state: " + this.state);

				let point = this.point;
				this.point = null;
				let id = this.pointId;
				this.pointId = null;
				let data = this.pointData;
				this.pointData = null;
				
				db.commit();
				
				let insertLineIfNoDuplicate = data => {
					if (data.$point$1 == data.$point$2) return false;
					for (let lid of db.getIdsOfType("line")) {
						let ldata = db.get(lid);
						if (ldata.$point$1 == data.$point$1 && ldata.$point$2 == data.$point$2 || ldata.$point$2 == data.$point$1 && ldata.$point$1 == data.$point$2) {
							return false;
						}
					}
					db.insert(data);
					return true;
				};
				
				let checkLineIsUnique = (id, data) => {
					for (let lid of db.getIdsOfType("line")) {
						let ldata = db.get(lid);
						if (id != lid && (ldata.$point$1 == data.$point$1 && ldata.$point$2 == data.$point$2 || ldata.$point$2 == data.$point$1 && ldata.$point$1 == data.$point$2)) {
							return false;
						}
					}
					return true;
				};

				if (oldState == "dragging") {
					switch (this.dragTarget.type) {
					case "point":
						// merge 2 points
						// this means reconnecting all lines, so we delete and re-add them all
						let existingPointRefs = new Set(db.getReferrers(this.dragTarget.point));
						let ourRefs = db.getReferrers(id);
						for (let lid of ourRefs) {
							let data = db.get(lid);
							if (existingPointRefs.has(data.$point$1) || existingPointRefs.has(data.$point$2)) {
								// line would be connected to both points -> abort
								db.delete(lid);
							}
							let newData = Object.assign({}, data);
							for (let i in newData) if (i[0] == "$" && newData[i] == id) newData[i] = this.dragTarget.point;
							if (checkLineIsUnique(lid, newData)) {
								db.update(lid, data, newData);
							} else {
								db.delete(lid, data);
							}
						}
						db.delete(id);
						id = null;
						this.lastPoints = null;
						break;
					case "line":
						// split line into 2 halves with existing point
						let lineId = this.dragTarget.line.id;
						let line = db.get(lineId);
						db.delete(lineId);
						insertLineIfNoDuplicate(Object.assign({}, line, {$point$1: id}));
						insertLineIfNoDuplicate(Object.assign({}, line, {$point$2: id}));
						break;
					default:
						// nothing special
						break;
					}
				}
				
				// TODO if shift is pressed, add point to selection instead as new first point or remove it again (and don't destroy selection upon dragging)
				// TODO if multiple points are selected, draw parallel line from all of them
				if (e.originalEvent.shiftKey && this.lastPoints) {
					let idx = this.lastPoints.indexOf(id);
					if (idx != -1) {
						this.lastPoints.splice(idx, 1);
						if (this.lastPoints.length == 0) {
							this.lastPoints = null;
						}
					} else {
						this.lastPoints.unshift(id);
					}
				} else {
					let lastPoints = this.lastPoints;
					this.lastPoints = oldState == "mousedown" && activeLayer != null && !hiddenLayers.has(activeLayer) ? [id] : null;
					if (lastPoints) {
						// draw line
						let duplicate = false;
						let p0 = db.get(lastPoints[0]);
						for (let i = 0; i < lastPoints.length; i++) {
							let px = db.get(lastPoints[i]);
							let point2;
							if (i == 0) {
								point2 = id;
							} else {
								point2 = db.insert({type: "point", x: px.x-p0.x+data.x, y: px.y-p0.y+data.y});
								if (this.lastPoints) this.lastPoints.push(point2);
							}
							duplicate = duplicate | !insertLineIfNoDuplicate({type: "line", $point$1: lastPoints[i], $point$2: point2, $layer$: activeLayer});
						}
						if (duplicate || point.type != "new") {
							this.lastPoints = null;
						}
					}
				}
				if (this.lines) {
					this.lines.forEach(l => l.parentNode.removeChild(l));
					this.lines = null;
				}
				if (this.lastPoints) {
					this.lines = [];
					this.lines = this.lastPoints.map(id => {
						let data = db.get(id);
						let line = appendSVGItem(editLayer.svg, "line", {class: "edit-tool-line"}, {strokeWidth: halfLineWidthPx});
						line.setAttribute('x1', data.x);
						line.setAttribute('y1', data.y);
						line.setAttribute('x2', data.x);
						line.setAttribute('y2', data.y);
						return line;
					});
				}
			}
		},
		change2(oldState, newState) {
			//console.log("change2: " + JSON.stringify(oldState) + " => " + JSON.stringify(newState));
			if (oldState && this.lastPoints) {
				let idx = this.lastPoints.indexOf(oldState.id);
				if (idx != -1) {
					if (newState) {
						this.lastPoints[idx] = newState.id;
						if (this.line) {
							this.line.setAttribute('x1', newState.data.x);
							this.line.setAttribute('y1', newState.data.y);
						}
					} else {
						this.lastPoints = null;
						if (this.line) {
							this.line.parentNode.removeChild(this.line);
							this.line = null;
						}
					}
				}
			}
			if (oldState && this.pointId == oldState.id) {
				this.pointId = newState ? newState.id : null;
			}
		},
		change(id, oldData, newData, oldDataSupplier) {
			let dot = this.dotMap.get(id);
			if (dot) {
				if (newData) {
					dot.setAttribute('cx', newData.x);
					dot.setAttribute('cy', newData.y);
				} else {
					this.dotMap.delete(id);
					dot.parentNode.removeChild(dot);
				}
			} else if (newData && newData.type == "point") {
				this.addDot(id, newData);
			}
		}
	}, {
		name: "settings",
		activate() {
			let c = (name, ...attrsOrChildren) => {
				let result = document.createElement(name);
				for (let item of attrsOrChildren) {
					if (item == null) continue;
					if (item.nodeType) {
						result.appendChild(item);
					} else if (typeof(item) == "object") {
						for (let i in item) {
							if (item[i] == null) continue;
							if (i == "style" && typeof(item[i]) == "object") {
								for (let j in item[i]) {
									if (item[i][j] != null) result.style[j] = item[i][j];
								}
							} else if (typeof(item[i]) == "function") {
								result[i] = item[i];
							} else {
								result.setAttribute(i, item[i]);
							}
						}
					} else {
						result.appendChild(document.createTextNode(item.toString()));
					}
				}
				return result;
			};
			let settings = mapView.getSettings();
			
			this.dialog = c("div", {class: "dialog"});
			document.body.appendChild(this.dialog);
			
			let handleExport = () => {
				let text;
				let layer = this.dialog.appendChild(c("div", {class: "dialog-popup"},
					c("div", "Export"),
					text = c("textarea", {class: "dialog-importexport"}),
					c("div",
						c("input", {type: "button", value: "Close", onclick: () => layer.parentNode.removeChild(layer)})
					)
				));
				text.value = localStorage.getItem("dieshot");
			};
			
			let handleImport = () => {
				let text;
				let layer = this.dialog.appendChild(c("div", {class: "dialog-popup"},
					c("div", "Import"),
					text = c("textarea", {class: "dialog-importexport"}),
					c("div",
						c("input", {type: "button", value: "Use", onclick: () => {
							try {
								new Database().modify(JSON.parse(text.value));
								localStorage.setItem("dieshot", text.value);
								document.body.innerHTML = "";
								location.reload();
							} catch (e) {
								console.log(e);
								alert("Failed to import: " + e.message);
							}
						}}),
						c("input", {type: "button", value: "Cancel", onclick: () => layer.parentNode.removeChild(layer)})
					)
				));
			};
			let updateSetting = (name, value) => {
				let settings = mapView.getSettings();
				settings[name] = value;
				mapView.setSettings(settings);
				localStorage.setItem("settings", JSON.stringify(settings));
			};
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Map controls"),
					c("label", {class: "dialog-row", title: "Checked = like a map (wheel zooms), unchecked = like a document (wheel scrolls Y, shift+wheel scrolls X, ctrl+wheel zooms)"},
						c("span", {class: "dialog-row-label"}, "Wheel zooms map"),
						c("span", c("input", {type: "checkbox", checked: settings.wheelZoom || null, onchange: function() {updateSetting("wheelZoom", this.checked)}}))
					),
					c("label", {class: "dialog-row", title: "Checked = zoom from/to what's under the mouse pointer, unchecked = ignore mouse pointer and zoom from/to the middle of the window"},
						c("span", {class: "dialog-row-label"}, "Zoom at mouse pointer"),
						c("span", c("input", {type: "checkbox", checked: settings.zoomAtPointer || null, onchange: function() {updateSetting("zoomAtPointer", this.checked)}}))
					),
					c("label", {class: "dialog-row", title: "Mouse button for dragging the map around"},
						c("span", {class: "dialog-row-label"}, "Map drag button"),
						c("span", c("select",
							{onchange: function() {updateSetting("dragButton", this.value ? +this.value : null)}},
							c("option", {value: ""}, "none"),
							...["left", "middle/wheel", "right", "fourth", "fifth"].map((t, idx) => c("option", {value: idx, selected: settings.dragButton==idx || null}, t))
						))
					),
					c("label", {class: "dialog-row", title: "How far the mouse needs to be moved to detect dragging instead of clicking"},
						c("span", {class: "dialog-row-label"}, "Drag threshold"),
						c("span", c("input", {type: "number", value: settings.dragThreshold, onchange: function() {if (!isNaN(+this.value)) updateSetting("dragThreshold", +this.value)}}))
					)
				)
			);
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Import/export"),
					c("label", {class: "dialog-row", title: "Click to import a snapshot, deleting existing database contents. Hint: type [] to replace with an empty database."},
						c("span", {class: "dialog-row-label"}, "Import (replacing database)"),
						c("span", c("input", {type: "button", value: "Import", onclick: handleImport}))
					),
					c("label", {class: "dialog-row", title: "Click to export the current database state as a snapshot"},
						c("span", {class: "dialog-row-label"}, "Export database"),
						c("span", c("input", {type: "button", value: "Export", onclick: handleExport}))
					)
				),
			);
			let addLayerName, addLayerColor;
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Add layer"),
					c("label", {class: "dialog-row"}, "This is a temporary workaround while there's no layer GUI. As of now, layers can only be reordered/renamed/deleted through exporting, editing and importing."),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, "Name"),
						c("span", addLayerName = c("input", {type: "text", value: ""}))
					),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, "HTML color"),
						c("span", addLayerColor = c("input", {type: "text", value: "#123456"}))
					),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, ""),
						c("span", c("input", {type: "button", value: "Add layer", onclick: () => db.insert({type: "layer", name: addLayerName.value, color: addLayerColor.value, order: 0})}))
					)
				),
			);
			mapView.suspendEvents();
			suspendKeyEvents = true;
		},
		deactivate() {
			this.dialog.parentNode.removeChild(this.dialog);
			this.dialog = null;
			mapView.resumeEvents();
			suspendKeyEvents = false;
		}
	}];
	
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
	
	let hiddenLayers = new Set();
	let mapHidden = false;
	
	let activeLayer = null;
	let repaintLayers = false;
	let repaintLayersFunc = () => {
		if (activeLayer != null && db.get(activeLayer) && !repaintLayers) return;
		repaintLayers = false;
		if (!db.get(activeLayer)) activeLayer = null;
		let layers = [...db.getIdsOfType("layer")].map(id => [id, db.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0));
		for (let k of hiddenLayers) if (!db.get(k)) hiddenLayers.delete(k);
		
		while (layerToolbox.lastChild) layerToolbox.removeChild(layerToolbox.lastChild);
		for (let [id, data] of layers) {
			let p = document.createElement("div");
			let visibilityControl = p.appendChild(document.createElement("span"));
			visibilityControl.textContent = "👁";
			if (hiddenLayers.has(id)) visibilityControl.style.opacity = 0.3;
			let svgItem = tracesSvgMap.get(id);
			if (svgItem) svgItem.style.visibility = hiddenLayers.has(id) ? "hidden" : "visible"; 
			visibilityControl.onclick = () => {
				if (hiddenLayers.has(id)) hiddenLayers.delete(id); else hiddenLayers.add(id);
				repaintLayers = true;
				repaintLayersFunc();
			};
			p.appendChild(visibilityControl);
			/*let viewExclusivelyControl = p.appendChild(document.createElement("span"));
			viewExclusivelyControl.textContent = "#";
			if (hiddenLayers.size == layers.length-1 && !hiddenLayers.has(id)) {
				viewExclusivelyControl.onclick = () => {
					hiddenLayers = new Set();
					setActiveLayer(id, true);
				};
			} else {
				viewExclusivelyControl.style.opacity = 0.3;
				viewExclusivelyControl.onclick = () => {
					hiddenLayers = new Set(layers.map(l => l[0]));
					hiddenLayers.delete(id);
					setActiveLayer(id, true);
				};
			}
			p.appendChild(viewExclusivelyControl);*/
			let nameControl = p.appendChild(document.createElement("span"));
			nameControl.textContent = data.name;
			nameControl.onclick = () => setActiveLayer(id);
			if (id == activeLayer) { p.className = "active"; p.style.background = "#666"; }
			
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
			if (mapHidden) visibilityControl.style.opacity = 0.3;
			mapLayer.container.style.visibility = mapHidden ? "hidden" : "visible"; 
			visibilityControl.onclick = () => {
				mapHidden = !mapHidden;
				repaintLayers = true;
				repaintLayersFunc();
			};
			p.appendChild(visibilityControl);
			/*let viewExclusivelyControl = p.appendChild(document.createElement("span"));
			viewExclusivelyControl.textContent = "#";
			if (hiddenLayers.size == layers.length) {
				viewExclusivelyControl.onclick = () => {
					hiddenLayers = new Set();
					setActiveLayer(null, true);
				};
			} else {
				viewExclusivelyControl.style.opacity = 0.3;
				viewExclusivelyControl.onclick = () => {
					hiddenLayers = new Set(layers.map(l => l[0]));
					setActiveLayer(null, true);
				};
			}
			p.appendChild(viewExclusivelyControl);*/
			let nameControl = p.appendChild(document.createElement("span"));
			nameControl.textContent = "map";
			nameControl.onclick = () => setActiveLayer(null);
			//if (id == activeLayer) { p.className = "active"; p.style.background = "#666"; }
			
			let colorIndicator = nameControl.insertBefore(document.createElement("span"), nameControl.firstChild);
			colorIndicator.style.cssText = "display:inline-block;width:10px;height:10px;border: 1px solid transparent;";
			
			
			p.appendChild(nameControl);
			layerToolbox.appendChild(p);
		}
	};
	let setActiveLayer = (id, force) => {
		if (id != null && (!db.get(id) || db.get(id).type != "layer")) throw new Error();
		if (id == activeLayer && !force) return;
		activeLayer = id;
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
				if (hiddenLayers.has(id)) hiddenLayers.delete(id); else hiddenLayers.add(id);
			} else {
				mapHidden = !mapHidden;
			}
			repaintLayers = true;
			repaintLayersFunc();
		/*} else if (e.shiftKey) {
			if (id != null) {
				hiddenLayers = (hiddenLayers.size == layers.length-1 && !hiddenLayers.has(id)) ? new Set() : new Set(layers.map(l => l[0]));
				hiddenLayers.delete(id);
			} else {
				hiddenLayers = hiddenLayers.size == layers.length ? new Set() : new Set(layers.map(l => l[0]));
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