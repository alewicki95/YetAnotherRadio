import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    loadStations,
    saveStations,
    stationDisplayName,
    RadioBrowserClient,
    initTranslations,
    validateUrl,
    createStationFromRadioBrowser,
    createManualStation,
    truncateString,
} from './radioUtils.js';

initTranslations(_);

const SavedStationsPage = GObject.registerClass(
    class SavedStationsPage extends Adw.PreferencesPage {
        _init(stations, refreshCallback) {
            super._init({
                title: _('Saved Stations'),
                icon_name: 'view-list-symbolic',
            });

            this._stations = stations;
            this._refreshCallback = refreshCallback;

            this._savedGroup = new Adw.PreferencesGroup({
                title: _('Saved stations'),
                description: _('These stations appear in the panel indicator menu.'),
            });
            this.add(this._savedGroup);

            this._stationsList = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
            });
            this._savedGroup.add(this._stationsList);

            this._refreshSavedGroup();
        }

        setStations(stations) {
            this._stations = stations;
            this._refreshSavedGroup();
        }

        _refreshSavedGroup() {
            let child = this._stationsList.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                this._stationsList.remove(child);
                child = next;
            }

            if (!this._stations.length) {
                const row = new Adw.ActionRow({
                    title: _('No stations saved yet.'),
                    subtitle: _('Use the Add Stations tab to add some.'),
                });
                row.set_sensitive(false);
                this._stationsList.append(row);
                return;
            }

            this._stations.forEach((station) => {
                const displayName = stationDisplayName(station);
                const truncatedName = truncateString(displayName);
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(truncatedName, -1),
                    subtitle: GLib.markup_escape_text(truncateString(station.url || ''), -1),
                });

                const dragHandle = new Gtk.Image({
                    icon_name: 'list-drag-handle-symbolic',
                    css_classes: ['dim-label'],
                });
                row.add_prefix(dragHandle);

                const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
                dragSource.connect('prepare', (source, x, y) => {
                    const value = new GObject.Value();
                    value.init(GObject.TYPE_STRING);
                    value.set_string(station.uuid);
                    return Gdk.ContentProvider.new_for_value(value);
                });
                dragSource.connect('drag-begin', () => {
                    row.set_opacity(0.5);
                });
                dragSource.connect('drag-end', () => {
                    row.set_opacity(1.0);
                });

                row.add_controller(dragSource);

                const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
                dropTarget.connect('drop', (target, value, x, y) => {
                    return this._onDrop(value, station.uuid);
                });
                row.add_controller(dropTarget);

                const buttonBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                });

                const editButton = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    tooltip_text: _('Edit'),
                    has_frame: false,
                });
                editButton.connect('clicked', () => this._editStation(station));
                buttonBox.append(editButton);

                const favoriteButton = new Gtk.Button({
                    icon_name: station.favorite ? 'starred-symbolic' : 'non-starred-symbolic',
                    tooltip_text: station.favorite ? _('Remove from favorites') : _('Add to favorites'),
                    has_frame: false,
                });
                favoriteButton.connect('clicked', () => this._toggleFavorite(station.uuid));
                buttonBox.append(favoriteButton);

                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    has_frame: false,
                });
                removeButton.connect('clicked', () => this._removeStation(station.uuid));
                buttonBox.append(removeButton);

                row.add_suffix(buttonBox);
                row.set_activatable(false);
                row.set_sensitive(true);

                this._stationsList.append(row);
            });
        }

        _onDrop(sourceUuid, targetUuid) {
            if (sourceUuid === targetUuid) return false;

            const sourceIndex = this._stations.findIndex(s => s.uuid === sourceUuid);
            const targetIndex = this._stations.findIndex(s => s.uuid === targetUuid);

            if (sourceIndex < 0 || targetIndex < 0) return false;

            const station = this._stations[sourceIndex];
            this._stations.splice(sourceIndex, 1);
            this._stations.splice(targetIndex, 0, station);

            this._stations = saveStations(this._stations);
            this._refreshSavedGroup();
            if (this._refreshCallback) {
                this._refreshCallback(this._stations);
            }
            return true;
        }

        _removeStation(uuid) {
            const station = this._stations.find(s => s.uuid === uuid);
            if (!station)
                return;

                const dialog = new Adw.MessageDialog({
                    heading: _('Remove Station?'),
                    body: _('Are you sure you want to remove "%s"?').format(GLib.markup_escape_text(stationDisplayName(station), -1)),
                    close_response: 'cancel',
                    modal: true,
                });

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('remove', _('Remove'));
            dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);

            dialog.connect('response', (dialog, response) => {
                if (response === 'remove') {
                    this._stations = this._stations.filter(s => s.uuid !== uuid);
                    this._stations = saveStations(this._stations);
                    this._refreshSavedGroup();
                    if (this._refreshCallback) {
                        this._refreshCallback(this._stations);
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                dialog.set_transient_for(window);
            }
            dialog.present();
        }

        _editStation(station) {
            const dialog = new Adw.MessageDialog({
                heading: _('Edit Station'),
                body: _('Edit station details'),
                close_response: 'cancel',
                modal: true,
            });

            const nameEntry = new Gtk.Entry({
                text: station.name || '',
                placeholder_text: _('Station name'),
            });

            const urlEntry = new Gtk.Entry({
                text: station.url || '',
                placeholder_text: _('Stream URL'),
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 20,
                margin_bottom: 20,
            });
            box.append(nameEntry);
            box.append(urlEntry);

            dialog.set_extra_child(box);

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('save', _('Save'));
            dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

            dialog.connect('response', (dialog, response) => {
                if (response === 'save') {
                    const newName = nameEntry.text?.trim();
                    const newUrl = urlEntry.text?.trim();

                    if (!newName) {
                        return;
                    }

                    if (!newUrl) {
                        return;
                    }

                    if (!validateUrl(newUrl)) {
                        return;
                    }

                    station.name = newName;
                    station.url = newUrl;
                    this._stations = saveStations(this._stations);
                    this._refreshSavedGroup();
                    if (this._refreshCallback) {
                        this._refreshCallback(this._stations);
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                dialog.set_transient_for(window);
            }
            dialog.present();
        }

        _toggleFavorite(uuid) {
            const station = this._stations.find(s => s.uuid === uuid);
            if (station) {
                station.favorite = !station.favorite;
                this._stations = saveStations(this._stations);
                this._refreshSavedGroup();
                if (this._refreshCallback) {
                    this._refreshCallback(this._stations);
                }
            }
        }

    });

const AddStationsPage = GObject.registerClass(
    class AddStationsPage extends Adw.PreferencesPage {
        _init(stations, refreshCallback, settings) {
            super._init({
                title: _('Add Stations'),
                icon_name: 'list-add-symbolic',
            });

            this._client = new RadioBrowserClient(settings);
            this._settings = settings;
            this._stations = stations;
            this._refreshCallback = refreshCallback;
            this._searching = false;
            this._searchDebounceTimer = null;
            this._idleSourceId = null;

            this._searchGroup = new Adw.PreferencesGroup({
                title: _('Search stations'),
                description: _('Search the Radio Browser network and save stations.'),
            });
            this.add(this._searchGroup);

            this._searchRow = new Adw.EntryRow({
                title: _('Search query'),
            });

            this._searchRow.connect('entry-activated', () => {
                this._cancelSearchDebounce();
                this._performSearch();
            });

            this._idleSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                const entry = this._searchRow.get_editable();
                if (entry && entry instanceof Gtk.Entry) {
                    entry.connect('activate', () => {
                        this._cancelSearchDebounce();
                        this._performSearch();
                    });
                    entry.connect('changed', () => {
                        this._scheduleSearchDebounce();
                    });
                }
                this._idleSourceId = null;
                return false;
            });

            this._searchButton = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                tooltip_text: _('Search'),
                has_frame: false,
            });
            this._searchButton.connect('clicked', () => this._performSearch());
            this._searchRow.add_suffix(this._searchButton);

            this._loadingSpinner = new Gtk.Spinner();
            this._loadingSpinner.set_size_request(16, 16);
            this._loadingSpinner.set_visible(false);
            this._searchRow.add_suffix(this._loadingSpinner);

            this._searchGroup.add(this._searchRow);

            this._resultsGroup = new Adw.PreferencesGroup({
                title: _('Search results'),
            });
            this._resultsGroup.set_visible(false);
            this.add(this._resultsGroup);
            this._resultRows = [];
            this._resultRowMap = new Map();
            this._newlyAddedStations = new Set();

            this._manualGroup = new Adw.PreferencesGroup({
                title: _('Add station manually'),
                description: _('Enter a station name and URL to add it directly.'),
            });
            this._manualGroup.set_margin_top(24);
            this.add(this._manualGroup);

            this._manualNameRow = new Adw.EntryRow({
                title: _('Station name'),
            });
            this._manualGroup.add(this._manualNameRow);

            this._manualUrlRow = new Adw.EntryRow({
                title: _('Stream URL'),
            });
            this._manualGroup.add(this._manualUrlRow);

            this._manualAddButton = new Gtk.Button({
                label: _('Add Station'),
                css_classes: ['suggested-action'],
            });
            this._manualAddButton.connect('clicked', () => this._saveManualStation());

            const buttonBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                margin_top: 12,
                margin_bottom: 0,
            });
            buttonBox.append(this._manualAddButton);
            this._manualGroup.add(buttonBox);
        }

        setStations(stations) {
            this._stations = stations;
            this._refreshResultsState();
        }

        destroy() {
            this._cancelSearchDebounce();
            if (this._idleSourceId) {
                GLib.source_remove(this._idleSourceId);
                this._idleSourceId = null;
            }
            if (this._client) {
                this._client.destroy();
                this._client = null;
            }
        }

        _cancelSearchDebounce() {
            if (this._searchDebounceTimer) {
                GLib.source_remove(this._searchDebounceTimer);
                this._searchDebounceTimer = null;
            }
        }

        _scheduleSearchDebounce() {
            this._cancelSearchDebounce();
            this._searchDebounceTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                500,
                () => {
                    const query = this._searchRow.text?.trim();
                    if (query) {
                        this._performSearch();
                    }
                    this._searchDebounceTimer = null;
                    return false;
                }
            );
        }

        async _performSearch() {
            if (this._searching)
                return;

            const query = this._searchRow.text?.trim();
            if (!query) {
                return;
            }

            this._searching = true;
            this._searchButton.sensitive = false;
            this._loadingSpinner.start();
            this._loadingSpinner.set_visible(true);
            this._clearResultRows();
            this._resultsGroup.set_visible(true);

            try {
                const stations = await this._client.searchStations(query);
                if (!stations.length) {
                    return;
                }

                this._populateResults(stations);
            } catch (error) {
                console.error('Radio search failed', error);
            } finally {
                this._searching = false;
                this._searchButton.sensitive = true;
                this._loadingSpinner.stop();
                this._loadingSpinner.set_visible(false);
            }
        }

        _populateResults(stations) {
            this._clearResultRows();

            const searchLimit = this._settings?.get_int('search-result-limit') ?? 25;
            stations.slice(0, searchLimit).forEach(station => {
                const isAlreadySaved = this._stations.some(saved => saved.uuid === station.stationuuid);

                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(stationDisplayName(station), -1),
                    subtitle: GLib.markup_escape_text(station.url_resolved || station.url || station.homepage || '', -1),
                    activatable: !isAlreadySaved,
                });

                const saveButton = new Gtk.Button({
                    icon_name: isAlreadySaved ? 'user-trash-symbolic' : 'list-add-symbolic',
                    tooltip_text: isAlreadySaved ? _('Remove from saved stations') : _('Add to saved stations'),
                    has_frame: false,
                });

                let buttonHandlerId;
                let rowHandlerId = null;

                if (isAlreadySaved) {
                    buttonHandlerId = saveButton.connect('clicked', () => this._removeStationFromResult(station));
                } else {
                    buttonHandlerId = saveButton.connect('clicked', () => this._saveStationFromResult(station));
                    rowHandlerId = row.connect('activated', () => this._saveStationFromResult(station));
                }

                row.add_suffix(saveButton);
                row.set_sensitive(true);
                row.set_activatable(!isAlreadySaved);
                saveButton.set_sensitive(true);

                this._resultRowMap.set(station.stationuuid, {
                    row,
                    button: saveButton,
                    station,
                    buttonHandlerId,
                    rowHandlerId
                });

                this._resultsGroup.add(row);
                this._resultRows.push(row);
            });

            if (!this._resultRows.length) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No stations found.'),
                });
                emptyRow.set_sensitive(false);
                this._resultsGroup.add(emptyRow);
                this._resultRows.push(emptyRow);
            }
        }

        _clearResultRows() {
            this._resultRows.forEach(row => this._resultsGroup.remove(row));
            this._resultRows = [];
            this._resultRowMap.clear();
            this._newlyAddedStations.clear();
        }

        _saveStationFromResult(station) {
            const entry = createStationFromRadioBrowser(station);

            if (!entry.url) {
                return;
            }

            if (this._stations.some(saved => saved.uuid === entry.uuid)) {
                return;
            }

            this._stations.push(entry);
            this._stations = saveStations(this._stations);
            this._newlyAddedStations.add(entry.uuid);

            const rowData = this._resultRowMap.get(station.stationuuid);
            if (rowData) {
                const { row, button, rowHandlerId } = rowData;

                if (rowData.buttonHandlerId) {
                    button.disconnect(rowData.buttonHandlerId);
                }
                if (rowHandlerId) {
                    row.disconnect(rowHandlerId);
                    rowData.rowHandlerId = null;
                }

                button.set_icon_name('user-trash-symbolic');
                button.set_tooltip_text(_('Remove from saved stations'));
                rowData.buttonHandlerId = button.connect('clicked', () => this._removeStationFromResult(station));

                row.set_activatable(false);
                row.set_sensitive(true);
            }

            if (this._refreshCallback) {
                this._refreshCallback(this._stations);
            }
        }

        _removeStationFromResult(station) {
            const stationUuid = station.stationuuid || station.uuid;
            const savedStation = this._stations.find(saved => saved.uuid === stationUuid);

            if (!savedStation) {
                return;
            }

            const isNewlyAdded = this._newlyAddedStations.has(stationUuid);

            if (!isNewlyAdded) {
                const dialog = new Adw.MessageDialog({
                    heading: _('Remove Station?'),
                    body: _('Are you sure you want to remove "%s"?').format(GLib.markup_escape_text(stationDisplayName(savedStation), -1)),
                    close_response: 'cancel',
                    modal: true,
                });

                dialog.add_response('cancel', _('Cancel'));
                dialog.add_response('remove', _('Remove'));
                dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);

                dialog.connect('response', (dialog, response) => {
                    if (response === 'remove') {
                        this._performRemoval(stationUuid, savedStation, station);
                    }
                });

                const window = this.get_root();
                if (window && window instanceof Gtk.Window) {
                    dialog.set_transient_for(window);
                }
                dialog.present();
            } else {
                this._performRemoval(stationUuid, savedStation, station);
            }
        }

        _performRemoval(stationUuid, savedStation, station) {
            this._stations = this._stations.filter(s => s.uuid !== stationUuid);
            this._stations = saveStations(this._stations);
            this._newlyAddedStations.delete(stationUuid);

            const rowData = this._resultRowMap.get(stationUuid);
            if (rowData) {
                const { row, button, station: originalStation } = rowData;

                if (rowData.buttonHandlerId) {
                    button.disconnect(rowData.buttonHandlerId);
                }

                button.set_icon_name('list-add-symbolic');
                button.set_tooltip_text(_('Add to saved stations'));
                rowData.buttonHandlerId = button.connect('clicked', () => this._saveStationFromResult(originalStation));

                row.set_activatable(true);
                row.set_sensitive(true);

                if (!rowData.rowHandlerId) {
                    rowData.rowHandlerId = row.connect('activated', () => this._saveStationFromResult(originalStation));
                }
            }

            if (this._refreshCallback) {
                this._refreshCallback(this._stations);
            }
        }

        _refreshResultsState() {
            this._resultRowMap.forEach((rowData, stationUuid) => {
                const { row, button, station } = rowData;
                const isAlreadySaved = this._stations.some(saved => saved.uuid === stationUuid);

                if (rowData.buttonHandlerId) {
                    button.disconnect(rowData.buttonHandlerId);
                }
                if (rowData.rowHandlerId) {
                    row.disconnect(rowData.rowHandlerId);
                    rowData.rowHandlerId = null;
                }

                if (isAlreadySaved) {
                    button.set_icon_name('user-trash-symbolic');
                    button.set_tooltip_text(_('Remove from saved stations'));
                    rowData.buttonHandlerId = button.connect('clicked', () => this._removeStationFromResult(station));

                    row.set_activatable(false);
                    row.set_sensitive(true);
                } else {
                    button.set_icon_name('list-add-symbolic');
                    button.set_tooltip_text(_('Add to saved stations'));
                    rowData.buttonHandlerId = button.connect('clicked', () => this._saveStationFromResult(station));

                    row.set_activatable(true);
                    row.set_sensitive(true);

                    rowData.rowHandlerId = row.connect('activated', () => this._saveStationFromResult(station));
                }
            });
        }

        _saveManualStation() {
            const name = this._manualNameRow.text?.trim();
            const url = this._manualUrlRow.text?.trim();

            if (!name) {
                return;
            }

            if (!url) {
                return;
            }

            if (!validateUrl(url)) {
                return;
            }

            const entry = createManualStation(name, url);

            if (this._stations.some(saved => saved.url === entry.url)) {
                return;
            }

            try {
                this._stations.push(entry);
                this._stations = saveStations(this._stations);
                this._manualNameRow.text = '';
                this._manualUrlRow.text = '';
                if (this._refreshCallback) {
                    this._refreshCallback(this._stations);
                }
            } catch (error) {
                console.error('Failed to save manual station', error);
            }
        }
    });

