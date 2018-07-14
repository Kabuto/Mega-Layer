function ViewTool(db, editLayer, geometryHelper) {
	return {
		name: "view",
		
		activate() {
			this.hoveringGroup = editLayer.append("g");
			this.selectedGroup = editLayer.append("g");
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
			let point = geometryHelper.getPointAt(e);
			let line = null;
			if (point) {
				let pointData = db.get(point);
				let nearestLineDistance = 0;
				for (let ref of db.getReferrers(point)) {
					let data = db.get(ref);
					if (data.type != "line") continue;
					let otherPointData = db.get(point == data.$point$1 ? data.$point$2 : data.$point$1);
					let dist = geometryHelper.distance(pointData, otherPointData);
					let test = {
						x: pointData.x + (otherPointData.x-pointData.x)/dist,
						y: pointData.y + (otherPointData.y-pointData.y)/dist
					};
					let dist2 = geometryHelper.distance(test, e);
					if (line == null || dist2 < nearestLineDistance) {
						line = ref;
						nearestLineDistance = dist2;
					}
				}
			}
			if (line == null) {
				let lineInfo = geometryHelper.getLineAt(e);
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
					editLayer.appendTo(group, "circle", {class: "view-tool-point" + classPostfix, r: geometryHelper.halfLineWidth, cx: data.x, cy: data.y});
					break;
				case "line":
					let p1 = db.get(data.$point$1);
					let p2 = db.get(data.$point$2);
					editLayer.appendTo(group, "line", {class: "view-tool-line" + classPostfix, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y}, {strokeWidth: geometryHelper.lineWidthPx});
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
		
	};
}