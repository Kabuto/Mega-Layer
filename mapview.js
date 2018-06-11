/**
	This class maintains the render canvas and handles user input
	width, height: size on screen in pixels
	mapWidth, mapHeight: width and height of map in map units
	layers: stack of layers to be rendered
	mouseListener:
		event handler that receives mouse events (with map coordinates). All functions receive an "event" object, consisting of:
			* x: x on map
			* y: y on map
			* button: button that was pressed/released, if relevant
			* buttons: bitmask of buttons, if relevant
			* originalEvent: original mouse event (beware that this one might have a different type as this code generates its own events, e.g. mousemove upon mouse wheel events)
		mousedown, mousemove, mouseup:
			these correspond to the original javascript methods. This script tries to ensure that after pressing the mouse a release event is always issued, even if release occurs outside of the window
		click:
			this one is special. It is called upon pressing a button and it returns a function which is invoked if a click (i.e. not a drag) really occurred, once the button is released again, again with the last event as parameter.
			The click handler needs to check both for the first and last call that the mouse is still hovering over the same object.
		dragstart, drag, dragend:
			These are called for drag operations, i.e. detection of a drag (with initial mouse coordinates), mouse movement while dragging and releasing the mouse again. Dragging is re-initialised whenever the set of button
		    changes. It only gets the "buttons" bitfield, not a single "button".
		
*/
class MapView {
	constructor(width, height, mapWidth, mapHeight, layers, mouseListener) {
		this.width = width;
		this.height = height;
		this.mapWidth = mapWidth;
		this.mapHeight = mapHeight;
		
		// zoom = size of a pixel on screen
		let minViewZoom = Math.min(width/mapWidth, height/mapHeight);
		this.maxViewZoom = 4;
		this.minViewZoom = 1;
		while (this.minViewZoom > minViewZoom) this.minViewZoom /= 2;
		this.viewZoom = this.minViewZoom;
		
		// left/top = left/top map pixel on screen
		this.viewLeft = (mapWidth-width/this.viewZoom)/2;
		this.viewTop = (mapHeight-height/this.viewZoom)/2;
		
		this.viewXMinPixel = -this.viewLeft*this.viewZoom;
		this.viewXMaxPixel = (mapWidth-this.viewLeft)*this.viewZoom;
		this.viewYMinPixel = -this.viewTop*this.viewZoom;
		this.viewYMaxPixel = (mapHeight-this.viewTop)*this.viewZoom;

		let div = document.createElement("div");
		div.style.position = "relative";
		div.style.width = width + "px";
		div.style.height = height + "px";
		div.style.overflow = "hidden";
		div.style.boxShadow = "1px 1px 3px rgba(0,0,0,.5)";	
		this.div = div;
		this.mouseListener = mouseListener
		
		this.config = {
			// true = mouse wheel always zooms (map-like), false = mouse wheel scrolls Y without keys pressed, scrolls X with shift key, scrolls Y with ctrl key
			wheelZoom: true,
			// a mouse button that, while held down, allows dragging the map around (can be set to left but then would disable rubberband; set to null to disable dragging - fast looking around is also possible through zooming)
			dragButton: null,
			// how many pixels to drag before dragging/rubberbanding is assumed (instead of just clicking)
			dragThreshold: 4,
		};
		
		this.layers = [];
		for (let l of layers) {
			l.initialise(this);
			this.layers.push(l);
		}
		for (let l of this.layers) {
			l.moveStart();
			l.moveStep();
			l.moveFinish();
		}
		let getCoords = e => {
			let rect = this.div.getBoundingClientRect();
			let x = e.clientX - rect.left;
			let y = e.clientY - rect.top;
			return {x: this.viewLeft + x/this.viewZoom, y: this.viewTop + y/this.viewZoom, mouseX: x, mouseY: y};
		};
		let callEventHandler = (name,e,xy,button,buttons) => {
			if (this.mouseListener[name]) {
				try {
					return this.mouseListener[name]({
						x: xy.x,
						y: xy.y,
						originalEvent: e,
						button: button,
						buttons: buttons
					});
				} catch (e) {
					console.log(e);
				}
			}
		};
		let callEventFunc = (func,e,xy,button,buttons) => {
			if (func) {
				try {
					return func({
						x: xy.x,
						y: xy.y,
						originalEvent: e,
						button: button,
						buttons: buttons
					});
				} catch (e) {
					console.log(e);
				}
			}
		};
		this.div.addEventListener("wheel", e => {
			e.preventDefault();
			let xy = getCoords(e);
			let mapX = xy.x;
			let mapY = xy.y;
			if (this.config.wheelZoom || !this.config.wheelZoom && e.ctrlKey) {
				if (e.deltaY < 0 && this.viewZoom < this.maxViewZoom) {
					this.viewZoom *= 2;
				} else if (e.deltaY > 0 && this.viewZoom > this.minViewZoom) {
					this.viewZoom /= 2;
				} else {
					return;
				}
				this.setViewCoords(mapX - xy.mouseX/this.viewZoom, mapY - xy.mouseY/this.viewZoom);
				this.redraw();
			} else if (e.shiftKey) {
				this.moveBy(100*(e.deltaY ? e.deltaY > 0 ? 1 : -1 : 0), 0);
				this.redraw();
			} else {
				this.moveBy(0, 100*(e.deltaY ? e.deltaY > 0 ? 1 : -1 : 0));
				this.redraw();
			}
			xy = getCoords(e);
			callEventHandler("mousemove",e,xy,null,pressedButtons);
		});
		// TODO detect clicking / dragging in a "clean" way if possible; should be handled here since we know raw mouse coordinates
		// Idea:
		// * reset after button change, store current coordinate
		// * if at least one button is pressed, once minimum distance has been exceeded: temporarily disable clicking for all buttons that are active until they are released again
		// * on mouse move if dragging is enabled: send drag events for each successive move
		let pressedButtons = 0;
		let clickHandlers = [];
		let dragstartCoords = null;
		let mousemoveFunc = e => {
			e.preventDefault();
			if (pressedButtons && dragstartCoords && Math.pow(dragstartCoords.x-e.clientX,2)+Math.pow(dragstartCoords.y-e.clientY,2) >= this.config.dragThreshold) {
				clickHandlers = [];
				callEventHandler("dragstart", e, dragstartCoords.map, null, pressedButtons);
				dragstartCoords = null;
			}
			callEventHandler("mousemove", e,getCoords(e),null,pressedButtons);
			if (pressedButtons && !dragstartCoords) {
				callEventHandler("drag", e, getCoords(e), null, pressedButtons);
			}
		};
		let mouseupFunc = e => {
			let xy = getCoords(e);
			if (!(pressedButtons & (1<<e.button))) return;
			if (!dragstartCoords) callEventHandler("dragend", e, xy, null, pressedButtons);
			pressedButtons &= ~(1<<e.button);
			if (!pressedButtons) {
				window.removeEventListener("mousemove", mousemoveFunc);
				div.addEventListener("mousemove", mousemoveFunc);
				window.removeEventListener("mouseup", mouseupFunc);
			}
			e.preventDefault();
			callEventHandler("mouseup",e,xy,e.button);
			callEventFunc(clickHandlers[e.button],e,xy,e.button);
			delete clickHandlers[e.button];
		};
		div.addEventListener("mousedown", e => {
			e.preventDefault();
			if (pressedButtons & (1<<e.button)) return;
			if (!pressedButtons) {
				div.removeEventListener("mousemove", mousemoveFunc);
				window.addEventListener("mousemove", mousemoveFunc);
				window.addEventListener("mouseup", mouseupFunc);
			}
			let xy = getCoords(e);
			if (pressedButtons && !dragstartCoords) callEventHandler("dragend", e, xy, null, pressedButtons);
			dragstartCoords = {x: e.clientX, y: e.clientY, map: xy};
			pressedButtons |= 1<<e.button;
			callEventHandler("mousedown", e, xy, e.button);
			clickHandlers[e.button] = callEventHandler("click", e, xy, e.button);
		});
		div.addEventListener("mousemove", mousemoveFunc);
		div.addEventListener("contextmenu", e => {
			e.preventDefault();
		});
	}
	moveBy(x,y) {
		this.setViewCoords(this.viewLeft+x/this.viewZoom, this.viewTop+y/this.viewZoom);
	}
	setViewCoords(x,y) {
		this.viewLeft = Math.max(-this.viewXMinPixel/this.viewZoom, Math.min(this.mapWidth-this.viewXMaxPixel/this.viewZoom, x));
		this.viewTop = Math.max(-this.viewYMinPixel/this.viewZoom, Math.min(this.mapHeight-this.viewYMaxPixel/this.viewZoom, y));
	}
	redraw() {
		for (let l of this.layers) {
			l.moveStart();
			l.moveStep();
			l.moveFinish();
		}
	}
}


