import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ensureStorageFile, loadStations, STORAGE_PATH, initTranslations } from './radioUtils.js';
import { createMetadataItem, updateMetadataDisplay, updatePlaybackStateIcon } from './modules/metadataDisplay.js';
import { createVolumeItem, onVolumeChanged } from './modules/volumeControl.js';
import { createScrollableSection, createStationMenuItem, refreshStationsMenu } from './modules/stationMenu.js';
import PlaybackManager from './modules/playbackManager.js';
import MprisInterface from './modules/mprisInterface.js';

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(stations, openPrefs, extensionPath, settings) {
            super._init(0.0, _('Yet Another Radio'));

            this._stations = stations ?? [];
            this._openPrefs = openPrefs;
            this._settings = settings;
            this._refreshIdleId = 0;

            const iconPath = `${extensionPath}/icons/yetanotherradio.svg`;
            const iconFile = Gio.File.new_for_path(iconPath);
            const icon = new Gio.FileIcon({ file: iconFile });

            this._playbackManager = new PlaybackManager(this._settings, {
                onStateChanged: (state) => this._onStateChanged(state),
                onStationChanged: (station) => this._onStationChanged(station),
                onMetadataUpdate: () => this._updateMetadataDisplay(),
                onVisibilityChanged: (visible) => this._updateVisibility(visible)
            }, icon);

            this.add_child(new St.Icon({
                gicon: icon,
                style_class: 'system-status-icon',
            }));

            this.menu.actor.add_style_class_name('yetanotherradio-menu');

            this._metadataItem = createMetadataItem(
                () => this._togglePlayback(),
                () => this._stopPlayback()
            );
            this._metadataItem.visible = false;
            this.menu.addMenuItem(this._metadataItem);

            this._volumeItem = createVolumeItem(this._settings);
            this._volumeItem._volumeSlider.connect('notify::value', () => this._onVolumeChanged());
            this._volumeItem.visible = false;
            this.menu.addMenuItem(this._volumeItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._favoritesSection = new PopupMenu.PopupMenuSection();
            this._favoritesSection.visible = false;
            this.menu.addMenuItem(this._favoritesSection);

            this._favSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._favSeparator);

            this._stationSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._stationSection);

            this._scrollableSection = createScrollableSection();
            this._scrollableSection.visible = false;
            this.menu.addMenuItem(this._scrollableSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._prefsItem = new PopupMenu.PopupMenuItem(_('Open preferences'));
            this._prefsItem.connect('activate', () => this._openPrefs?.());
            this.menu.addMenuItem(this._prefsItem);

            this._hintItem = new PopupMenu.PopupMenuItem(_('Use preferences to add stations.'));
            this._hintItem.reactive = false;
            this._hintItem.sensitive = false;
            this.menu.addMenuItem(this._hintItem);

            this._refreshStationsMenu();
        }

        _onStateChanged(state) {
            updatePlaybackStateIcon(this._metadataItem, state);
        }

        _onStationChanged(station) {
            if (this._refreshIdleId)
                return;

            this._refreshIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshIdleId = 0;

                if (!this._stationSection || !this.menu)
                    return GLib.SOURCE_REMOVE;

                this._refreshStationsMenu();
                return GLib.SOURCE_REMOVE;
            });
        }

        _updateVisibility(visible) {
            this._metadataItem.visible = visible;
            this._volumeItem.visible = visible;
        }

        _onVolumeChanged() {
            onVolumeChanged(this._volumeItem._volumeSlider, this._volumeItem._volumeIcon, this._settings);
            this._playbackManager.setVolume(this._volumeItem._volumeSlider.value);
        }

        _updateMetadataDisplay() {
            updateMetadataDisplay(
                this._settings,
                this._metadataItem,
                this._playbackManager.nowPlaying,
                this._playbackManager.currentMetadata
            );
        }

        setStations(stations) {
            this._stations = stations ?? [];
            this._refreshStationsMenu();
        }

        _refreshStationsMenu() {
            refreshStationsMenu(
                this._stations,
                this._favoritesSection,
                this._stationSection,
                this._scrollableSection,
                this._hintItem,
                (station, isNowPlaying) => this._createStationMenuItem(station, isNowPlaying),
                this._playbackManager.nowPlaying
            );

            const favorites = this._stations.filter(s => s.favorite);
            const regular = this._stations.filter(s => !s.favorite);

            if (this._stations.length <= 6) {
                if (favorites.length > 0) {
                    this._favSeparator.visible = regular.length > 0;
                } else {
                    this._favSeparator.visible = false;
                }
            } else {
                this._favSeparator.visible = false;
            }
        }

        _createStationMenuItem(station, isNowPlaying = false) {
            return createStationMenuItem(station, (s) => this._playStation(s), isNowPlaying);
        }

        _playStation(station) {
            this._playbackManager.play(station);
        }

        _togglePlayback() {
            this._playbackManager.toggle();
        }

        _stopPlayback() {
            this._playbackManager.stop();
        }

        destroy() {
            this._playbackManager.destroy();

            if (this._refreshIdleId) {
                GLib.source_remove(this._refreshIdleId);
                this._refreshIdleId = 0;
            }

            this._metadataItem = null;
            this._volumeItem = null;
            this._favoritesSection = null;
            this._stationSection = null;
            this._scrollableSection = null;
            this._prefsItem = null;
            this._hintItem = null;

            super.destroy();
        }
    });

export default class YetAnotherRadioExtension extends Extension {
    enable() {
        initTranslations(_);
        ensureStorageFile();
        this._settings = this.getSettings();
        this._indicator = new Indicator([], () => this.openPreferences(), this.path, this._settings);

        if (this._settings.get_boolean('enable-mpris')) {
            try {
                this._mpris = new MprisInterface(this._indicator._playbackManager, this._settings);
            } catch (error) {
                console.warn('Failed to initialize MPRIS interface:', error);
            }
        }

        this._mprisSettingId = 0;
        this._mprisSettingId = this._settings.connect('changed::enable-mpris', () => {
            if (this._settings.get_boolean('enable-mpris')) {
                if (!this._mpris) {
                    try {
                        this._mpris = new MprisInterface(this._indicator._playbackManager, this._settings);
                    } catch (error) {
                        console.warn('Failed to initialize MPRIS interface:', error);
                    }
                }
            } else {
                if (this._mpris) {
                    this._mpris.destroy();
                    this._mpris = null;
                }
            }
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        loadStations().then(stations => {
            if (this._indicator) {
                this._indicator.setStations(stations);
            }
        }).catch(error => {
            console.error('Failed to load stations:', error);
        });

        this._monitor = this._watchStationsFile();
    }

    _watchStationsFile() {
        const file = Gio.File.new_for_path(STORAGE_PATH);
        const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorHandlerId = monitor.connect('changed', () => {
            loadStations().then(stations => {
                this._indicator?.setStations(stations);
            }).catch(error => {
                console.error('Failed to reload stations:', error);
            });
        });
        return monitor;
    }

    disable() {
        if (this._monitor) {
            if (this._monitorHandlerId) {
                this._monitor.disconnect(this._monitorHandlerId);
                this._monitorHandlerId = null;
            }
            this._monitor.cancel();
            this._monitor = null;
        }

        if (this._mprisSettingId) {
            this._settings.disconnect(this._mprisSettingId);
            this._mprisSettingId = 0;
        }

        if (this._mpris) {
            this._mpris.destroy();
            this._mpris = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
