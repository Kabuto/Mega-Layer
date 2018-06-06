/**
 * Helper class that will store differences to an existing map of sets when being updated. Updates are stored in this map and can be applied to the base map when everything is done.
 */
class DiffMapSet {
	constructor(m) {
		this.m = m;
		this.n = new Map();
	}
	has(k, v) {
		return (this.m.has(k) && this.m.get(k).has(v)) ^
				(this.n.has(v) && this.n.get(k).has(v));
	}
	getAll(k) {
		let a = this.m.get(k), b = this.n.get(k);
		if (!a && !b) return new Set();
		if (!a || a.isEmpty()) return b;
		if (!b || b.isEmpty()) return a;
		let xor = new Set(a);
		for (let id of b) if (xor.has(id)) xor.delete(id); else xor.add(id);
		return xor;
	}
	hasAny(k) {
		let a = this.m.get(k), b = this.n.get(k);
		return (a && !a.isEmpty()) ? (!b || a.size() != b.size() || !a.every(id => b.has(id))) : (b && !b.isEmpty());
	}
	toggle(k,v,newState) {
		let oldState = this.has(k,v);
		if (newState == oldState) return;
		if (newState == null) newState = !oldState;
		let set = this.n.get(k);
		if (!set) {
			this.n.set(k, new Set([v]));
		} else if (set.has(v)) {
			set.delete(v);
		} else {
			set.add(v);
		}
	}
	set(k,v) {
		this.toggle(k,v,true);
	}
	remove(k,v) {
		this.toggle(k,v,false);
	}
	mergeAll() {
		for (let k of this.n.keys()) {
			let merged = this.getAll(k);
			if (!merged.isEmpty) this.m.set(k, merged); else this.m.delete(k);
		}
		this.n = new Map();
	}
	mergeAllRequireExistingKeys() {
		for (let k of this.n.keys()) {
			let merged = this.getAll(k);
			if (this.m.has(k)) {
				this.m.set(k, merged);
			} else if (!merged.isEmpty()) {
				throw new Error();
			}
		}
		this.n = new Map();
	}
	getKeysOfUpdated() {
		return this.n.keys();
	}
}

/**
 * A simple database implementation as used by the client and also by the localStorage backend.
 */
class Database {
	constructor() {
		this.objects = new Map();	// id => data
		this.types = new Map(); // type => Set<id>
		this.referrers = new Map(); // id => Set<id>
		this.listeners = [];
		this.transactionListeners = [];
		this.locked = false;
	}

	checkRefs(id, data) {
		for (let k in data) {
			if (k[0] == "$") {
				let ref = this.objects.get(data[k]);
				if (!ref) {
					throw new Error("Dead reference");
				}
				if (k.substring(1, ref.type.length+1) != ref.type || k[ref.type.length+1] != "$") {
					throw new Error("Invalid reference target type");
				}
			}
		}
	}
	
	add(id, data) {
		if (!data) throw new Error("Cannot create with null");
		return this.modify(id, false, data);
	}
	
	update(id, data, oldData) {
		if (!data) throw new Error("Cannot update with null");
		return this.modify(id, oldData || true, data);
	}
	
	remove(id, oldData) {
		return this.modifyOne(id, oldData || true, null);
	}
	
	/**
	 * Generalised create/update/delete method
	 * @param id ID of the object
	 * @param oldData previous data of the object. false/null = no previous object (i.e. object to be created), true = previous object exists (i.e. object to be updated/deleted), object = previous object exists and MUST have this state
	 * @param data new data of the object. null = none (i.e. object to be deleted), object = new object data (i.e. object to be created or updated)
	 * @return an update set that, when applied, will undo this update's actions
	 */
	modifyOne(id, oldData, data) {
		return this.modify([{id: id, oldData: oldData, data: data}]);
	}

