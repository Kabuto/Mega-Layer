/**
	This class maintains the render canvas and handles user input
*/
class MapView {
	constructor(width, height, mapWidth, mapHeight, layers) {
		this.width = width;
		this.height = height;
		this.mapWidth = mapWidth;
		this.mapHeight = mapHeight;
		
		// zoom = size of a pixel on screen
		this.viewZoom = Math.min(width/mapWidth, height/mapHeight);
		// left/top = left/top map pixel on screen
		this.viewLeft = (mapWidth-width/this.viewZoom)/2;
		this.viewTop = (mapHeight-height/this.viewZoom)/2;

		let div = document.createElement("div");
		div.style.position = "relative";
		div.style.width = width + "px";
		div.style.height = height + "px";
		div.style.overflow = "hidden";
		this.div = div;
		
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
		this.div.addEventListener("wheel", e => {
			if (!e.deltaY) return;
			let rect = this.div.getBoundingClientRect();
			let x = e.clientX - rect.left;
			let y = e.clientY - rect.top;
			
			let mapX = this.viewLeft + x/this.viewZoom;
			let mapY = this.viewTop + y/this.viewZoom;
			console.log(mapX, mapY);
			
			if (e.deltaY < 0) {
				this.viewZoom *= 2;
			} else {
				this.viewZoom /= 2;
			}
			this.viewLeft = mapX - x/this.viewZoom;
			this.viewTop = mapY - y/this.viewZoom;
			
			for (let l of this.layers) {
				l.moveStart();
				l.moveStep();
				l.moveFinish();
			}
			e.preventDefault();
		});
	}
}


class CanvasLayer {
	// This is similar to a map layer except that tiles are rendered on demand
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

class SVGLayer {
	constructor() {
		this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.svg.style.position = "absolute";
	}
	initialise(mapView) {
		this.mapView = mapView;
		this.svg.setAttribute("viewBox", "0 0 " + this.mapView.width + " " + this.mapView.height);
		mapView.div.appendChild(this.svg);
	}
	moveStart() {}
	moveStep() {
		this.svg.style.left = this.mapView.viewLeft + "px";
		this.svg.style.top = this.mapView.viewTop + "px";
		this.svg.style.width = this.mapView.viewZoom*this.mapView.width + "px";
		this.svg.style.height = this.mapView.viewZoom*this.mapView.height + "px";
	}
	moveFinish() {}
}

class MapTileLayer {
	// uses map tiles, e.g. 256x256 pixels each - uses lower-resolution tiles whenever a higher-resolution tile is missing
}