const GeneralSettingsPage = GObject.registerClass(
    class GeneralSettingsPage extends Adw.PreferencesPage {
        _init(settings, stations, refreshCallback, window) {
            super._init({
                title: _('General'),
                icon_name: 'preferences-system-symbolic',
            });

            this._settings = settings;
            this._stations = stations;
            this._refreshCallback = refreshCallback;
            this._window = window;

            const generalGroup = new Adw.PreferencesGroup({
                title: _('General Settings'),
                description: _('Configure general extension behavior.'),
            });
            this.add(generalGroup);

            const playingNotificationRow = new Adw.ActionRow({
                title: _('Show Playing Notification'),
                subtitle: _('Show an on-screen notification when starting playback'),
            });
            playingNotificationRow.set_activatable(false);

            const playingNotificationSwitch = new Gtk.Switch({
                active: this._settings.get_boolean('show-playing-notification'),
                valign: 3,
            });
            playingNotificationSwitch.connect('notify::active', (sw) => {
                this._settings.set_boolean('show-playing-notification', sw.active);
            });
            playingNotificationRow.add_suffix(playingNotificationSwitch);
            generalGroup.add(playingNotificationRow);

            const autoPlayRow = new Adw.ActionRow({
                title: _('Auto-play Last Station'),
                subtitle: _('Automatically play the last played station when extension is enabled'),
            });
            autoPlayRow.set_activatable(false);

            const autoPlaySwitch = new Gtk.Switch({
                active: this._settings.get_boolean('auto-play-last-station'),
                valign: 3,
            });
            autoPlaySwitch.connect('notify::active', (sw) => {
                this._settings.set_boolean('auto-play-last-station', sw.active);
            });
            autoPlayRow.add_suffix(autoPlaySwitch);
            generalGroup.add(autoPlayRow);

            const mprisRow = new Adw.ActionRow({
                title: _('MPRIS Integration'),
                subtitle: _('Expose the player over D-Bus so media keys and system controls work'),
            });
            mprisRow.set_activatable(false);

            const mprisSwitch = new Gtk.Switch({
                active: this._settings.get_boolean('enable-mpris'),
                valign: 3,
            });
            mprisSwitch.connect('notify::active', (sw) => {
                this._settings.set_boolean('enable-mpris', sw.active);
            });
            mprisRow.add_suffix(mprisSwitch);
            generalGroup.add(mprisRow);

            const importExportGroup = new Adw.PreferencesGroup({
                title: _('Import / Export'),
                description: _('Backup or restore your station list.'),
            });
            this.add(importExportGroup);

            this._exportRow = new Adw.ActionRow({
                title: _('Export Stations'),
                subtitle: _('Export your saved stations to a file'),
            });
            this._exportRow.set_activatable(true);
            this._exportRow.set_sensitive(true);
            this._exportRow.connect('activated', () => this._exportStations());

            const exportIcon = new Gtk.Image({
                icon_name: 'document-save-symbolic',
                icon_size: Gtk.IconSize.NORMAL,
            });
            this._exportRow.add_suffix(exportIcon);
            importExportGroup.add(this._exportRow);

            this._importRow = new Adw.ActionRow({
                title: _('Import Stations'),
                subtitle: _('Import stations from a backup file'),
            });
            this._importRow.set_activatable(true);
            this._importRow.set_sensitive(true);
            this._importRow.connect('activated', () => this._importStations());

            const importIcon = new Gtk.Image({
                icon_name: 'document-open-symbolic',
                icon_size: Gtk.IconSize.NORMAL,
            });
            this._importRow.add_suffix(importIcon);
            importExportGroup.add(this._importRow);
        }

        setStations(stations) {
            this._stations = stations;
        }

        _showToast(title, timeout = 3) {
            if (this._window) {
                const toast = new Adw.Toast({
                    title: title,
                    timeout: timeout,
                });
                this._window.add_toast(toast);
            }
        }

        _exportStations() {
            try {
                const json = JSON.stringify(this._stations, null, 2);
                const jsonBytes = new TextEncoder().encode(json);
                const fileChooser = new Gtk.FileChooserNative({
                    title: _('Export Stations'),
                    action: Gtk.FileChooserAction.SAVE,
                    accept_label: _('Save'),
                });

                fileChooser.set_current_name('radio-stations.json');
                fileChooser.connect('response', (dialog, response) => {
                    if (response === Gtk.ResponseType.ACCEPT) {
                        const file = fileChooser.get_file();
                        if (file) {
                            try {
                                file.replace_contents(
                                    jsonBytes,
                                    null,
                                    false,
                                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                                    null
                                );
                                this._showToast(_('Stations exported successfully'));
                            } catch (error) {
                                console.error('Export failed', error);
                                this._showToast(_('Failed to export stations'));
                            }
                        }
                    }
                });

                const window = this.get_root();
                if (window && window instanceof Gtk.Window) {
                    fileChooser.set_transient_for(window);
                }
                fileChooser.show();
            } catch (error) {
                console.error('Export failed', error);
                this._showToast(_('Failed to export stations'));
            }
        }

        _importStations() {
            const fileChooser = new Gtk.FileChooserNative({
                title: _('Import Stations'),
                action: Gtk.FileChooserAction.OPEN,
                accept_label: _('Import'),
            });

            fileChooser.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = fileChooser.get_file();
                    if (file) {
                        try {
                            const [, contents] = file.load_contents(null);
                            const text = new TextDecoder().decode(contents);
                            const imported = JSON.parse(text);

                            if (!Array.isArray(imported)) {
                                this._showToast(_('Invalid file format'));
                                return;
                            }

                            const existingUuids = new Set(this._stations.map(s => s.uuid));
                            const newStations = imported.filter(s => !existingUuids.has(s.uuid));

                            if (newStations.length === 0) {
                                this._showToast(_('No new stations to import'));
                                return;
                            }

                            this._stations = [...this._stations, ...newStations];
                            this._stations = saveStations(this._stations);
                            this._showToast(_('Imported %d station(s)').format(newStations.length));
                            if (this._refreshCallback) {
                                this._refreshCallback(this._stations);
                            }
                        } catch (error) {
                            console.error('Import failed', error);
                            this._showToast(_('Failed to import stations. Invalid file format.'));
                        }
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                fileChooser.set_transient_for(window);
            }
            fileChooser.show();
        }
    });

export default class YetAnotherRadioPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 640);

        const settings = this.getSettings();

        const refreshCallback = (newStations) => {
            savedStationsPage.setStations(newStations);
            addStationsPage.setStations(newStations);
            generalSettingsPage.setStations(newStations);
        };
        
        const generalSettingsPage = new GeneralSettingsPage(settings, [], refreshCallback, window);
        const savedStationsPage = new SavedStationsPage([], refreshCallback);
        const addStationsPage = new AddStationsPage([], refreshCallback, settings);

        loadStations().then(stations => {
            refreshCallback(stations);
        }).catch(error => {
            console.error('Failed to load stations in prefs:', error);
            refreshCallback([]);
        });

        window.add(generalSettingsPage);
        window.add(savedStationsPage);
        window.add(addStationsPage);

        window.connect('close-request', () => {
            addStationsPage.destroy();
            return false;
        });
    }
}

