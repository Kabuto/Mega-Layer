


/*
	object data type:
	
	{
		type: predefined string
		other properties and references, those starting with $ are ID references, other ones are ordinary references
	}


*/


abstract class StorageBackend {
	
}

class LocalStorageBackend extends StorageBackend {
	constructor() {
		let stored = localStorage.get("dieshot");
		let snapshot = stored ? JSON.parse(stored) : (window.demoSnapshot || {objects: [], updateID: "initial"});
		this.updateLog /* Map<number, dieshotObject|null>[] */ = [];
		this.updateTimestamps /* number[] */ = [];
		this.updateLogIdIndexMap /* {[updateID: string]: number} */ = {[this.snapshot.updateID]: -1};
		this.updateID /* string */ = shapshot.updateID;
		this.objects /* Map<number, dieshotObject> */ = new Map();
		this.referrers /* Map<number, Set<number>> */ = new Map();
		let maxID = 0;
		for (let obj of shapshot.objects) {
			this.objects.put(obj.id, Object.assign({}, obj.data));
			this.referrers.put(obj.id, new Set());
			maxID = Math.max(obj.id, maxID);
		}
		// Reference check
		for (let id of this.objects.keys) {
			let obj = this.objects.get(id);
			for (let prop in obj) {
				if (prop.substring(0,1) == "$") {
					let p = prop.indexOf("$", 1);
					let type = prop.substring(1, p);
					let referred = this.objects.get(obj.data[prop]);
					if (!referred) {
						console.error("Dead reference " + id + "." + prop + " -> " + obj.data[prop]);
						delete obj.data[prop];
					} else if (type != referred.type) {
						console.error("Invalid reference " + id + "." + prop + " -> " + obj.data[prop] + " target has type " + referred.type);
						delete obj.data[prop];
					} else {
						this.referrers.get(obj.data[prop]).add(id);
					}
				}
			}
		}
		// TODO check type sanity
	}
	