class MapBasedCanvasLayer {
	// This renders a view-sized canvas and updates tiles as needed.
	// Tiles are 512x512 pixels each; as a performance optimisation multiple tiles can be combined.
	// When tiles are missing this layer tries to be quick and uses larger tiles to fill gaps quickly, scaled up.
	// When no tiles are present a checkerboard pattern is used.
	// Tiles can be invalidated individually by specifying a condition that tells whether a given tile is invalid (e.g. editing an object - invalidate old and new locations of the object shape's position).
	// Tiles in the middle of the viewport are preferred when performing updates.
	// Maybe allow updating parts of a tile when drawing is very expensive (i.e. global overview)
	constructor() { }
	initialise(mapView) {
		this.mapView = mapView;
		let canvas = document.createElement("canvas");
		canvas.width = mapView.width;
		canvas.height = mapView.height;
		canvas.style.position = "absolute";
		canvas.style.left = "0";
		canvas.style.top = "0";
		mapView.div.appendChild(canvas);
	}
	moveStart() {
		this.viewZoom = this.mapView.viewZoom;
		this.viewLeft = this.mapView.viewLeft;
		this.viewTop = this.mapView.viewTop;
	}	
	moveStep() {
		// TODO use map view params to move/zoom the canvas
	}
	moveFinish() {
		// TODO compute new view, then replace canvas
	}
}

