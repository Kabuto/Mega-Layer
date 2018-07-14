function SettingsTool(db) {
	return {
		name: "settings",
		activate() {
			let c = (name, ...attrsOrChildren) => {
				let result = document.createElement(name);
				for (let item of attrsOrChildren) {
					if (item == null) continue;
					if (item.nodeType) {
						result.appendChild(item);
					} else if (typeof(item) == "object") {
						for (let i in item) {
							if (item[i] == null) continue;
							if (i == "style" && typeof(item[i]) == "object") {
								for (let j in item[i]) {
									if (item[i][j] != null) result.style[j] = item[i][j];
								}
							} else if (typeof(item[i]) == "function") {
								result[i] = item[i];
							} else {
								result.setAttribute(i, item[i]);
							}
						}
					} else {
						result.appendChild(document.createTextNode(item.toString()));
					}
				}
				return result;
			};
			let settings = mapView.getSettings();
			
			this.dialog = c("div", {class: "dialog"});
			document.body.appendChild(this.dialog);
			
			let handleExport = () => {
				let text;
				let layer = this.dialog.appendChild(c("div", {class: "dialog-popup"},
					c("div", "Export"),
					text = c("textarea", {class: "dialog-importexport"}),
					c("div",
						c("input", {type: "button", value: "Close", onclick: () => layer.parentNode.removeChild(layer)})
					)
				));
				text.value = localStorage.getItem("dieshot");
			};
			
			let handleImport = () => {
				let text;
				let layer = this.dialog.appendChild(c("div", {class: "dialog-popup"},
					c("div", "Import"),
					text = c("textarea", {class: "dialog-importexport"}),
					c("div",
						c("input", {type: "button", value: "Use", onclick: () => {
							try {
								new Database().modify(JSON.parse(text.value));
								localStorage.setItem("dieshot", text.value);
								document.body.innerHTML = "";
								location.reload();
							} catch (e) {
								console.log(e);
								alert("Failed to import: " + e.message);
							}
						}}),
						c("input", {type: "button", value: "Cancel", onclick: () => layer.parentNode.removeChild(layer)})
					)
				));
			};
			let updateSetting = (name, value) => {
				let settings = mapView.getSettings();
				settings[name] = value;
				mapView.setSettings(settings);
				localStorage.setItem("settings", JSON.stringify(settings));
			};
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Map controls"),
					c("label", {class: "dialog-row", title: "Checked = like a map (wheel zooms), unchecked = like a document (wheel scrolls Y, shift+wheel scrolls X, ctrl+wheel zooms)"},
						c("span", {class: "dialog-row-label"}, "Wheel zooms map"),
						c("span", c("input", {type: "checkbox", checked: settings.wheelZoom || null, onchange: function() {updateSetting("wheelZoom", this.checked)}}))
					),
					c("label", {class: "dialog-row", title: "Checked = zoom from/to what's under the mouse pointer, unchecked = ignore mouse pointer and zoom from/to the middle of the window"},
						c("span", {class: "dialog-row-label"}, "Zoom at mouse pointer"),
						c("span", c("input", {type: "checkbox", checked: settings.zoomAtPointer || null, onchange: function() {updateSetting("zoomAtPointer", this.checked)}}))
					),
					c("label", {class: "dialog-row", title: "Mouse button for dragging the map around"},
						c("span", {class: "dialog-row-label"}, "Map drag button"),
						c("span", c("select",
							{onchange: function() {updateSetting("dragButton", this.value ? +this.value : null)}},
							c("option", {value: ""}, "none"),
							...["left", "middle/wheel", "right", "fourth", "fifth"].map((t, idx) => c("option", {value: idx, selected: settings.dragButton==idx || null}, t))
						))
					),
					c("label", {class: "dialog-row", title: "How far the mouse needs to be moved to detect dragging instead of clicking"},
						c("span", {class: "dialog-row-label"}, "Drag threshold"),
						c("span", c("input", {type: "number", value: settings.dragThreshold, onchange: function() {if (!isNaN(+this.value)) updateSetting("dragThreshold", +this.value)}}))
					)
				)
			);
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Import/export"),
					c("label", {class: "dialog-row", title: "Click to import a snapshot, deleting existing database contents. Hint: type [] to replace with an empty database."},
						c("span", {class: "dialog-row-label"}, "Import (replacing database)"),
						c("span", c("input", {type: "button", value: "Import", onclick: handleImport}))
					),
					c("label", {class: "dialog-row", title: "Click to export the current database state as a snapshot"},
						c("span", {class: "dialog-row-label"}, "Export database"),
						c("span", c("input", {type: "button", value: "Export", onclick: handleExport}))
					)
				),
			);
			let addLayerName, addLayerColor;
			this.dialog.appendChild(
				c("div", {class: "dialog-block"},
					c("div", {class: "dialog-headline"}, "Add layer"),
					c("label", {class: "dialog-row"}, "This is a temporary workaround while there's no layer GUI. As of now, layers can only be reordered/renamed/deleted through exporting, editing and importing."),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, "Name"),
						c("span", addLayerName = c("input", {type: "text", value: ""}))
					),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, "HTML color"),
						c("span", addLayerColor = c("input", {type: "text", value: "#123456"}))
					),
					c("label", {class: "dialog-row", title: ""},
						c("span", {class: "dialog-row-label"}, ""),
						c("span", c("input", {type: "button", value: "Add layer", onclick: () => db.insert({type: "layer", name: addLayerName.value, color: addLayerColor.value, order: 0})}))
					)
				),
			);
			mapView.suspendEvents();
			suspendKeyEvents = true;
		},
		deactivate() {
			this.dialog.parentNode.removeChild(this.dialog);
			this.dialog = null;
			mapView.resumeEvents();
			suspendKeyEvents = false;
		}
	};
}