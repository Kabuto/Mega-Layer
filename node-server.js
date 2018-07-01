const http = require('http'),
    fileSystem = require('fs'),
    path = require('path');
	
// get the database and construct a new object instance (kludge as I don't want to use modules... yet)
let database = eval(fileSystem.readFileSync('database.js', 'utf8') + ";new Database();"); 
	
// This database always stores the current snapshot
let lastUpdateId = "start";

// load the database to memory
console.log(`Opening DB`);
let dbFile = fileSystem.openSync('database.obj', 'as+');
process.on('exit', () => {
  console.log(`About to exit, closing DB`);
  fileSystem.closeSync(dbFile);
  console.log(`DB closed`);
});

let count = 0;
for (;;) {
	let headerBuf = Buffer.alloc(8);
	let bytesRead = fileSystem.readSync(dbFile, headerBuf, 0, 8);
	if (bytesRead == 0) break;
	if (bytesRead != 8) throw new Error();
	let metadataSize = headerBuf.readInt32LE(0);
	let updatesSize = headerBuf.readInt32LE(4);
	let metadataBuf = Buffer.alloc(metadataSize);
	if (fileSystem.readSync(dbFile, metadataBuf, 0, metadataSize) != metadataSize) throw new Error();
	let updatesBuf = Buffer.alloc(updatesSize);
	if (fileSystem.readSync(dbFile, updatesBuf, 0, updatesSize) != updatesSize) throw new Error();
	let metadata = JSON.parse(metadataBuf.toString());
	let updates = JSON.parse(updatesBuf.toString());
	lastUpdateId = metadata.updateId;
	database.modify(updates);
	count++;
	//console.log(`entry ${metadata.updateId} containing ${updates.length} changes`);
}
//console.log(`last update id is ${lastUpdateId}`);
console.log(`${count} entries read, starting web server`);


// List of recent changes
let recentChanges = [];
// Update ID from before all the changes in the list of recent changes
let prevUpdateId = lastUpdateId;
let serverIDGenerator = [...database.getAllIds()].reduce((a,b) => Math.max(a,b), 0);

//console.log(`prev update id is ${prevUpdateId}`);

	
const hostname = '127.0.0.1';
const port = 3000;


function ignoringErrors(req, action) {
	req.on('error', e => console.log(e));
	try {
		action();
	} catch (e) {
		console.log(e);
	}
}

