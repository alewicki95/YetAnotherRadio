import Gst from 'gi://Gst';
import GstAudio from 'gi://GstAudio';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { loadStations, saveStations, stationDisplayName } from '../radioUtils.js';
import { parseMetadataTags, queryPlayerTags } from './metadataDisplay.js';

const ShellVersion = parseFloat(Config.PACKAGE_VERSION);

export default class PlaybackManager {
    constructor(settings, callbacks, osdIcon = null) {
        this._settings = settings;
        this._callbacks = callbacks || {};
        this._listeners = {};
        this._osdIcon = osdIcon;

        this._player = null;
        this._bus = null;
        this._busHandlerId = null;

        this._metadataTimer = null;
        this._playTimeTimer = null;
        this._reconnectId = null;

        this._nowPlaying = null;
        this._playbackState = 'stopped';
        this._pausedAt = null;
        this._playStartedAtMs = null;
        this._elapsedBeforePauseMs = 0;

        this._currentMetadata = {
            title: null,
            artist: null,
            albumArt: null,
            bitrate: null,
            nowPlaying: null,
            playbackState: 'stopped',
            playTimeSeconds: 0
        };
    }

    addListener(event, fn) {
        (this._listeners[event] ||= []).push(fn);
    }

    removeListener(event, fn) {
        const list = this._listeners[event];
        if (list) {
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        }
    }

    _emit(event, ...args) {
        this._callbacks[event]?.(...args);
        (this._listeners[event] || []).forEach(fn => fn(...args));
    }

    _initGst() {
        if (!Gst.is_initialized()) {
            Gst.init([]);
        }
    }

    get currentMetadata() {
        return this._currentMetadata;
    }

    get playbackState() {
        return this._playbackState;
    }

    get nowPlaying() {
        return this._nowPlaying;
    }

    getMPRISMetadata() {
        const metadata = {};

        if (this._currentMetadata.title) {
            metadata['xesam:title'] = new GLib.Variant('s', this._currentMetadata.title);
        }
        if (this._currentMetadata.artist) {
            metadata['xesam:artist'] = new GLib.Variant('as', [this._currentMetadata.artist]);
        }

        let artUrl = this._currentMetadata.albumArt || this._nowPlaying?.favicon || null;
        if (artUrl) {
            if (artUrl.startsWith('/')) {
                artUrl = 'file://' + artUrl;
            }
            metadata['mpris:artUrl'] = new GLib.Variant('s', artUrl);
        }

        return metadata;
    }

    _ensurePlayer() {
        if (this._player) return;

        this._initGst();

        this._player = Gst.ElementFactory.make('playbin3', 'radio-player');
        if (!this._player) {
            throw new Error('GStreamer playbin3 plugin missing');
        }

        const volume = (this._settings.get_int('volume') ?? 100) / 100.0;
        this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, volume);

        const fakeVideoSink = Gst.ElementFactory.make('fakesink', 'fake-video-sink');
        this._player.set_property('video-sink', fakeVideoSink);

        const audioSink = Gst.ElementFactory.make('pulsesink', 'audio-sink');
        if (audioSink) {
            audioSink.set_property('buffer-time', 1000000);
            audioSink.set_property('latency-time', 50000);
            this._player.set_property('audio-sink', audioSink);
        }

        this._player.set_property('buffer-size', 5242880);
        this._player.set_property('use-buffering', true);

