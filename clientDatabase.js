function ClientDatabase() {
	// Helper class that collects both changes and matching undo instructions
	class ChangesCollector {
		constructor() {
			this.changes = new Map();
			this.undo = new Map();
		}
		add(changes, undo) {
			for (let change of changes) {
				let existing = this.changes.get(change.id);
				if (!existing) {
					this.changes.set(change.id, {oldData: change.oldData, data: change.data});
				} else {
					if (!existing.data != !change.oldData) throw new Error();
					if (change.oldData && change.oldData != true) {
						for (let i in change.oldData) if (change.oldData[i] != existing.data[i]) throw new Error();
						for (let i in existing.data) if (change.oldData[i] != existing.data[i]) throw new Error();
					}
					existing.data = change.data;
				}
			}
			for (let i = undo.length-1; i >= 0; i--) {
				let change = undo[i];
				let existing = this.undo.get(change.id);
				if (!existing) {
					this.undo.set(change.id, {oldData: change.oldData, data: change.data});
				} else {
					if (!existing.oldData != !change.data) throw new Error("Failed to prepend undo " + JSON.stringify(change) + " to " + JSON.stringify(existing));
					if (existing.oldData && existing.oldData != true) {
						for (let i in existing.oldData) if (existing.oldData[i] != change.data[i]) throw new Error();
						for (let i in change.data) if (existing.oldData[i] != change.data[i]) throw new Error();
					}
					existing.oldData = change.oldData;
				}
			}
		}
		addFromCollector(collector) {
			this.add(collector.getChanges(), collector.getUndo());
		}
		getChanges() {
			return [...this.changes.keys()].map(id => ({id: id, oldData: this.changes.get(id).oldData, data: this.changes.get(id).data}));
		}
		getUndo() {
			return [...this.undo.keys()].map(id => ({id: id, oldData: this.undo.get(id).oldData, data: this.undo.get(id).data}));
		}
		replace(changes, undo) {
			if (changes != null) this.changes = new Map();
			if (undo != null) this.undo = new Map();
			this.add(changes || [], undo || []);
		}
		isEmpty() {
			return this.changes.size == 0 && this.undo.size == 0;
		}
	}

	// Changes are not to be sent directly to the database object but to a wrapper which prepares committing, backend communication and stuff
	return {
		// List of local changes that are waiting to be sent to the server
		pending: new ChangesCollector(),
		// List of local changes that are part of a current edit operation and thus must not be sent to the server
		uncommitable: null,
		// List of local changes that are currently being done - they are collected and added to "pending" and treated as a group for undo/redo
		current: new ChangesCollector(),
		// List of local changes that have been sent to the server and are waiting for a response
		inProgress: null,
		requestPending: false,
		database: new Database(),
		updateListeners: [],
		generalUpdateListeners: [],
		internalIDGenerator: 0,
		submitTimeout: null,
		undoEntries: [],
		undoOffset: 0,
		redoEntries: [],
		redoOffset: 0,

		callListeners(oldState, newState, getOldData, getNewData) {
			for (let l of this.updateListeners) {
				try {
					l(oldState, newState, getOldData, getNewData);
				} catch (e) {
					console.log(e);
				}
			}
		},

		callGeneralListeners() {
			for (let l of this.generalUpdateListeners) {
				try {
					l();
				} catch (e) {
					console.log(e);
				}
			}
		},
		
		init(backendFactory) {
			let initialised = false;
			return new Promise((resolve, reject) => {
				this.backend = backendFactory(response => {
					if (!initialised) {
						initialised = true;
						try {
							this.database.modify(response.objects);
							for (let id of this.database.getAllIds()) {
								this.callListeners(null, this.database.get(id), id => null, id => this.database.get(id));
							}
							this.callGeneralListeners();
							this.submit();
							resolve();
						} catch (e) {
							reject(e);
						}
					} else {
						this.handleResponse(response);
					}
				});
			});
		},
		
		insert(data) {
			if (data == null) throw new Error();
			let id = --this.internalIDGenerator;
			this.modifyOne(id, null, data);
			return id;
		},
		
		update(id, oldData, data) {
			if (data == null) throw new Error();
			this.modifyOne(id, oldData || true, data);
		},
		
		delete(id, oldData) {
			this.modifyOne(id, oldData || true, null);
		},
		
		// enables writing of changes without committing them to the backend for now
		// The idea is to allow editing such as drag and drop which leads to a large number of updates without poking the server all the time
		// Just like normal (unwritten) updates such updates can be cancelled too in case of conflicts - in that case the editor can either be informed about a callback or by querying using the "isUncommited" method.
		setUncommitted(abortCallback) {
			if (this.uncommitable) throw new Error();
			this.uncommitable = new ChangesCollector();
			this.uncommitableAbortCallback = abortCallback;
		},
		
		// tests whether uncommitted changes were activated (does not check the presence of any actual changes, just that they are enabled and they were not cancelled)
		isUncommitted() {
			return this.uncommitable != null;
		},
		
		rollback() {
			if (!this.uncommitable) throw new Error();
			this.modify(this.uncommitable.getUndo());
			this.uncommitable = null;
			this.uncommitableAbortCallback = null;
		},
		
		commit() {
			if (!this.uncommitable) throw new Error();
			this.pending.addFromCollector(this.uncommitable);
			this.uncommitable = null;
			this.uncommitableAbortCallback = null;
			this.submit();
		},
		
		// Modifies a single entry. Modification requests are collected and only sent once the calling code exited.
		modifyOne(id, oldData, data) {
			this.modify([{id: id, oldData: oldData, data: data}]);
		},
		
		// Modifies multiple entries. Modification requests are collected and only sent once the calling code exited.
		modify(updates) {
			let oldState = new Map();
			for (let update of updates) {
				oldState.set(update.id, this.database.get(update.id));
			}
			let undoData = this.database.getUndoUpdates(updates)[0];
			this.database.modify(updates);
			for (let id of oldState.keys()) {
				this.callListeners(oldState.get(id) ? {id: id, data: oldState.get(id)} : null, this.database.get(id) ? {id: id, data: this.database.get(id)} : null, id => (oldState.has(id) ? oldState : this.database).get(id), id => this.database.get(id));
			}
			this.callGeneralListeners();
			(this.uncommitable || this.current).add(updates, undoData);
			this.submit();
		},
		
		addUpdateListener(listener) {
			this.updateListeners.push(listener);
		},
		
		addGeneralUpdateListener(listener) {
			this.generalUpdateListeners.push(listener);
		},
		
		tryApplyUpdates(serverUpdates) {
			// Get undo data first so all locally buffered actions can be undone, even if they are discarded later due to conflicts
			let undo = [].concat(
				this.uncommitable ? this.uncommitable.getUndo() : [],
				this.pending.getUndo(),
				this.inProgress ? this.inProgress.getUndo() : []
			);
			
			for (;;) {
				let allChanges = [
					undo,
					serverUpdates,
					this.pending.getChanges(),
					this.uncommitable ? this.uncommitable.getChanges() : []
				];
				
				let undoBlocks = this.database.getUndoUpdates.apply(this.database, allChanges);
				let allUpdates = [].concat.apply([], allChanges);
				let oldState = new Map();
				for (let update of allUpdates) {
					oldState.set(update.id, this.database.get(update.id));
				}
				
				try {
					this.database.modify(allUpdates);
					if (this.uncommitable) this.uncommitable.replace(null, undoBlocks[3]);
					this.pending.replace(null, undoBlocks[2]);
					this.inProgress = null;
					return oldState;
				} catch (e) {
					// Committing failed
					// There can be 2 culprits: pending changes (i.e. not sent to the server yet) and uncommitable changes (i.e. current editing operations)
					// If there are both then either could be the culprit, but even if pending changes are the actual cause chances are that uncommitable changes depend on them and will thus fail too, thus for now we always undo uncommitable changes first,
					// cancelling active editing operations
					if (this.uncommitable && !this.uncommitable.isEmpty()) {
						// discard uncommitable changes (undo will still be executed as it has been copied to a local var above)
						// a listener will be called to ensure that the editor knows
						this.uncommitable = null;
						if (this.uncommitableAbortCallback) {
							try {
								this.uncommitableAbortCallback();
							} catch (e) {
								console.log(e);
							}
						}
						this.uncommitableAbortCallback = null;
					} else if (!this.pending.isEmpty()) {
						// discard pending changes (undo will still be executed as it has been copied to a local var above)
						this.pending = new ChangesCollector();
					} else {
						// internal error - no pending changes left to be undone
						throw e;
					}
					console.log("Conflict during updating", e);
				}
			}
		},
		
		submit() {
			if (this.submitTimeout == null && (!this.current.isEmpty() || !this.pending.isEmpty())) {
				this.submitTimeout = setTimeout(() => this.submit2(), 0);
			}
		},
		
		makeUndoEntry(forRedo) {
			if (!this.current.isEmpty()) {
				if (forRedo) {
					let redoEntry = this.current.getChanges();
					if (this.redoEntries.length >= 100) {
						this.redoEntries.shift();
						this.redoOffset--;
					}
					this.redoEntries.push(redoEntry);
				} else {
					let undoEntry = this.current.getUndo();
					if (this.undoEntries.length >= 100) {
						this.undoEntries.shift();
						this.undoOffset--;
					}
					this.undoEntries.push(undoEntry);
					this.redoEntries = [];
				}
				this.pending.addFromCollector(this.current);
				this.current = new ChangesCollector();
			}
			console.log("undo stack size = " + this.undoEntries.length + ", redo stack size = " + this.redoEntries.length);
			console.log("Undo stack", JSON.stringify(this.undoEntries));
		},

		submit2() {
			this.makeUndoEntry();
			this.submitTimeout = null;

			// will check later
			if (this.requestPending) return;
			
			this.inProgress = this.pending;
			this.pending = new ChangesCollector();
			this.requestPending = true;

			this.backend.update(this.inProgress.getChanges());
		},

		handleResponse(response) {
			// This clears the "current" object so we don't need to handle it
			this.makeUndoEntry();
			
			let serverUpdates = response.objects;
			let idMap = response.clientToServerIDMap || new Map();

			// Log any errors but proceed normally. We undo all changes in progress anyway so after an error they will be undone.
			if (response.error) console.error(response.error);
			
			// The updates we just submitted already have their IDs mapped.
			// But we still need to apply them to pending changes
			let mapIDs = obj => {
				if (!obj || obj === true) return obj;
				obj = Object.assign({}, obj);
				for (let k in obj) {
					if (k[0] =="$" && obj[k] != null && obj[k] < 0 && idMap.has(obj[k])) {
						obj[k] = idMap.get(obj[k]);
					}
				}
				return obj;
			};
			for (let item in this.pending.getChanges()) {
				item.oldData = mapIDs(item.oldData);
				item.data = mapIDs(item.data);
			}
			if (this.uncommitable) {
				for (let item in this.uncommitable.getChanges()) {
					item.oldData = mapIDs(item.oldData);
					item.data = mapIDs(item.data);
				}
			}
			let oldState = this.tryApplyUpdates(serverUpdates);
			
			for (let block of this.undoEntries) {
				for (let entry of block) {
					entry.id = idMap.has(entry.id) ? idMap.get(entry.id) : entry.id;
					entry.data = mapIDs(entry.data);
					entry.oldData = mapIDs(entry.oldData);
				}
			}
			
			
			// verify
			let targetIDs = new Set(idMap.values());
			for (let id of idMap.keys()) if (this.database.get(id) != null) throw new Error();
			for (let id of targetIDs.keys()) if (oldState.get(id) != null) throw new Error();
			// call all listeners
			for (let id of oldState.keys()) {
				if (targetIDs.has(id)) continue; // the original ID will be used for calling
				let id2 = idMap.has(id) ? idMap.get(id) : id;
				let oldData = oldState.get(id);
				let newData = this.database.get(id2);
				this.callListeners(oldData && {id: id, data: oldData}, newData && {id: id2, data: newData}, id => (oldState.has(id) ? oldState : this.database).get(id), id => this.database.get(id));
			}
			this.callGeneralListeners();

			// Only after mapping all IDs re-apply pending local updates
			this.inProgress = null;
			this.requestPending = false;
			this.submit();
		},
		
		undo() {
			if (this.undoEntries.length == 0) { console.info("Undo stack is empty"); return; }
			if (this.uncommitable) throw new Error("Cannot undo during a transaction");
			if (!this.current.isEmpty()) throw new Error("Cannot undo before finishing the previous undo layer step");
			this.modify(this.undoEntries.pop());
			this.makeUndoEntry(true);
		},
		
		redo() {
			if (this.redoEntries.length == 0) { console.info("Redo stack is empty"); return; }
			if (this.uncommitable) throw new Error("Cannot undo during a transaction");
			if (!this.current.isEmpty()) throw new Error("Cannot undo before finishing the previous undo layer step");
			this.modify(this.redoEntries.pop());
			this.makeUndoEntry(false);
		},
		
		get(id) {
			return this.database.get(id);
		},
		
		getReferrers(id) {
			return this.database.getReferrers(id);
		},
		
		getIdsOfType(type) {
			return this.database.getIdsOfType(type);
		},
		
		addChangeListener(listener) {
			this.database.addChangeListener(listener);
		}
	};
}