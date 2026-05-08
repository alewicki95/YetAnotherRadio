import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Pango from 'gi://Pango';

import { stationDisplayName } from '../radioUtils.js';

export function createStationMenuItem(station, playStationCallback, isNowPlaying = false) {
    const stationName = stationDisplayName(station);
    const item = new PopupMenu.PopupMenuItem(stationName);
    
    item.connect('activate', () => {
        playStationCallback(station);
    });

    item.label.add_style_class_name('yetanotherradio-station-label');
    if (item.label?.clutter_text) {
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.label.clutter_text.line_wrap = false;
    }

    // Force clear separation regardless of theme quirks.
    item.label.opacity = isNowPlaying ? 140 : 255;

    const iconWidget = new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        icon_size: 16,
        style_class: 'system-status-icon'
    });
    item.insert_child_at_index(iconWidget, 1);

    if (station.favicon) {
        let valid = false;
        if (station.favicon.startsWith('file://')) {
            const path = station.favicon.replace('file://', '');
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) valid = true;
        } else if (station.favicon.startsWith('/')) {
            if (GLib.file_test(station.favicon, GLib.FileTest.EXISTS)) valid = true;
        } else {
            valid = true;
        }

        if (valid) {
            try {
                const file = Gio.File.new_for_uri(station.favicon);
                const icon = new Gio.FileIcon({ file: file });
                iconWidget.gicon = icon;
                iconWidget.icon_name = null;
            } catch (e) {
                console.debug(e);
            }
        }
    }

    if (isNowPlaying) {
        item.actor.add_style_class_name('yetanotherradio-current-station');
    }

    return item;
}