        this._bus = this._player.get_bus();
        this._bus.add_signal_watch();
        this._busHandlerId = this._bus.connect('message', (b, message) => this._handleBusMessage(message));
    }

    _handleBusMessage(message) {
        if (message.type === Gst.MessageType.TAG) {
            const tagList = message.parse_tag();
            const metadata = parseMetadataTags(tagList);
            if (metadata) {
                if (metadata.title) this._currentMetadata.title = metadata.title;
                if (metadata.artist) this._currentMetadata.artist = metadata.artist;
                if (metadata.albumArt) this._currentMetadata.albumArt = metadata.albumArt;
                if (metadata.bitrate) this._currentMetadata.bitrate = metadata.bitrate;

                this._emit('onMetadataUpdate');
            }
        } else if (message.type === Gst.MessageType.ERROR) {
            const [error, debug] = message.parse_error();
            console.error(error, debug);

            let errorBody = _('Could not play the selected station.');
            let errorMessage = '';
            if (error) {
                if (error.message) errorMessage = String(error.message);
                else errorMessage = String(error);
            } else if (debug) {
                errorMessage = String(debug);
            }

            if (errorMessage) errorBody = errorMessage;

            if (errorMessage &&
                (errorMessage.includes('seeking') || errorMessage.includes('seek')) &&
                this._nowPlaying &&
                this._playbackState === 'playing') {

                console.debug('Seeking error detected, reconnecting to stream...');
                const station = this._nowPlaying;

                if (this._reconnectId) {
                    GLib.source_remove(this._reconnectId);
                }

                this._reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this.play(station);
                    this._reconnectId = null;
                    return false;
                });
            } else {
                Main.notifyError(_('Playback error'), GLib.markup_escape_text(errorBody, -1));
                this.stop();
            }

        } else if (message.type === Gst.MessageType.EOS) {
            this.stop();
        }
    }

    play(station) {
        try {
            this._ensurePlayer();

            this._currentMetadata.title = null;
            this._currentMetadata.artist = null;
            this._currentMetadata.albumArt = null;
            this._currentMetadata.bitrate = null;
            this._currentMetadata.playTimeSeconds = 0;

            this._player.set_state(Gst.State.NULL);
            this._player.set_property('uri', station.url);

            const vol = (this._settings.get_int('volume') ?? 100) / 100;
            this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, vol);

            this._player.set_state(Gst.State.PLAYING);

            this._updateStationHistory(station);

            this._nowPlaying = station;
            this._playbackState = 'playing';
            this._playStartedAtMs = Date.now();
            this._elapsedBeforePauseMs = 0;

            this._currentMetadata.nowPlaying = station;
            this._currentMetadata.playbackState = 'playing';

            this._emit('onStateChanged', 'playing');
            this._emit('onStationChanged', station);
            this._emit('onVisibilityChanged', true);

            this._startMetadataUpdate();
            this._startPlayTimeUpdate();
            
            this._showPlayingNotification(station);

        } catch (error) {
            console.error(error, 'Failed to start playback');
            const errorMsg = String(error);
            Main.notifyError(_('Playback error'), GLib.markup_escape_text(errorMsg, -1));
            this.stop();
        }
    }

    _showPlayingNotification(station) {
        if (!this._settings?.get_boolean('show-playing-notification'))
            return;

        const displayName = stationDisplayName(station);
        const escapedName = GLib.markup_escape_text(displayName, -1);
        const message = _('Playing %s').format(escapedName);

        const icon = this._osdIcon || Gio.ThemedIcon.new('media-playback-start-symbolic');

        if (Main.osdWindowManager) {
            if (ShellVersion >= 49 && Main.osdWindowManager.showAll) {
                Main.osdWindowManager.showAll(icon, message, null, null);
                return;
            }

            if (Main.osdWindowManager.show) {
                Main.osdWindowManager.show(-1, icon, message, null, null);
                return;
            }
        }

        Main.notify(message, '');
    }

    toggle() {
        if (!this._player) return;

        if (this._playbackState === 'playing') {
            this._player.set_state(Gst.State.PAUSED);
            this._playbackState = 'paused';
            this._pausedAt = Date.now();
            this._elapsedBeforePauseMs = this._getElapsedPlayMs();
            this._playStartedAtMs = null;

            this._currentMetadata.playbackState = 'paused';
            this._currentMetadata.playTimeSeconds = Math.floor(this._elapsedBeforePauseMs / 1000);
            this._emit('onStateChanged', 'paused');
            this._emit('onMetadataUpdate');

        } else if (this._playbackState === 'paused') {
            const pauseDuration = this._pausedAt ? Date.now() - this._pausedAt : 0;
            const RECONNECT_THRESHOLD = 5000;

            if (pauseDuration > RECONNECT_THRESHOLD && this._nowPlaying) {
                this.play(this._nowPlaying);
            } else {
                this._player.set_state(Gst.State.PLAYING);
                this._playbackState = 'playing';
                this._playStartedAtMs = Date.now();
                this._currentMetadata.playbackState = 'playing';

                this._emit('onStateChanged', 'playing');
                this._emit('onMetadataUpdate');
            }
            this._pausedAt = null;
        }
    }

    stop() {
        if (this._player) {
            this._player.set_state(Gst.State.NULL);
        }

        this._nowPlaying = null;
        this._playbackState = 'stopped';
        this._pausedAt = null;
        this._playStartedAtMs = null;
        this._elapsedBeforePauseMs = 0;

        this._currentMetadata.nowPlaying = null;
        this._currentMetadata.playbackState = 'stopped';
        this._currentMetadata.title = null;
        this._currentMetadata.artist = null;
        this._currentMetadata.albumArt = null;
        this._currentMetadata.bitrate = null;
        this._currentMetadata.playTimeSeconds = 0;

        this._stopMetadataUpdate();
        this._stopPlayTimeUpdate();

        this._emit('onStateChanged', 'stopped');
        this._emit('onStationChanged', null);
        this._emit('onVisibilityChanged', false);
    }

    setVolume(volume) {
        if (this._player) {
            this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, volume);
        }
    }

    _startMetadataUpdate() {
        this._stopMetadataUpdate();
        const interval = this._settings?.get_int('metadata-update-interval') ?? 2;
        this._metadataTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                queryPlayerTags(this._player, this._currentMetadata);
                this._emit('onMetadataUpdate');
                return true;
            }
        );
    }

    _stopMetadataUpdate() {
        if (this._metadataTimer) {
            GLib.source_remove(this._metadataTimer);
            this._metadataTimer = null;
        }
    }

    _getElapsedPlayMs() {
        if (this._playbackState === 'playing' && this._playStartedAtMs) {
            return this._elapsedBeforePauseMs + Math.max(0, Date.now() - this._playStartedAtMs);
        }

        return this._elapsedBeforePauseMs;
    }

    _startPlayTimeUpdate() {
        this._stopPlayTimeUpdate();
        this._playTimeTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (this._playbackState !== 'playing')
                    return true;

                this._currentMetadata.playTimeSeconds = Math.floor(this._getElapsedPlayMs() / 1000);
                this._emit('onMetadataUpdate');
                return true;
            }
        );
    }

    _stopPlayTimeUpdate() {
        if (this._playTimeTimer) {
            GLib.source_remove(this._playTimeTimer);
            this._playTimeTimer = null;
        }
    }

    _updateStationHistory(station) {
        loadStations().then(stations => {
            const stationIndex = stations.findIndex(s => s.uuid === station.uuid);
            if (stationIndex >= 0) {
                stations[stationIndex].lastPlayed = Date.now();
                saveStations(stations);
            }
        }).catch(err => {
            console.error('Failed to update station history', err);
        });
    }

    destroy() {
        this.stop();

        if (this._metadataTimer) {
            GLib.source_remove(this._metadataTimer);
            this._metadataTimer = null;
        }

        if (this._playTimeTimer) {
            GLib.source_remove(this._playTimeTimer);
            this._playTimeTimer = null;
        }

        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = null;
        }

        if (this._bus) {
            if (this._busHandlerId) {
                this._bus.disconnect(this._busHandlerId);
                this._busHandlerId = null;
            }
            this._bus.remove_signal_watch();
            this._bus = null;
        }

        if (this._player) {
            this._player = null;
        }
    }
}