	getCurrentSnapshot() {
		return Promise.resolve({objects: this.objects.keys.map(id => ({id: id, data: Object.assign({}, this.objects.get(id))})), updateID: this.updateID});
	}
	getUpdatesAfter(updateID) {
		let allObjects = new Map();
		let start = this.updateLogIdIndexMap[updateID];
		if (start == null) return Promise.reject(new Error("Unknown update"));
		for (let i = start+1; i < this.updateLog.length; i++) {
			let updateMap = this.updateLog[i];
			for (let id of updateMap.keys) {
				allObjects.put(id, updateMap.get(j).data);
			}
		}
		return Promise.resolve({objects: allObjects.keys.map(id => ({id: id, data: Object.assign({}, allObjects.get(id))})), updateID: this.updateID});
	}
	store(objects) {
		return new Promise((resolve, reject) => {
			try {
				resolve(this.store2(objects));
			} catch (e) {
				reject(e);
			}
		});
	}
	store2(objects, getUpdatesAfterUpdateID) {
		// internal IDs are mapped to external IDs
		let internalIDMap = new Map();
		
		// objects: list of objects to be stored (or deleted)
		// check that no foreign keys are violated
		// i.e. no objects may be deleted that still exist
		// and no reference may be created to an object that doesn't exist
		
		// IDs of objects that were deleted
		let deleted = new Set();
		
		// Objects that were added or updated
		let addedOrUpdated = new Map();
		
		// XOR difference to the official set of referrers
		let referrersDiff = new Map();
		
		let getActualReferrers = (id) => {
			let set1 = this.referrers.get(id);
			let set2 = referrersDiff.get(id);
			if (!set2 || set2.isEmpty()) return set1;
			if (!set1 || set1.isEmpty()) return set2;
			let newSet = new Set();
			for (let i of set1) if (!set2.has(i)) newSet.add(i);
			for (let i of set2) if (!set1.has(i)) newSet.add(i);
			return newSet;
		};
		
		let doWithRefs = (data, handler) => {
			for (let prop in data) {
				if (prop.substring(0,1) == "$") {
					let p = prop.indexOf("$", 1);
					let type = prop.substring(1, p);
					let ref = data[prop];
					handler(ref, type, prop);
				}
			}
		};
		
		let registerOrUnregisterRefs = (id, data) => {
			doWithRefs(ref => {
				if (!referrersDiff.containsKey(ref)) referrersDiff.put(ref, new Set());
				let set = referrersDiff.get(ref);
				if (set.has(id)) set.remove(id); else set.add(id);
			});
		};
		
		let getObj = id => deleted.has(id) ? null : (addedOrUpdated.get(id) || this.objects.get(id));
		
		// Do changes to the difference prepared above first
		for (let obj of objects) {
			if (obj.data == null) {	
				// Must not delete an internal ID that doesn't exist yet
				let id = obj.id < 0 ? internalIDMap.get(obj.id) : obj.id;
				if (id == null) throw new Error("Invalid ID " + obj.id);
				// get obj
				let objToDelete = getObj(id);
				// ignore attempts to delete non-existing objects
				if (!objToDelete) {
					if (obj.oldData) throw new Error("Cannot delete object " + id + " as the specified old-data condition is not met since there's no such old object");
					continue;
				}
				// check old data
				if (obj.oldData) {
					for (let i in objToDelete) if (objToDelete[i] != obj.oldData[i]) throw new Error("Cannot delete object " + id + " as the specified old-data condition is not met: property " + i + " was " + objToDelete[i] + " but was expected to be " + obj.oldData[i]);
					for (let i in obj.oldData) if (objToDelete[i] != obj.oldData[i]) throw new Error("Cannot delete object " + id + " as the specified old-data condition is not met: property " + i + " was " + objToDelete[i] + " but was expected to be " + obj.oldData[i]);
				}
				// check refererrers
				let refs = getActualReferrers();
				if (refs && !refs.isEmpty()) throw new Error("There are still referrers referring " + id + ": " + refs.join(", "));
				// unregister own referrers
				registerOrUnregisterRefs(id, objToDelete);
				// delete!
				addedOrUpdated.delete(id);
				deleted.add(id);
				referrersDiff.delete(id);
			} else if (obj.id != null && (obj.id >= 0 || internalIDMap.has(obj.id))) {
				// update an object
				let id = obj.id < 0 ? internalIDMap.get(obj.id) : obj.id;

				let old = getObj(id);
				let newObj = Object.assign({}, obj.data);
				if (!old) throw new Error("Tried to update a non-existing object");
				if (newObj.type != old.type) throw new Error("Object types cannot be changed; tried to replace type " + old.type + " with type " + obj.data.type);
				if (obj.oldData) {
					for (let i in old) if (old[i] != obj.oldData[i]) throw new Error("Cannot update object " + id + " as the specified old-data condition is not met: property " + i + " was " + old[i] + " but was expected to be " + obj.oldData[i]);
					for (let i in obj.oldData) if (old[i] != obj.oldData[i]) throw new Error("Cannot update object " + id + " as the specified old-data condition is not met: property " + i + " was " + old[i] + " but was expected to be " + obj.oldData[i]);
				}
				registerOrUnregisterRefs(old);
				// check new references for validity
				doWithRefs(newObj, (ref, type, prop) => {
					let id = ref < 0 ? internalIDMap.get(ref) : ref;
					if (id == null) throw new Error("Invalid ID " + ref);
					if (ref < 0) newObj[prop] = id;
					let obj = getObj(id);
					if (!obj) throw new Error("Attempted to create a dead reference");
					if (obj.type != type) throw new Error("Attempted to create a reference to an object with wrong type");
				});
				
				registerOrUnregisterRefs(newObj);
				addedOrUpdated.put(id, newObj);
			} else {
				// create new object
				let id = ++this.maxID;
				if (obj.id != null) internalIDMap.put(obj.id, id);

				let newObj = Object.assign({}, obj.data);
				// check new references for validity
				doWithRefs(newObj, (ref, type, prop) => {
					let id = ref < 0 ? internalIDMap.get(ref) : ref;
					if (id == null) throw new Error("Invalid ID " + ref);
					if (ref < 0) newObj[prop] = id;
					let obj = getObj(id);
					if (!obj) throw new Error("Attempted to create a dead reference");
					if (obj.type != type) throw new Error("Attempted to create a reference to an object with wrong type");
				});
				
				registerOrUnregisterRefs(newObj);
				addedOrUpdated.put(id, newObj);
			}
		}
		
		// Apply differences to internal data structures
		for (let i of deleted) {
			this.objects.delete(i);
			this.referrers.delete(i);
		}
		for (let i of addedOrUpdated.keys) {
			this.objects.put(i, addedOrUpdated.get(i));
			if (!this.referrers.has(i)) this.referrers.put(i, new Set());
		}
		
		for (let i of referrersDiff.keys) {
			let set = this.referrers.get(i);
			for (let j of referrersDiff.get(i)) {
				if (set.has(j)) set.remove(j); else set.add(j);
			}
		}
		for (let i of deleted) {
			addedOrUpdated.put(i, null);
		}
		
		this.updateID = "r" + Math.random();
		this.updateLogIdIndexMap[this.updateID] = this.updateLog.length;
		this.updateLog.push(addedOrUpdated);
		this.updateTimestamps.push((new Date()).getTime());

		// update persistent storage
		localStorage.put("dieshot", JSON.stringify({objects: this.objects.keys.map(id => ({id: id, data: this.objects.get(id)})), updateID: this.updateID}));
		
		// Return changeset
		return {idMap: internalIDMap, updates: getUpdatesAfterUpdateID != null ? this.getUpdatesAfter(getUpdatesAfterUpdateID) : null};
	}
	
