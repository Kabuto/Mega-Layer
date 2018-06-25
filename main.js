/*

TODO list:

* Render signal names at endpoints
* Fix undo/redo
* Support for structure elements
* Add multiselect/rubberband support for dots for dragging them all at once, add suppport for mirroring (maybe also rotating and maybe even scaling) for the points being dragged
* Find a better project name

*/

function init() {
	let database = new Database();

	// Helper class that collects both changes and matching undo instructions
	class ChangesCollector {
		constructor() {
			this.changes = new Map();
			this.undo = new Map();
		}
		add(changes, undo) {
			for (let change of changes) {
				let existing = this.changes.get(change.id);
				if (!existing) {
					this.changes.set(change.id, {oldData: change.oldData, data: change.data});
				} else {
					if (!existing.data != !change.oldData) throw new Error();
					if (change.oldData && change.oldData != true) {
						for (let i in change.oldData) if (change.oldData[i] != existing.data[i]) throw new Error();
						for (let i in existing.data) if (change.oldData[i] != existing.data[i]) throw new Error();
					}
					existing.data = change.data;
				}
			}
			for (let i = undo.length-1; i >= 0; i--) {
				let change = undo[i];
				let existing = this.undo.get(change.id);
				if (!existing) {
					this.undo.set(change.id, {oldData: change.oldData, data: change.data});
				} else {
					if (!existing.oldData != !change.data) throw new Error("Failed to prepend undo " + JSON.stringify(change) + " to " + JSON.stringify(existing));
					if (existing.oldData && existing.oldData != true) {
						for (let i in existing.oldData) if (existing.oldData[i] != change.data[i]) throw new Error();
						for (let i in change.data) if (existing.oldData[i] != change.data[i]) throw new Error();
					}
					existing.oldData = change.oldData;
				}
			}
		}
		addFromCollector(collector) {
			this.add(collector.getChanges(), collector.getUndo());
		}
		getChanges() {
			return [...this.changes.keys()].map(id => ({id: id, oldData: this.changes.get(id).oldData, data: this.changes.get(id).data}));
		}
		getUndo() {
			return [...this.undo.keys()].map(id => ({id: id, oldData: this.undo.get(id).oldData, data: this.undo.get(id).data}));
		}
		replace(changes, undo) {
			if (changes != null) this.changes = new Map();
			if (undo != null) this.undo = new Map();
			this.add(changes || [], undo || []);
		}
		isEmpty() {
			return this.changes.size == 0 && this.undo.size == 0;
		}
	}
	
	// Changes are not to be sent directly to the database object but to a wrapper which prepares committing, backend communication and stuff
	let databaseWrapper = {
		// List of local changes that are waiting to be sent to the server
		pending: new ChangesCollector(),
		// List of local changes that are part of a current edit operation and thus must not be sent to the server
		uncommitable: null,
		// List of local changes that are currently being done - they are collected and added to "pending" and treated as a group for undo/redo
		current: new ChangesCollector(),
		// List of local changes that have been sent to the server and are waiting for a response
		inProgress: null,
		requestPending: false,
		database: database,
		updateListeners: [],
		generalUpdateListeners: [],
		internalIDGenerator: 0,
		submitTimeout: null,
		undoEntries: [],
		undoOffset: 0,
		redoEntries: [],
		redoOffset: 0,

		callListeners(oldState, newState, getOldData, getNewData) {
			for (let l of this.updateListeners) {
				try {
					l(oldState, newState, getOldData, getNewData);
				} catch (e) {
					console.log(e);
				}
			}
		},

		callGeneralListeners() {
			for (let l of this.generalUpdateListeners) {
				try {
					l();
				} catch (e) {
					console.log(e);
				}
			}
		},
		
		init(backendFactory) {
			let initialised = false;
			return new Promise((resolve, reject) => {
				this.backend = backendFactory(response => {
					if (!initialised) {
						initialised = true;
						try {
							this.database.modify(response.objects);
							for (let id of this.database.getAllIds()) {
								this.callListeners(null, this.database.get(id), id => null, id => this.database.get(id));
							}
							this.callGeneralListeners();
							this.submit();
							resolve();
						} catch (e) {
							reject(e);
						}
					} else {
						this.handleResponse(response);
					}
				});
			});
		},
		
		insert(data) {
			if (data == null) throw new Error();
			let id = --this.internalIDGenerator;
			this.modifyOne(id, null, data);
			return id;
		},
		
		update(id, oldData, data) {
			if (data == null) throw new Error();
			this.modifyOne(id, oldData || true, data);
		},
		
		delete(id, oldData) {
			this.modifyOne(id, oldData || true, null);
		},
		
		// enables writing of changes without committing them to the backend for now
		// The idea is to allow editing such as drag and drop which leads to a large number of updates without poking the server all the time
		// Just like normal (unwritten) updates such updates can be cancelled too in case of conflicts - in that case the editor can either be informed about a callback or by querying using the "isUncommited" method.
		setUncommitted(abortCallback) {
			if (this.uncommitable) throw new Error();
			this.uncommitable = new ChangesCollector();
			this.uncommitableAbortCallback = abortCallback;
		},
		
		// tests whether uncommitted changes were activated (does not check the presence of any actual changes, just that they are enabled and they were not cancelled)
		isUncommitted() {
			return this.uncommitable != null;
		},
		
		rollback() {
			if (!this.uncommitable) throw new Error();
			this.modify(this.uncommitable.getUndo());
			this.uncommitable = null;
			this.uncommitableAbortCallback = null;
		},
		
		commit() {
			if (!this.uncommitable) throw new Error();
			this.pending.addFromCollector(this.uncommitable);
			this.uncommitable = null;
			this.uncommitableAbortCallback = null;
			this.submit();
		},
		
		// Modifies a single entry. Modification requests are collected and only sent once the calling code exited.
		modifyOne(id, oldData, data) {
			this.modify([{id: id, oldData: oldData, data: data}]);
		},
		
		// Modifies multiple entries. Modification requests are collected and only sent once the calling code exited.
		modify(updates) {
			let oldState = new Map();
			for (let update of updates) {
				oldState.set(update.id, this.database.get(update.id));
			}
			let undoData = this.database.getUndoUpdates(updates)[0];
			this.database.modify(updates);
			for (let id of oldState.keys()) {
				this.callListeners(oldState.get(id) ? {id: id, data: oldState.get(id)} : null, database.get(id) ? {id: id, data: database.get(id)} : null, id => (oldState.has(id) ? oldState : database).get(id), id => database.get(id));
			}
			this.callGeneralListeners();
			(this.uncommitable || this.current).add(updates, undoData);
			this.submit();
		},
		
		addUpdateListener(listener) {
			this.updateListeners.push(listener);
		},
		
		addGeneralUpdateListener(listener) {
			this.generalUpdateListeners.push(listener);
		},
		
		tryApplyUpdates(serverUpdates) {
			// Get undo data first so all locally buffered actions can be undone, even if they are discarded later due to conflicts
			let undo = [].concat(
				this.uncommitable ? this.uncommitable.getUndo() : [],
				this.pending.getUndo(),
				this.inProgress ? this.inProgress.getUndo() : []
			);
			
			for (;;) {
				let allChanges = [
					undo,
					serverUpdates,
					this.pending.getChanges(),
					this.uncommitable ? this.uncommitable.getChanges() : []
				];
				
				let undoBlocks = this.database.getUndoUpdates.apply(this.database, allChanges);
				let allUpdates = [].concat.apply([], allChanges);
				let oldState = new Map();
				for (let update of allUpdates) {
					oldState.set(update.id, this.database.get(update.id));
				}
				
				try {
					this.database.modify(allUpdates);
					if (this.uncommitable) this.uncommitable.replace(null, undoBlocks[3]);
					this.pending.replace(null, undoBlocks[2]);
					this.inProgress = null;
					return oldState;
				} catch (e) {
					// Committing failed
					// There can be 2 culprits: pending changes (i.e. not sent to the server yet) and uncommitable changes (i.e. current editing operations)
					// If there are both then either could be the culprit, but even if pending changes are the actual cause chances are that uncommitable changes depend on them and will thus fail too, thus for now we always undo uncommitable changes first,
					// cancelling active editing operations
					if (this.uncommitable && !this.uncommitable.isEmpty()) {
						// discard uncommitable changes (undo will still be executed as it has been copied to a local var above)
						// a listener will be called to ensure that the editor knows
						this.uncommitable = null;
						if (this.uncommitableAbortCallback) {
							try {
								this.uncommitableAbortCallback();
							} catch (e) {
								console.log(e);
							}
						}
						this.uncommitableAbortCallback = null;
					} else if (!this.pending.isEmpty()) {
						// discard pending changes (undo will still be executed as it has been copied to a local var above)
						this.pending = new ChangesCollector();
					} else {
						// internal error - no pending changes left to be undone
						throw e;
					}
					console.log("Conflict during updating", e);
				}
			}
		},
		
		submit() {
			if (this.submitTimeout == null && (!this.current.isEmpty() || !this.pending.isEmpty())) {
				this.submitTimeout = setTimeout(() => this.submit2(), 0);
			}
		},
		
		makeUndoEntry(forRedo) {
			if (!this.current.isEmpty()) {
				if (forRedo) {
					let redoEntry = this.current.getChanges();
					if (this.redoEntries.length >= 100) {
						this.redoEntries.shift();
						this.redoOffset--;
					}
					this.redoEntries.push(redoEntry);
				} else {
					let undoEntry = this.current.getUndo();
					if (this.undoEntries.length >= 100) {
						this.undoEntries.shift();
						this.undoOffset--;
					}
					this.undoEntries.push(undoEntry);
					this.redoEntries = [];
				}
				this.pending.addFromCollector(this.current);
				this.current = new ChangesCollector();
			}
			console.log("undo stack size = " + this.undoEntries.length + ", redo stack size = " + this.redoEntries.length);
			console.log("Undo stack", JSON.stringify(this.undoEntries));
		},

		submit2() {
			this.makeUndoEntry();
			this.submitTimeout = null;

			// will check later
			if (this.requestPending) return;
			
			this.inProgress = this.pending;
			this.pending = new ChangesCollector();
			this.requestPending = true;

			this.backend.update(this.inProgress.getChanges());
		},

		handleResponse(response) {
			// This clears the "current" object so we don't need to handle it
			this.makeUndoEntry();
			
			let serverUpdates = response.objects;
			let idMap = response.clientToServerIDMap || new Map();

			// Log any errors but proceed normally. We undo all changes in progress anyway so after an error they will be undone.
			if (response.error) console.error(response.error);
			
			// The updates we just submitted already have their IDs mapped.
			// But we still need to apply them to pending changes
			let mapIDs = obj => {
				if (!obj || obj === true) return obj;
				obj = Object.assign({}, obj);
				for (let k in obj) {
					if (k[0] =="$" && obj[k] != null && obj[k] < 0 && idMap.has(obj[k])) {
						obj[k] = idMap.get(obj[k]);
					}
				}
				return obj;
			};
			for (let item in this.pending.getChanges()) {
				item.oldData = mapIDs(item.oldData);
				item.data = mapIDs(item.data);
			}
			if (this.uncommitable) {
				for (let item in this.uncommitable.getChanges()) {
					item.oldData = mapIDs(item.oldData);
					item.data = mapIDs(item.data);
				}
			}
			let oldState = this.tryApplyUpdates(serverUpdates);
			
			for (let block of this.undoEntries) {
				for (let entry of block) {
					entry.id = idMap.has(entry.id) ? idMap.get(entry.id) : entry.id;
					entry.data = mapIDs(entry.data);
					entry.oldData = mapIDs(entry.oldData);
				}
			}
			
			
			// verify
			let targetIDs = new Set(idMap.values());
			for (let id of idMap.keys()) if (database.get(id) != null) throw new Error();
			for (let id of targetIDs.keys()) if (oldState.get(id) != null) throw new Error();
			// call all listeners
			for (let id of oldState.keys()) {
				if (targetIDs.has(id)) continue; // the original ID will be used for calling
				let id2 = idMap.has(id) ? idMap.get(id) : id;
				let oldData = oldState.get(id);
				let newData = database.get(id2);
				this.callListeners(oldData && {id: id, data: oldData}, newData && {id: id2, data: newData}, id => (oldState.has(id) ? oldState : database).get(id), id => database.get(id));
			}
			this.callGeneralListeners();

			// Only after mapping all IDs re-apply pending local updates
			this.inProgress = null;
			this.requestPending = false;
			this.submit();
		},
		
		undo() {
			if (this.undoEntries.length == 0) { console.info("Undo stack is empty"); return; }
			if (this.uncommitable) throw new Error("Cannot undo during a transaction");
			if (!this.current.isEmpty()) throw new Error("Cannot undo before finishing the previous undo layer step");
			this.modify(this.undoEntries.pop());
			this.makeUndoEntry(true);
		},
		
		redo() {
			if (this.redoEntries.length == 0) { console.info("Redo stack is empty"); return; }
			if (this.uncommitable) throw new Error("Cannot undo during a transaction");
			if (!this.current.isEmpty()) throw new Error("Cannot undo before finishing the previous undo layer step");
			this.modify(this.redoEntries.pop());
			this.makeUndoEntry(false);
		}
	};

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
		let layers = [...database.getIdsOfType("layer")].map(id => [id, database.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0)).map(entry => entry[0]);
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
	database.addChangeListener((id, oldData, newData, oldDataSupplier) => {
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
				let layer = database.get(newData.$layer$);
				let layerObj = null;
				if (layer) {
					layerObj = tracesSvgMap.get(newData.$layer$);
					if (!layerObj) {
						updateLayers();
						layerObj = tracesSvgMap.get(newData.$layer$);
					}
				}
				let p1 = database.get(newData.$point$1);
				let p2 = database.get(newData.$point$2);
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
				for (let id2 of database.getReferrers(id)) {
					let data = database.get(id2);
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
				let p1 = database.get(newData.$point$1);
				let p2 = database.get(newData.$point$2);
				let line = tracesSvgMap.get(id);
				line.setAttribute('x1', p1.x);
				line.setAttribute('y1', p1.y);
				line.setAttribute('x2', p2.x);
				line.setAttribute('y2', p2.y);
				if (oldData && oldData.$layer$ != newData.$layer$) {
					let layer = database.get(newData.$layer$);
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
					for (let id2 of database.getReferrers(id)) {
						let data = database.get(id2);
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
		for (let id of database.getIdsOfType("point")) {
			let data = database.get(id);
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
		for (let id of database.getIdsOfType("line")) {
			// only needs to cover the rect area, no rounded caps needed as they are already handled by getPointAt
			let data = database.get(id);
			if (data.$point$1 == except || data.$point$2 == except) continue;
			let a = database.get(data.$point$1);
			let b = database.get(data.$point$2);
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
		let data = database.get(nearestLine);
		let a = database.get(data.$point$1);
		let b = database.get(data.$point$2);
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
					let data = database.get(id);
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
				let data = database.get(id);
				if (data.type == "line" && data.signal) {
					named.add(id);
				}
			}
			let updates = [];
			if (named.size > 1) {
				for (let id of named) {
					let data = database.get(id);
					delete data.signal;
					updates.push({id: id, oldData: true, data: data});
				}
				named = new Set();
			}
			let id = named.size == 1 ? [...named][0] : this.selected;
			let data = database.get(id);
			if (text) {
				data.signal = text;
			} else {
				delete data.signal;
			}
			updates.push({id: id, oldData: true, data: data});
			databaseWrapper.modify(updates);
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
				let pointData = database.get(point);
				let nearestLineDistance = 0;
				for (let ref of database.getReferrers(point)) {
					let data = database.get(ref);
					if (data.type != "line") continue;
					let otherPointData = database.get(point == data.$point$1 ? data.$point$2 : data.$point$1);
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
					let data = database.get(id);
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
			let ldata = database.get(line);
			let queue = [ldata.$point$1, ldata.$point$2];
			let scanned = new Set([line, ldata.$point$1, ldata.$point$2]);
			while (queue.length) {
				for (let ref of database.getReferrers(queue.shift())) {
					if (scanned.has(ref)) continue;
					scanned.add(ref);
					let data = database.get(ref);
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
				let data = database.get(id);
				switch (data.type) {
				case "point":
					appendSVGItem(group, "circle", {class: "view-tool-point" + classPostfix, r: halfLineWidth, cx: data.x, cy: data.y});
					break;
				case "line":
					let p1 = database.get(data.$point$1);
					let p2 = database.get(data.$point$2);
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
			this.select(oldSelected != null && database.get(oldSelected) ? oldSelected : null);
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
			for (let id of database.getIdsOfType("point")) {
				this.addDot(id, database.get(id));
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
			if (nearestPoint) return ({type: "point", coords: database.get(nearestPoint), point: nearestPoint, create: () => nearestPoint});
			let nearestLine = except != null || nearestPoint ? null : getLineAt(e, except);
			if (nearestLine) return ({type: "line", coords: nearestLine, line: nearestLine, create: () => {
				let id = databaseWrapper.insert({type: "point", x: nearestLine.x, y: nearestLine.y});
				let data = database.get(nearestLine.id);
				let newData = Object.assign({}, data);
				let newData2 = Object.assign({}, data);
				newData.$point$2 = id;
				newData2.$point$1 = id;
				databaseWrapper.update(nearestLine.id, data, newData);
				databaseWrapper.insert(newData2);
				return id;
			}});
			return ({type: "new", coords: e, create: () => databaseWrapper.insert({type: "point", x: e.x, y: e.y})});
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
				
				databaseWrapper.setUncommitted();
				this.pointId = this.point.create();
				this.pointData = database.get(this.pointId);
				this.startPos = {x: e.x, y: e.y};
				// draw point insertion placeholder
				this.state = "mousedown";
				this.dot.setAttribute("class", "edit-tool-marker edit-tool-marker-mousedown");
				this.mousemove(e);
			}
		},
		checkAbort() {
			if (this.point && (!databaseWrapper.isUncommitted() || this.pointId == null)) {
				this.abort();
			}
		},
		abort() {
			// edit action got aborted
			if (databaseWrapper.isUncommitted()) databaseWrapper.rollback();
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
				for (let id2 of database.getReferrers(id)) {
					databaseWrapper.delete(id2);
				}
				databaseWrapper.delete(id);
				databaseWrapper.commit();
			}
		},
		mousemove(e) {
			this.checkAbort();
			let updateDotAndLines = pos => {
				this.dot.setAttribute('cx', pos.x);
				this.dot.setAttribute('cy', pos.y);
				if (this.lines) {
					let p0 = database.get(this.lastPoints[0]);
					for (let i = 0; i < this.lastPoints.length; i++) {
						let px = database.get(this.lastPoints[i]);
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
				databaseWrapper.update(this.pointId, this.pointData, newData);
				this.pointData = newData;
				return;
			}

			// TODO this causes glitches
			// TODO merge further points too, not just the one being dragged
			let pos = this.getPoint(e).coords;
			if (e.originalEvent.ctrlKey && this.lastPoints) {
				let data = database.get(this.lastPoints[0]);
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
				
				databaseWrapper.commit();
				
				let insertLineIfNoDuplicate = data => {
					if (data.$point$1 == data.$point$2) return false;
					for (let lid of database.getIdsOfType("line")) {
						let ldata = database.get(lid);
						if (ldata.$point$1 == data.$point$1 && ldata.$point$2 == data.$point$2 || ldata.$point$2 == data.$point$1 && ldata.$point$1 == data.$point$2) {
							return false;
						}
					}
					databaseWrapper.insert(data);
					return true;
				};
				
				let checkLineIsUnique = (id, data) => {
					for (let lid of database.getIdsOfType("line")) {
						let ldata = database.get(lid);
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
						let existingPointRefs = new Set(database.getReferrers(this.dragTarget.point));
						let ourRefs = database.getReferrers(id);
						for (let lid of ourRefs) {
							let data = database.get(lid);
							if (existingPointRefs.has(data.$point$1) || existingPointRefs.has(data.$point$2)) {
								// line would be connected to both points -> abort
								databaseWrapper.delete(lid);
							}
							let newData = Object.assign({}, data);
							for (let i in newData) if (i[0] == "$" && newData[i] == id) newData[i] = this.dragTarget.point;
							if (checkLineIsUnique(lid, newData)) {
								databaseWrapper.update(lid, data, newData);
							} else {
								databaseWrapper.delete(lid, data);
							}
						}
						databaseWrapper.delete(id);
						id = null;
						this.lastPoints = null;
						break;
					case "line":
						// split line into 2 halves with existing point
						let lineId = this.dragTarget.line.id;
						let line = database.get(lineId);
						databaseWrapper.delete(lineId);
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
						let p0 = database.get(lastPoints[0]);
						for (let i = 0; i < lastPoints.length; i++) {
							let px = database.get(lastPoints[i]);
							let point2;
							if (i == 0) {
								point2 = id;
							} else {
								point2 = databaseWrapper.insert({type: "point", x: px.x-p0.x+data.x, y: px.y-p0.y+data.y});
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
						let data = database.get(id);
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
						c("span", c("input", {type: "button", value: "Add layer", onclick: () => databaseWrapper.insert({type: "layer", name: addLayerName.value, color: addLayerColor.value, order: 0})}))
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
		else if (e.charCode == 122 && e.ctrlKey && !e.shiftKey) databaseWrapper.undo();
		else if (e.charCode == 121 && e.ctrlKey && !e.shiftKey) databaseWrapper.redo();
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
	
	databaseWrapper.addGeneralUpdateListener(() => {
		if (editTools[currentTool].change3) editTools[currentTool].change3(); 
	});
	databaseWrapper.addUpdateListener((oldState, newState, getOldData, getNewData) => {
		if (editTools[currentTool].change2) editTools[currentTool].change2(oldState, newState, getOldData, getNewData); 
	});
	database.addChangeListener((id, oldData, newData, oldDataSupplier) => {
		if (editTools[currentTool].change) editTools[currentTool].change(id, oldData, newData, oldDataSupplier); 
	});

	databaseWrapper.init(backendProvider).then(() => {
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
		if (activeLayer != null && database.get(activeLayer) && !repaintLayers) return;
		repaintLayers = false;
		if (!database.get(activeLayer)) activeLayer = null;
		let layers = [...database.getIdsOfType("layer")].map(id => [id, database.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0));
		for (let k of hiddenLayers) if (!database.get(k)) hiddenLayers.delete(k);
		
		while (layerToolbox.lastChild) layerToolbox.removeChild(layerToolbox.lastChild);
		for (let [id, data] of layers) {
			let p = document.createElement("div");
			let visibilityControl = p.appendChild(document.createElement("span"));
			visibilityControl.textContent = "ðŸ‘";
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
			visibilityControl.textContent = "ðŸ‘";
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
		if (id != null && (!database.get(id) || database.get(id).type != "layer")) throw new Error();
		if (id == activeLayer && !force) return;
		activeLayer = id;
		repaintLayers = true;
		repaintLayersFunc();
	};
	window.addEventListener("keydown", e => {
		if (suspendKeyEvents) return;
		if (e.keyCode < 48 || e.keyCode > 57) return;
		let num = (e.keyCode+1)%10;
		let layers = [...database.getIdsOfType("layer")].map(id => [id, database.get(id)]).sort((a,b) => (a[1].order||0)-(b[1].order||0));
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
	
	
	
	databaseWrapper.addGeneralUpdateListener(repaintLayersFunc);
}