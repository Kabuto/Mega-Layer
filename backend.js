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
 *
 * TODO what about compressed storage:
 *
 * Group objects by what their type is, whether their ID is referenced and what set of keys they use.
 * 
 * Renumber IDs of objects that have their IDs referenced by sorting them in ascending order, within the supergroup of objects of identical type, omitting IDs of objects that are not referenced (since referrers are unique per target type).
 *
 * Store each such group as an array: boolean (ID used or not?), string (type), number (number of keys besides type), ...string (all keys besides type), values of actual objects, one after another.
 *
 * Limit precision of floating point numbers by premultiplying and then rounding to integer, but store such premultiplication factors within compressed data as well.
 *
 * Such a treatment should reduce the size of stored data to 1/4.
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
		let changes;
		if (prevState) {
			changes = JSON.parse(prevState);
			this.database.modify(changes);
			this.serverIDGenerator = changes.map(entry => entry.id).filter(entry => entry).reduce((a,b) => Math.max(a,b), 0);
		} else {
			localStorage.setItem("dieshot", "[]");
			alert("This web app automatically saves your edit actions on your computer. Please check that your browser does not discard them when you restart it so you don't accidentally lose your edit actions.");
			changes = [];
			this.serverIDGenerator = 0;
		}
		this.doCallback({objects:changes});
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
			localStorage.setItem("dieshot", JSON.stringify([...this.database.getAllIds()].map(id => ({id: id, data: this.database.get(id)}))));
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