function respondWithFile(req, res, filename, type) {
	ignoringErrors(req, () => {
		let filePath = path.join(__dirname, filename);
		// ignore errors
		if (fileSystem.existsSync(filePath)) {
			res.writeHead(200, {
				'Content-Type': type,
				'Content-Length': fileSystem.statSync(filePath).size
			});
			fileSystem.createReadStream(filePath).pipe(res);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
}

function simpleResponse(req, res, status, message) {
	ignoringErrors(req, () => {
		res.writeHead(status, {'Content-Type': 'text/plain'});
		res.end(message || "");
	});
}

// Parses JSON data. In case of an error an error is returned to the client, the recipient can thus just ignore the error when not needed.
function parseJSONResponse(req, res) {
	return new Promise((resolve, reject) => {
		let jsonString = '';

		req.on('error', e => {
			jsonString = null;
			simpleResponse(req, res, 400);
			reject(e);
		});
		
		req.on('data', data => {
			if (jsonString == null) return;
			jsonString += data;
			// Abort when exceeding ~ 10 MB of JSON data
			if (jsonString.length > 1e7) {
				jsonString = null;
				simpleResponse(req, res, 413);
				req.connection.destroy();
				reject(new Error("Maximum size exceeded"));
			}
		});

		req.on('end', () => {
			if (jsonString != null) {
				try {
					resolve(JSON.parse(jsonString));
				} catch (e) {
					simpleResponse(req, res, 400, e.message);
					reject(e);
				}
			}
		});
	});
}

const server = http.createServer((req, res) => {
	if (req.url == "/") {
		respondWithFile(req, res, 'index.html', 'text/html');
	} else if (req.url == "/backendProvider.js") {
		respondWithFile(req, res, 'backendProvider.node.js', 'text/html');
	} else if (req.url.match(/^\/[\w\-]+\.js$/)) {
		respondWithFile(req, res, req.url.substring(1), 'application/javascript');
	} else if (req.url.match(/^\/[\w\-]+\.css$/)) {
		respondWithFile(req, res, req.url.substring(1), 'text/css');
	} else if (req.url.match(/^(\/(?!\.\.?\/)[\w\-\.~]+)+\/[\w\-\.~]+\.jpg$/)) {
		// map provider
		respondWithFile(req, res, req.url.substring(1), 'image/jpeg');
	} else if (req.url.match(/^\/updates(\?after=([^#&]+))?$/)) {
		handleUpdate(req, res, RegExp.$1 ? decodeURIComponent(RegExp.$2) : null);
	} else {
		simpleResponse(req, res, 404);
	}
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

// This method handles a request that wants to retrieve and optionally store database updates
function handleUpdate(req, res, after) {
	if (req.method == "POST") {
		parseJSONResponse(req, res).then(updates => {
			let idMap = null, error = null;
			try {
				// We don't get the actual update result yet since we'll retrieve it from the recentChanges list later on
				//console.log(`Received a DB update consisting of ${updates.length} changes`);
				idMap = storeInDB(updates);
			} catch (e) {
				console.log(`DB update failed`, e);
				error = e.message;
			}
			sendUpdateResponse(res, after, idMap, error);
		}, e => {}).catch(e => console.log(e));
	} else {
		sendUpdateResponse(res, after);
	}
}

// This method stores updates in the database and returns a map of client to server ID mappings
function storeInDB(changes) {
	// map all internal IDs
	let internalToExternalIDMap = new Map();
	let result = [];
	let dbPatchState = new Map();
	let mapIDs = obj => {
		if (!obj || obj === true) return obj;
		obj = Object.assign({}, obj);
		for (let k in obj) {
			if (k[0] =="$" && obj[k] != null && obj[k] < 0) {
				if (!internalToExternalIDMap.has(obj[k])) throw new Error();
				obj[k] = internalToExternalIDMap.get(obj[k]);
			}
		}
		return obj;
	};
	for (let change of changes) {
		if (!change.oldData && !change.data) {
			continue;
		}
		let id = change.id;
		if (id == null || id < 0) {
			if (!change.oldData && change.data) {
				// insert - don't assume reviving
				id = ++serverIDGenerator;
				if (change.id != null) {
					internalToExternalIDMap.set(change.id, id);
				}
			} else {
				// update/delete
				if (change.id != null) {
					id = internalToExternalIDMap.get(change.id);
					if (id == null) throw new Error(JSON.stringify(changes));
				}
			}
		}
		// ensure that the update contains real old data, not just a "true" placeholder
		let oldData = mapIDs(change.oldData);
		if (oldData === true) {
			oldData = (dbPatchState.has(id) ? dbPatchState : database).get(id);
			if (!oldData) throw new Error("Tried to update/delete a non-existing object"); // the database could deal with this instead
		}
		let data = mapIDs(change.data);
		dbPatchState.set(id, data);
		result.push({id: id, oldData: oldData, data: data});
	}
	// update local database (and detect errors)
	database.modify(result);

	// Discard old entries from list of recent changees
	let timestamp = (new Date()).getTime();
	while (recentChanges.length && recentChanges[0].metadata.timestamp < timestamp-60*1000) prevUpdateId = recentChanges.shift().metadata.updateId;
	//console.log(`prev update id is ${prevUpdateId}`);

	// store updates in local updates list
	lastUpdateId = "r" + Math.random();
	//console.log(`last update id is ${lastUpdateId}`);
	let metadata = {updateId: lastUpdateId, timestamp: timestamp};
	recentChanges.push({updates: result, metadata: metadata});

	// store updates in file system
	let metadataBuf = Buffer.from(JSON.stringify(metadata));
	let updatesBuf = Buffer.from(JSON.stringify(result.map(entry => {
		if (entry.data && entry.oldData) return {id: entry.id, oldData: true, data: entry.data};
		if (entry.data) return {id: entry.id, data: entry.data};
		if (entry.oldData) return {id: entry.id, oldData: true};
		throw new Error();
	})));
	let headerBuf = Buffer.alloc(8);
	headerBuf.writeInt32LE(metadataBuf.length, 0);
	headerBuf.writeInt32LE(updatesBuf.length, 4);
	if (fileSystem.writeSync(dbFile, headerBuf, 0, 8) != 8) throw new Error();
	if (fileSystem.writeSync(dbFile, metadataBuf, 0, metadataBuf.length) != metadataBuf.length) throw new Error();
	if (fileSystem.writeSync(dbFile, updatesBuf, 0, updatesBuf.length) != updatesBuf.length) throw new Error();
	fileSystem.fsyncSync(dbFile);

	// return the map of ID mappings
	return internalToExternalIDMap;
}

// This method sends a response to the clint
function sendUpdateResponse(res, after, idMap, error) {
	let updates;
	if (after == null) {
		//console.log("after == null");
		// dump entire DB
		updates = [...database.getAllIds()].map(id => ({id: id, data: database.get(id)}));
	} else if (after == prevUpdateId) {
		//console.log("after.length = " + recentChanges.length);
		// special case - all recent updates (can happen naturally so this needs to be checked for)
		updates = [].concat.apply([], recentChanges.map(item => item.updates));
	} else {
		// scan list of recent changes
		let idx = recentChanges.findIndex(item => item.metadata.updateId == after);
		if (idx == -1) {
			// error - there's no such recent change
			res.writeHead(500, {'Content-Type': 'text/plain'});
			//console.log("Cannot find update " + after + " in recent changes; these are: " + recentChanges.map(item => item.metadata.updateId).join(","));
			res.end("Cannot find update " + after + " in recent changes");
			return;
		} else {
			//console.log(`after.length = ${recentChanges.length-(idx+1)}`);
		}
		updates = [].concat.apply([], recentChanges.slice(idx+1).map(item => item.updates));
	}
	//console.log(`Client poll contains ${updates.length} changes`);
	let response = {objects: updates, updateId: lastUpdateId};
	if (idMap) response.clientToServerIDMap = [...idMap];
	if (error) response.error = error;
	
	res.writeHead(200, {'Content-Type': 'application/json'});
	res.end(JSON.stringify(response));
}

