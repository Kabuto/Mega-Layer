# Mega Layer

Browser-based GUI for reverse engineering PCBs and die / IC shots

## About

This is a tool for tracing photographs of ICs and PCBs for the purpose of reverse engineering them to schematics.

## Setup

You need a tile provider that provides tiles

Copy this project's content to a folder of your choice and place a `config.js` file in there:

```js
window.config = {
	map: {
		// Width and height of the map. That's the size of the canvas to draw onto
		width: 23429,
		height: 23351,
		// List of layers, one or more images that serve as a background. It's possible to use no background image at all if really desired.
		layers: [
			// examples:
			// {type: "tiles", tileSize: 256, tileProvider: (x,y,z) => "https://localhost/" + (15-z) + "/" + x + "_" + y + ".jpg"}
			// {type: "image", url: "https://localhost/mypicture.jpg", scaleFactor: 8}
		]
	}
};
```

## Testing

Just run index.html locally, it will store all data in your browser's localStorage.

## Installing on a server

The real power only unveils when you run this with its server-side backend enabled. This e.g. allows for concurrent editing.

The server is based on node.js; to use it install the latest node.js version and then execute `node node-server.js` from within the install directory.

Beware, there's no access protection yet, everyone can do any edit action they want if they happen to get or guess your server's address.

## External dependencies

A decent web browser, and node.js if you want to run this on a server. That's it.

## License

GNU AGPL v3, see included license file

## Thanks

Everyone in #vdp-decap