	/**
	 * Mass create/update/delete method
	 * @param updates an array of updates. Each update is a map consisting of an id, oldData and data. See the modifyOne method for the meaning of those.
	 * @return an update set that, when applied, will undo this update's actions
	 */
	modify(updates) {
		if (this.locked) throw new Error("Modifications are not permitted from within listener calls");
		// This map will collect effective updates to the internal object map (i.e. key exists = the corrensponding value in this map overrides the database's state)
		let objectsDiff = new Map();
		// This will collecct effective updates to the referrers map. This is needed for detecting dead references prior to committing.
		let referrersDiff = new DiffMapSet(this.referrers);
		for (let update of updates) {
			// Get properties of update
			let id = update.id;
			let data = update.data;
			let oldData = (objectsDiff.has(id) ? objectsDiff : this.objects).get(id);
			// Verify with current database state that we're doing something meaningful
			if (!update.oldData) {
				if (oldData) throw new Error("Duplicate id");
			} else {
				if (!oldData) throw new Error("Cannot update or delete non-existing objects");
				if (update.oldData !== true) {
					for (let i in update.oldData) if (update.oldData[i] != oldData[i]) throw new Error("Expected and actual old data differ");
					for (let i in oldData) if (update.oldData[i] != oldData[i]) throw new Error("Expected and actual old data differ");
				}
			}
			if (!oldData && !data) continue; // no-op - trying to replace a non-existing object with nothing
			// Verify that no types get replaced. Check twice to prevent sneaky updates by deleting and restoring an object within the same transaction.
			if (data && (oldData && data.type != oldData.type || this.objects.has(id) && data.type != this.objects.get(id).type)) throw new Error("Cannot replace types");
			// Delete old referrers
			if (oldData) {
				for (let k in oldData) {
					if (k[0] == "$" && data[k] != null) {
						referrersDiff.delete(data[k], id);
					}
				}
			}
			// Apply object to temporary updates
			objectsDiff.set(id, Object.assign({},data));
			// Add new references
			if (data) {
				for (let k in data) {
					if (k[0] == "$" && data[k] != null) {
						referrersDiff.add(data[k], id);
					}
				}
			}
		}
		// check integrity - abort when references to no-longer-existing objects are encountered
		// we need to check entries in "objectsDiff" with missing value (i.e. deleted) as well as entries in "referrersDiff" with missing accompanying object
		for (let id of objectsDiff.keys()) {
			if (!objectsDiff.get(id) && referrersDiff.hasAny(id)) {
				throw new Error("Dead reference found");
			}
		}
		for (let id of referrersDiff.getKeysOfUpdated()) {
			// no need to check entries in objectsDiff - they can only cause issues if they are dead and then they will have already been found by the previous check
			if (!objectsDiff.has(id) && !this.objects.has(id) && referrersDiff.hasAny(id)) {
				throw new Error("Dead reference found");
			}
		}
		// check that object references refer objects of the correct type
		for (let id of objectsDiff.keys()) {
			let data = objectsDiff.get(id);
			if (data) {
				for (let k in data) {
					if (k[0] == "$" && data[k] != null) {
						let targetType = (objectsDiff.has(id) ? objectsDiff : this.objects).get(data[k]).type;
						if (k.substring(1, targetType.length+1) != targetType || k[targetType.length+1] != "$") {
							throw new Error("Illegal reference (targeting the wrong type)");
						}
					}
				}
			}
		}

		// If we get here then the update is fine

		// Collect data for undoing later on if needed
		let undoData = objectsDiff.keys().map(id => ({id: id, oldData: objectsDiff.get(id), data: this.objects.get(id)}));
		
		// apply object updates
		for (let id of objectsDiff.keys()) {
			let oldData = this.objects.get(id);
			let newData = objectsDiff.get(id);
			if (!oldData && !newData) continue;
			if (newData) {
				this.objects.set(id, newData);
			} else {
				this.objects.delete(id);
				this.referrers.delete(id);
				this.types.get(oldData.type).delete(id);
			}
			if (!oldData) {
				this.referrers.set(id, new Set());
				let typeSet = this.types.get(newData.type);
				if (!typeSet) {
					typeSet = new Set();
					this.types.set(newData.type, typeSet);
				}
				typeSet.add(id);
			}
		}

		referrersDiff.mergeAllRequireExistingKeys();

		this.locked = true;
		let queryOldData = id => (objectsDiff.has(id) ? objectsDiff : this.objects).get(id);
		for (let id of objectsDiff.keys()) {
			// now reversed
			let newData = this.objects.get(id);
			let oldData = objectsDiff.get(id);
			for (let l of this.listeners) {
				try {
					l(id, oldData, newData, queryOldData);
				} catch (e) {
					console.log(e);
				}
			}
		}
		for (let l of this.transactionListeners) {
			l(new Set(objectsDiff.keys()), queryOldData);
		}
		this.locked = false;
		return undoData;
	}
	
	get(id) {
		return this.objects.get(id);
	}
	
	getReferrers(id) {
		return this.referrers.get(id);
	}
	
	getAllIds() {
		return this.objects.keys();
	}
	
	getIdsOfType(type) {
		return this.types.get(type);
	}
	
	// Adds a listener that will be called on every successful change.
	// Each notification consists of 3 parameters: id, old data (null if object was created), new data (null if object was deleted), old state supplier (call with an id to get the state of the database before the action as queries will always return the new state).
	// Undo actions are also notified in exactly the same way.
	// Important: change listeners must not modify the database! It is permitted to do a delayed update (e.g. using timeouts or promises) but care must be taken to not cause endless updates or stuff like that.
	addChangeListener(listener) {
		this.listeners.push(listener);
	}
	
	// Adds a listener that will be called on every successful transaction.
	// Each update will be accompanied with a set of affected object IDs and a view of the old map.
	addTransactionListener(listener) {
		this.transactionListeners.push(listener);
	}
}