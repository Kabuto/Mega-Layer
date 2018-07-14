function LineTool(db, editLayer, geometryHelper, layerState) {
	return {
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
			let dot = editLayer.append("circle", {class: "edit-tool-point", r: geometryHelper.halfLineWidth, cx: data.x, cy: data.y});
			this.dotMap.set(id, dot);
		},
		
		// called upon activating this layer, followed up by a "mousemove" call to reset all mouse-over activity
		activate() {
			this.dot = editLayer.append("circle", {class: "edit-tool-marker", r: geometryHelper.halfLineWidth});
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
			let nearestPoint = geometryHelper.getPointAt(e, except);
			if (nearestPoint) return ({type: "point", coords: db.get(nearestPoint), point: nearestPoint, create: () => nearestPoint});
			let nearestLine = except != null || nearestPoint ? null : geometryHelper.getLineAt(e, except);
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
				if ((layerState.activeLayer == null || layerState.hiddenLayers.has(layerState.activeLayer)) && this.point.type != "point") {
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
					this.lastPoints = oldState == "mousedown" && layerState.activeLayer != null && !layerState.hiddenLayers.has(layerState.activeLayer) ? [id] : null;
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
							duplicate = duplicate | !insertLineIfNoDuplicate({type: "line", $point$1: lastPoints[i], $point$2: point2, $layer$: layerState.activeLayer});
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
						let line = editLayer.append("line", {class: "edit-tool-line"}, {strokeWidth: geometryHelper.halfLineWidthPx});
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
	};
}