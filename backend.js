/**
 * This defines a number of backends. Each backend provides means for the client for storing data, and in reverse, retrieving other clients' updates.
 * 
 * The constructor gets a callback that's called whenever fresh data is available. After sending an update, the next callback call MUST include the response to this update - asynchronously running backends thus need to discard any data they received inbetween.
 *
 * The first callback call MUST be done soon after calling the constructor (NOT immediately, at least with a timeout) and MUST contain the current state of the database. This callback MUST NOT be omitted if the database is empty.
 *
 * The client MUST wait before sending further until it receives the previous request's response.
 *
 * Also, after the client sends updates the server MUST always respond, even if the client sent an empty list of updates.
 *
 * For further callbacks, it's perfectly fine to omit them when there are no updates available.
 *
 * Methods:
 * update: It takes updates to persist and sends them to the server. The callback will be notified with the result; that notification MUST NOT be done immediately, e.g. a timeout of 0 is needed inbetween.
 */

 
/**
 * This is the simplemost possible backend. It doesn't hold any data; all it does is generating server IDs for client IDs that were submitted.
 */
class LocalStorageBackend {
	/**
	 * @param callback The callback that will be called with updates after executing a method
	 * @param delay    Setting this to numbers > 0 will simulate server response delays
	 * @param prevState Overrides the internal state
	 * @param dontPersist Set to true to disable persisting after each update 
	 */
	constructor(callback, delay, prevState, dontPersist) {
		this.callback = callback;
		this.delay = delay || 0;
		this.database = new Database();
		this.responses = [];
		this.dontPersist = dontPersist;
		if (prevState == null) prevState = localStorage.getItem("dieshot");
		if (prevState) {
			let changes = JSON.parse(prevState);
			this.database.modify(changes);
			this.responses.push(changes);
			this.serverIDGenerator = changes.map(entry => entry.id).filter(entry.id).reduce(Math.max, 0);
		} else {
			this.responses.push([]);
			this.serverIDGenerator = 0;
		}
		setTimeout(() => this.callback(this.responses.shift()), this.delay);
	}
	update(changes) {
		this.update2(changes, false);
	}
	// Fun method: imitate changes occurring in parallel
	updateInParallel(changes) {
		return this.update2(changes, true);
	}
	doCallback(data) {
		this.responses.push(data);
		setTimeout(() => {
			let response = this.responses.shift();
			if (response) this.callback(response);
		}, this.delay);
	}
	persist() {
		if (!this.dontPersist) {
			localStorage.setItem("dieshot", JSON.stringify(this.database.getAllIds().map(id => ({id: id, data: this.database.get(id)}))));
		}
	}
	update2(changes, inParallel) {
		// map all internal IDs
		let internalToExternalIDMap = new Map();
		let result = [];
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
					id = ++this.serverIDGenerator;
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
			result.push({id: id, oldData: mapIDs(change.oldData), data: mapIDs(change.data)});
		}
		// Now we gotta decide what to do
		if (inParallel) {
			// execute - if this fails, the caller will get an exception and it's their problem to deal with it
			this.database.modify(result);
			this.persist();
			this.doCallback({objects: result});
			return ({objects: otherObjects.concat(result), clientToServerIDMap: internalToExternalIDMap});
		} else {
			// if there are any pending callbacks then we need to merge them into this
			// (not doing so would violate the "first callback after updating contains update response" contract)
			let otherObjects = [];
			for (let i = 0; i < this.responses.length; i++) {
				if (this.responses[i].error || this.responses[i].clientToServerIDMap) throw new Error();
				otherObjects.push.apply(otherObjects, this.responses[i].objects);
				this.responses[i] = null;
			}
			try {
				this.database.modify(result);
				this.persist();
				this.doCallback({
					objects: otherObjects.concat(result),
					clientToServerIDMap: internalToExternalIDMap
				});
			} catch (e) {
				// conflict etc.
				console.log(e);
				this.doCallback({
					error: e.message,
					objects: otherObjects
				});
			}
		}
	}
}