	// Returns a function that, upon calling, returns all data recorded since creation.
	// That function, when called, will return a function that contains all data recorded so far, which, upon calling, will reset the backend to the initial state and initiate playback; its 4 parameters are:
	// * backend: the backend to use (must support resetting; only the local backend is supposed to support doing so)
	// * errorCallback: an optional callback that will be called asynchronously with any errors that were encountered
	// * finishCallback: an optional callback that will be called when playback finished
	// Playback can be slower than recording since it will always wait for the backend to respond.
	// The main purpose of this recorder is to test concurrency by editing while playback is active
	getRecorder() {
		let created = (new Date()).getTime();
		let firstMacro = this.updateTimestamps.length;
		let snapshot = this.getSnapshot();
		return () => {
			let finished = (new Date()).getTime();
			let timestamps = this.updateTimestamps.slice(firstMacro);
			timestamps.push(finished);
			let updateLog = this.updateLog.slice(firstMacro);
			return (backend, errorCallback, finishCallback) => {
				let next = 0;
				let start = created;
				let promise = null;
				snapshot.then(snapshotData => {
					backend.resetToSnapshot(snapshotData);
					let nextStep = () => {
						(promise || Promise.resolve()).then(() => {
							if (next == updateLog.length) {
								if (finishCallback) finishCallback();
								return;
							}
							promise = backend.store(updateLog[next].keys.map(id => ({id: id, data: updateLog[next].get(id)})));
							setTimeout(nextStep, timestamps[next+1]-timestamps[next]);
							next++;
						}, e => {
							errorCallback ? errorCallback(e) : alert("Playback error: " + e);
						});
					};
					setTimeout(nextStep, timestamps[0]-created);
				}, e => {
					errorCallback ? errorCallback(e) : alert("Playback error: " + e);
				});
			};
		};
	}
	
	// resets the backend to the snapshot, eradicating all history. Beware that directly afterwards it must be replaced with a newly constructed version or else it might not work
	resetToSnapshot(snapshot) {
		localStorage.put("dieshot", JSON.stringify(snapshot));
	}
}

class DelayedResponseBackend extends StorageBackend {
	constructor(mainBackend, delay) {
		this.wrappee = mainBackend;
		this.delay = delay != null ? delay : 2000;
	}
	private delay(promise) {
		return new Promise((resolve, reject) => {
			setTimeout(() => resolve(promise), this.delay);
		});
	}
	getCurrentSnapshot() {
		return this.delay(this.wrappee.getCurrentSnapshot());
	}
	getUpdatesAfter(updateID) {
		let allObjects = new Map();
		let start = this.updateLogIdIndexMap[updateID];
		if (start == null) return Promise.reject(new Error("Unknown update"));
		for (let i = start+1; i < this.updateLog.length; i++) {
			let updateMap = this.updateLog[i];
			for (let id of updateMap.keys) {
				allObjects.put(id, updateMap.get(j).data);
			}
		}
		let result = [];
		for (let i of allObjects.keys) {
			result.push([id: i, data: allObjects.get(i)]);
		}
		return Promise.resolve({objects: result, updateID: this.updateID});
	}
	store(objects) {
}