class ImageLayer {
	constructor(imgSrc, scaleFactor) {
		this.img = document.createElement("img");
		this.img.style.position = "absolute";
		this.promise = new Promise((resolve, reject) => {
			this.img.onload = () => resolve(this.img);
			this.img.onerror = () => reject();
			this.img.src = imgSrc;
		}).then(img => {
			this.width = img.naturalWidth;
			this.height = img.naturalHeight;
			this.moveStep();
		});
		this.scaleFactor = scaleFactor || 1;
	}
	initialise(mapView) {
		this.mapView = mapView;
		mapView.div.appendChild(this.img);
		return this.promise;
	}
	moveStart() {}
	moveStep() {
		this.img.style.left = -this.mapView.viewLeft*this.mapView.viewZoom + "px";
		this.img.style.top = -this.mapView.viewTop*this.mapView.viewZoom + "px";
		this.img.style.width = this.mapView.viewZoom*this.width*this.scaleFactor + "px";
		this.img.style.height = this.mapView.viewZoom*this.height*this.scaleFactor + "px";
	}
	moveFinish() {}
}

// Uses SVG directly
class SVGLayer {
	constructor() {
		this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.svg.style.position = "absolute";
	}
	initialise(mapView) {
		this.mapView = mapView;
		this.svg.setAttribute("viewBox", "0 0 " + this.mapView.mapWidth + " " + this.mapView.mapHeight);
		mapView.div.appendChild(this.svg);
	}
	moveStart() {}
	moveStep() {
		this.svg.style.left = -this.mapView.viewZoom*this.mapView.viewLeft + "px";
		this.svg.style.top = -this.mapView.viewZoom*this.mapView.viewTop + "px";
		this.svg.style.width = this.mapView.viewZoom*this.mapView.mapWidth + "px";
		this.svg.style.height = this.mapView.viewZoom*this.mapView.mapHeight + "px";
	}
	moveFinish() {}
}

class MapTileLayer {
	// uses map tiles, e.g. 256x256 pixels each - uses lower-resolution tiles whenever a higher-resolution tile is missing
}
