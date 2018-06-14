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
	computeViewConstraints(width, height) {
		this.width = width;
		this.height = height;
		// zoom = size of a pixel on screen
		let minViewZoom = Math.min(width/this.mapWidth, height/this.mapHeight);
		this.minViewZoom = 1;
		while (this.minViewZoom > minViewZoom) this.minViewZoom /= 2;
		
		// left/top = left/top map pixel on screen
		this.viewXMinPixel = (width-this.mapWidth*this.minViewZoom)/2;
		this.viewXMaxPixel = (width+this.mapWidth*this.minViewZoom)/2;
		this.viewYMinPixel = (height-this.mapHeight*this.minViewZoom)/2;
		this.viewYMaxPixel = (height+this.mapHeight*this.minViewZoom)/2;
	}
	resize(width, height) {
		this.div.style.width = width + "px";
		this.div.style.height = height + "px";
		this.viewLeft -= (width-this.width)/2/this.viewZoom;
		this.viewTop -= (height-this.height)/2/this.viewZoom;
		this.computeViewConstraints(width, height);
		this.viewZoom = Math.max(this.viewZoom, this.minViewZoom);
		this.setViewCoords(this.viewLeft, this.viewTop);
		this.redraw();
	}
	constructor(width, height, mapWidth, mapHeight, layers, mouseListener) {
		this.mapWidth = mapWidth;
		this.mapHeight = mapHeight;
		
		this.maxViewZoom = 4;

		this.computeViewConstraints(width, height);

		this.viewZoom = this.minViewZoom;
		this.viewLeft = -this.viewXMinPixel/this.minViewZoom;
		this.viewTop = -this.viewYMinPixel/this.minViewZoom;

		let div = document.createElement("div");
		div.style.position = "relative";
		div.style.width = width + "px";
		div.style.height = height + "px";
		div.style.overflow = "hidden";
		this.div = div;
		this.mouseListener = mouseListener
		
		this.settings = {
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
			if (this.settings.wheelZoom || !this.settings.wheelZoom && e.ctrlKey) {
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
			if (pressedButtons && dragstartCoords && Math.pow(dragstartCoords.x-e.clientX,2)+Math.pow(dragstartCoords.y-e.clientY,2) >= this.settings.dragThreshold) {
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
		this.viewLeft = Math.round(Math.max(-this.viewXMinPixel/this.viewZoom, Math.min(this.mapWidth-this.viewXMaxPixel/this.viewZoom, x))*this.viewZoom)/this.viewZoom;
		this.viewTop = Math.round(Math.max(-this.viewYMinPixel/this.viewZoom, Math.min(this.mapHeight-this.viewYMaxPixel/this.viewZoom, y))*this.viewZoom)/this.viewZoom;
	}
	redraw() {
		for (let l of this.layers) {
			l.moveStart();
			l.moveStep();
			l.moveFinish();
		}
	}
}



class MapLayer {
	/**
	 * @param tileSize size of a tile, e.g. 256x256
	 * @param tileURLProvider function that computes a tile's URL from x,y,z (in tiles; z=0 being original/full resolution, z=1 half resolution etc.); this function should return null for unavailable tiles
	 * @param minPersistentCacheLevel a level for which to cache all tiles (null = never). This quickly provides fallback tiles when the desired tiles are not available.
	 */
	constructor(tileSize, tileURLProvider, minPersistentCacheLevel, pixelOffset) {
		this.tileSize = tileSize;
		this.tileURLProvider = tileURLProvider;
		this.minPersistentCacheLevel = minPersistentCacheLevel;
		this.imageCache = new Map();
		this.persistentImageCache = new Map();
		this.pixelOffset = pixelOffset != null ? pixelOffset : 0;
	}
	// Images are arranged in layers
	// For power-of-2 zoom levels just a single layer is shown
	// For inbetween zoom levels 2 layers are blended with the finer layer on top (so gaps will show the lower layer)
	// The bottommost visible layer must use lower-res versions of tiles when the desired resolution is not (or not yet) available
	// When minPersistentCacheLevel is specified and zoom level is deeper, then another layer is shown underneath using its tiles as a fallback
	initialise(mapView) {
		this.container = document.createElement("div");
		this.container.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;";
		this.mapView = mapView;
		mapView.div.appendChild(this.container);
		return Promise.resolve();
	}
	moveStart() {}
	moveStep() {
		// for now we just use the nearest power of 2
		let z = Math.max(0, Math.round(-Math.log(this.mapView.viewZoom)/Math.log(2)));
		// when no minPersistentCacheLevel was specified we take the chance to define it on our own, based on the initial zoom covering everything
		if (this.minPersistentCacheLevel == null) this.minPersistentCacheLevel = z;

		let zScale = Math.pow(2, z);
		// draw slabs
		let left = Math.max(0, Math.floor(this.mapView.viewLeft/zScale/this.tileSize));
		let right = Math.min(Math.floor((this.mapView.mapWidth-1)/this.tileSize/zScale), Math.ceil((this.mapView.viewLeft+this.mapView.width/this.mapView.viewZoom)/zScale/this.tileSize));
		let top = Math.max(0, Math.floor(this.mapView.viewTop/zScale/this.tileSize));
		let bottom = Math.min(Math.floor((this.mapView.mapHeight-1)/this.tileSize/zScale), Math.ceil((this.mapView.viewTop+this.mapView.height/this.mapView.viewZoom)/zScale/this.tileSize));
		
		// we create a new image cache and then discard images from the old ones that weren't used
		
		let newImageCache = new Map();
		let incompleteMap = new Map();
		
		let makeImage = url => {
			let image = document.createElement("img");
			image.onerror = function(e){ this.style.display="none"; console.log(e); };
			image.src = url;
			return image;
		};
		let addImage = (image, x, y, z) => {
			let zScale = 1<<z;
			image.style.position = "absolute";
			// FIXME positioning images like this leads to white seam boundaries in Firefox and using Math.round doesn't fix that
			image.style.left = (-this.mapView.viewLeft+(x*this.tileSize+this.pixelOffset)*zScale)*this.mapView.viewZoom + "px";
			image.style.top = (-this.mapView.viewTop+(y*this.tileSize+this.pixelOffset)*zScale)*this.mapView.viewZoom + "px";
			image.style.transformOrigin = "0 0";
			image.style.transform = "scale(" + zScale*this.mapView.viewZoom + ")";
			if (!image.complete) {
				image.style.opacity = 0;
				image.style.transition = "opacity 0.5s";
				image.onload = function() { this.style.opacity = 1; };
			}
			this.container.insertBefore(image, this.container.firstChild);
		};
		while (this.container.lastChild) this.container.removeChild(this.container.lastChild);
		
		for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
			let url = this.tileURLProvider(x,y,z);
			if (url == null) continue;
			let image;
			let persistent = this.minPersistentCacheLevel != null && z >= this.minPersistentCacheLevel;
			if (persistent) {
				image = this.persistentImageCache.get(url);
			} else {
				image = this.imageCache.get(url);
			}
			if (!image) {
				image = makeImage(url);
				if (persistent) {
					this.persistentImageCache.set(url, image);
				}
			}
			if (!persistent) {
				newImageCache.set(url, image);
			}
			addImage(image,x,y,z);
			if (!image.complete) {
				incompleteMap.set(this.tileURLProvider(x>>1,y>>1,z+1), [x>>1,y>>1,z+1]);
			}
		}
		// Whenever an image is missing we try to substitute with another image from the cache as an underlay.
		for (let i = 0; i < 8 && incompleteMap.size; i++) {
			let newIncompleteMap = new Map();
			for (let url of incompleteMap.keys()) {
				let coords = incompleteMap.get(url);
				let x = coords[0], y = coords[1], z = coords[2];
				if (!newIncompleteMap.has(url)) {
					let persistent = this.minPersistentCacheLevel != null && z >= this.minPersistentCacheLevel;
					let image;
					if (persistent) {
						image = this.persistentImageCache.get(url);
						if (!image && z == this.minPersistentCacheLevel) {
							image = makeImage(url);
							this.persistentImageCache.set(url, image);
						}
					} else {
						image = this.imageCache.get(url);
						if (image) {
							newImageCache.set(url, image);
						}
					}
					if (image) {
						addImage(image,x,y,z);
					}
					if (!image || !image.complete) {
						newIncompleteMap.set(this.tileURLProvider(x>>1,y>>1,z+1), [x>>1,y>>1,z+1]);
					}
				}
			}
			incompleteMap = newIncompleteMap;
		}
		this.imageCache = newImageCache;
	}
	moveFinish() {}
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
