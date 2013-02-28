/* CoverflowAltTab::Switcher:
 *
 * The implementation of the switcher UI. Handles keyboard events.
 */

const Lang = imports.lang;

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Mainloop = imports.mainloop;
const AltTab = imports.ui.altTab;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const Pango = imports.gi.Pango;

const INITIAL_DELAY_TIMEOUT = 150;
const CHECK_DESTROYED_TIMEOUT = 100;

function Switcher() {
    this._init.apply(this, arguments);
}

Switcher.prototype = {
    _init: function(windows, mask, currentIndex, manager) {
        this._manager = manager;
        this._settings = manager.platform.getSettings();
        this._windows = windows;
        this._windowTitle = null;
        this._icon = null;
        this._modifierMask = null;
        this._currentIndex = currentIndex;
        this._haveModal = false;
        this._tracker = manager.platform.getWindowTracker();
        this._windowManager = global.window_manager;
        this._lastTime = 0;

        this._dcid = this._windowManager.connect('destroy', Lang.bind(this, this._windowDestroyed));
        this._mcid = this._windowManager.connect('map', Lang.bind(this, this._activateSelected));

        this._background = Meta.BackgroundActor.new_for_screen(global.screen);
        this._background.hide();
        global.overlay_group.add_actor(this._background);

        let widgetClass = manager.platform.getWidgetClass();
        this.actor = new widgetClass({ visible: true, reactive: true, });
        this.actor.hide();
        Main.uiGroup.add_actor(this.actor);

        if (!Main.pushModal(this.actor)) {
            this._activateSelected();
            return;
        }

        this._haveModal = true;
        this._modifierMask = AltTab.primaryModifier(mask);

        this.actor.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
        this.actor.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));
        this.actor.connect('scroll-event', Lang.bind(this, this._scrollEvent));

        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details) So we check now. (Have to do this after updating
        // selection.)
        let [x, y, mods] = global.get_pointer();
        if (!(mods & this._modifierMask)) {
            this._activateSelected();
            return;
        }

        this._initialDelayTimeoutId = Mainloop.timeout_add(INITIAL_DELAY_TIMEOUT, Lang.bind(this, this.show));
    },

    show: function() {
        let monitor = this.updateActiveMonitor();
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);

        // create previews
        let currentWorkspace = global.screen.get_active_workspace();
        this._previews = [];
        for (i in this._windows) {
            let metaWin = this._windows[i];
            let compositor = this._windows[i].get_compositor_private();
            if (compositor) {
                let texture = compositor.get_texture();
                let [width, height] = texture.get_size();

                let scale = 1.0;
                let previewWidth = monitor.width * this._settings.preview_scale;
                let previewHeight = monitor.height * this._settings.preview_scale;
                if (width > previewWidth || height > previewHeight)
                    scale = Math.min(previewWidth / width, previewHeight / height);

                let clone = new Clutter.Clone({
                    opacity: (!metaWin.minimized && metaWin.get_workspace() == currentWorkspace || metaWin.is_on_all_workspaces()) ? 255 : 0,
                    source: texture,
                    reactive: true,
                    anchor_gravity: Clutter.Gravity.CENTER,
                    x: ((metaWin.minimized) ? 0 : compositor.x + compositor.width / 2) - monitor.x,
                    y: ((metaWin.minimized) ? 0 : compositor.y + compositor.height / 2) - monitor.y
                });

                clone.target_width = Math.round(width * scale);
                clone.target_height = Math.round(height * scale);
                clone.target_width_side = clone.target_width * 2/3;
                clone.target_height_side = clone.target_height;

                this._previews.push(clone);
                this.actor.add_actor(clone);
            }
        }

        // hide windows and show Coverflow actors
        global.window_group.hide();
        this.actor.show();
        this._background.show();

        let panels = this.getPanels();
        panels.forEach(function(panel) { panel.actor.set_reactive(false); });

        if (this._settings.hide_panel) {
            panels.forEach(function(panel) {
                Tweener.addTween(panel.actor, {
                    opacity: 0,
                    time: this._settings.animation_time,
                    transistion: 'easeOutQuad'
                });
            }, this);
        }

        Tweener.addTween(this._background, {
            dim_factor: this._settings.dim_factor,
            time: this._settings.animation_time,
            transition: 'easeOutQuad'
        });

        this._initialDelayTimeoutId = 0;

        this._next();
    },

    _checkSwitchTime: function() {
        let t = new Date().getTime();
        if(t - this._lastTime < 150)
            return false;
        
        this._lastTime = t;
        return true;
    },

    // If next() is called on the last window, we want to
    // trigger a loop animation: calling previous() until we
    // are back on the first window and accelerate animations.
    // If there are only two windows, we don't need a loop, we
    // can do a simple previous().
    //
    // @loop: indicating whether we're currently doing a loop
    _next: function(loop) {
        if(this._windows.length <= 1) {
            this._currentIndex = 0;
            this._updateCoverflow("next");
            return;
        }
        
        this.actor.set_reactive(false);
        if (this._currentIndex == this._windows.length - 1) {
            this._currentIndex = this._currentIndex - 1;
            this._updateCoverflow("previous", (this._currentIndex != 0 && this._windows.length > 2));
        } else {
            this._currentIndex = (this._currentIndex + 1) % this._windows.length;
            this._updateCoverflow("next", (this._currentIndex == this._windows.length - 1) ? false : loop);
        }
        this.actor.set_reactive(true);
    },

    // The same here like in next(),
    // but of course the other way around
    _previous: function(loop) {
        if(this._windows.length <= 1) {
            this._currentIndex = 0;
            this._updateCoverflow("next");
            return;
        }
        
        this.actor.set_reactive(false);
        if (this._currentIndex == 0) {
            this._currentIndex = 1;
            this._updateCoverflow("next", (this._windows.length > 2));
        } else {
            this._currentIndex = this._currentIndex - 1;
            this._updateCoverflow("previous", (this._currentIndex == 0) ? false : loop);
        }
        this.actor.set_reactive(true);
    },
    
    updateActiveMonitor: function() {
        this._activeMonitor = null;
        try {
            let x, y, mask;
            [x, y, mask] = global.get_pointer();
            this._activeMonitor = Main.layoutManager._chrome._findMonitorForRect(x, y, 0, 0);
        } catch(e) {
        }
        if(!this._activeMonitor)
            this._activeMonitor = Main.layoutManager.primaryMonitor;
        
        return this._activeMonitor;
    },

    _updateCoverflow: function(direction, loop) {
        if (loop == undefined)
            loop = false;

        // on a loop, we want a faster and linear animation
        let animation_time = loop ? 0.0 : this._settings.animation_time;
        let transition_type = loop ? 'linear' : 'easeOutQuad';

        let monitor = this._activeMonitor;

        let app_icon_size;
        let label_offset;
        if (this._settings.icon_style == "Classic") {
            app_icon_size = this._settings.icon_size;
            label_offset = this._settings.icon_size + this._settings.icon_title_spacing;
        } else {
            app_icon_size = this._settings.icon_size_big;
            label_offset = 0;
        }

        // window title label
        if (this._windowTitle) {
            Tweener.addTween(this._windowTitle, {
                opacity: 0,
                time: animation_time,
                transition: transition_type,
                onComplete: Lang.bind(this.actor, this.actor.remove_actor, this._windowTitle),
            });
        }

        this._windowTitle = new St.Label({
            style_class: 'modal-dialog',
            text: this._windows[this._currentIndex].get_title(),
            opacity: 0,
            anchor_gravity: Clutter.Gravity.CENTER,
            x: Math.round((monitor.width + label_offset) / 2),
            y: Math.round(monitor.height * this._settings.title_position / 8 - this._settings.offset)
        });

        // ellipsize if title is too long
        this._windowTitle.set_style("max-width:" + (monitor.width - 200) + "px;");
        this._windowTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._windowTitle.add_style_class_name('run-dialog');
        this._windowTitle.add_style_class_name('coverflow-window-title-label');
        this.actor.add_actor(this._windowTitle);
        Tweener.addTween(this._windowTitle, {
            opacity: loop ? 0 : 255,
            time: animation_time,
            transition: transition_type,
        });

        // window icon
        if (this._applicationIconBox) {
            Tweener.addTween(this._applicationIconBox, {
                opacity: 0,
                time: animation_time,
                transition: transition_type,
                onComplete: Lang.bind(this.actor, this.actor.remove_actor, this._applicationIconBox),
            });
        }

        let app = this._tracker.get_window_app(this._windows[this._currentIndex]);
        this._icon = app ? app.create_icon_texture(app_icon_size) : null;

        if (!this._icon) {
            this._icon = new St.Icon({
                icon_name: 'applications-other',
                icon_type: St.IconType.FULLCOLOR,
                icon_size: app_icon_size
            });
        }

        if (this._settings.icon_style == "Classic") {
            this._applicationIconBox = new St.Bin({
                style_class: 'window-iconbox',
                opacity: 0,
                anchor_gravity: Clutter.Gravity.CENTER,
                x: Math.round(this._windowTitle.x - (this._windowTitle.width + app_icon_size) / 2 - this._settings.icon_title_spacing),
                y: this._windowTitle.y
            });
        } else {
            this._applicationIconBox = new St.Bin({
                style_class: 'coverflow-app-icon-box',
                width: app_icon_size * 1.15,
                height: app_icon_size * 1.15,
                opacity: 0,
                x: monitor.x + (monitor.width - app_icon_size) / 2,
                y: monitor.y + (monitor.height - app_icon_size) / 2,
            });
        }

        this._applicationIconBox.add_actor(this._icon);
        this.actor.add_actor(this._applicationIconBox);
        Tweener.addTween(this._applicationIconBox, {
            opacity: loop ? 0 : 255,
            time: animation_time,
            transition: transition_type,
        });

        this._updateCoverflowPreviews(direction, loop, animation_time, transition_type, monitor);
    },
    
    _updateCoverflowPreviews: function(direction, loop, animation_time, transition_type, monitor) {
        // preview windows
        for (let i in this._previews) {
            let preview = this._previews[i];

            if (i == this._currentIndex) {
                let rotation_vertex_x = (preview.get_anchor_point_gravity() == Clutter.Gravity.EAST) ? preview.width / 2 : -preview.width / 2;
                preview.move_anchor_point_from_gravity(Clutter.Gravity.CENTER);
                preview.rotation_center_y = new Clutter.Vertex({ x: rotation_vertex_x, y: 0.0, z: 0.0 });
                preview.raise_top();
                this._applicationIconBox.raise(preview);
                Tweener.addTween(preview, {
                    opacity: 255,
                    x: (monitor.width) / 2,
                    y: (monitor.height) / 2 - this._settings.offset,
                    width: preview.target_width,
                    height: preview.target_height,
                    rotation_angle_y: 0.0,
                    time: animation_time,
                    transition: transition_type
                });

            } else if (i < this._currentIndex) {
                preview.move_anchor_point_from_gravity(Clutter.Gravity.WEST);
                preview.rotation_center_y = new Clutter.Vertex({ x: 0.0, y: 0.0, z: 0.0 });
                preview.raise_top();
                Tweener.addTween(preview, {
                    opacity: 255,
                    x: monitor.width * 0.1 + 50 * (i - this._currentIndex),
                    y: monitor.height / 2 - this._settings.offset,
                    width: Math.max(preview.target_width_side * (10 - Math.abs(i - this._currentIndex)) / 10, 0),
                    height: Math.max(preview.target_height_side * (10 - Math.abs(i - this._currentIndex)) / 10, 0),
                    rotation_angle_y: 60.0,
                    time: animation_time,
                    transition: transition_type
                });

            } else if (i > this._currentIndex) {
                preview.move_anchor_point_from_gravity(Clutter.Gravity.EAST);
                preview.rotation_center_y = new Clutter.Vertex({ x: 0.0, y: 0.0, z: 0.0 });
                preview.lower_bottom();
                Tweener.addTween(preview, {
                    opacity: 255,
                    x: monitor.width * 0.9 + 50 * (i - this._currentIndex),
                    y: monitor.height / 2 - this._settings.offset,
                    width: Math.max(preview.target_width_side * (10 - Math.abs(i - this._currentIndex)) / 10, 0),
                    height: Math.max(preview.target_height_side * (10 - Math.abs(i - this._currentIndex)) / 10, 0),
                    rotation_angle_y: -60.0,
                    time: animation_time,
                    transition: transition_type,
                    onCompleteParams: [loop, direction, i],
                    onComplete: this._onUpdateComplete,
                    onCompleteScope: this,
                });
            }
        }
    },

    // Called by every window on the right side on animation completion,
    // because if we do a loop, we want to know when a next() or previous()
    // shift is finished
    _onUpdateComplete: function(loop, direction, index) {
        // if we don't want a loop or if this isn't the last window,
        // do nothing
        if (!loop || index != this._windows.length-1)
            return;

        // otherwise do the loop by calling next()/previous() again
        if (direction == "next")
            this._next(true);
        else
            this._previous(true);
    },

    _keyPressEvent: function(actor, event) {
        switch(event.get_key_symbol()) {
            case Clutter.Escape:
                // Esc -> close CoverFlow
                this.destroy();
                return true;

            case Clutter.q:
            case Clutter.Q:
                // Q -> Close window
                this._manager.removeSelectedWindow(this._windows[this._currentIndex]);
                this._checkDestroyedTimeoutId = Mainloop.timeout_add(CHECK_DESTROYED_TIMEOUT,
                        Lang.bind(this, this._checkDestroyed, this._windows[this._currentIndex]));
                return true;

            case Clutter.Right:
            case Clutter.Down:
                // Right/Down -> navigate to next preview
                if(this._checkSwitchTime())
                    this._next();
                return true;

            case Clutter.Left:
            case Clutter.Up:
                // Left/Up -> navigate to previous preview
                if(this._checkSwitchTime())
                    this._previous();
                return true;

            case Clutter.d:
            case Clutter.D:
                // D -> Show desktop
                this._showDesktop();
                return true;
        }

        // default alt-tab
        let event_state = event.get_state();
        let action = global.display.get_keybinding_action(event.get_key_code(), event_state);
        switch(action) {
            case Meta.KeyBindingAction.SWITCH_GROUP:
            case Meta.KeyBindingAction.SWITCH_WINDOWS:
            case Meta.KeyBindingAction.SWITCH_PANELS:
                if(this._checkSwitchTime()) {
                    // shift -> backwards
                    if(event_state & Clutter.ModifierType.SHIFT_MASK)
                        this._previous();
                    else
                        this._next();
                }
                return true;
            case Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD:
            case Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWARD:
            case Meta.KeyBindingAction.SWITCH_PANELS_BACKWARD:
                if(this._checkSwitchTime())
                    this._previous();
                return true;
        }

        return true;
    },

    _keyReleaseEvent: function(actor, event) {
        let [x, y, mods] = global.get_pointer();
        let state = mods & this._modifierMask;

        if (state == 0) {
            if (this._initialDelayTimeoutId != 0)
                this._currentIndex = (this._currentIndex + 1) % this._windows.length;
            this._activateSelected();
        }

        return true;
    },

    // allow navigating by mouse-wheel scrolling
    _scrollEvent: function(actor, event) {
        actor.set_reactive(false);
        if (event.get_scroll_direction() == Clutter.ScrollDirection.UP)
            this._next();
        else
            this._previous();
        actor.set_reactive(true);
        return true;
    },

    _windowDestroyed: function(wm, actor) {
        let window = actor.meta_window;

        for (i in this._windows) {
            if (window == this._windows[i]) {
                if (this._windows.length == 1)
                    this.destroy();
                else {
                    this._windows.splice(i, 1);
                    this._previews[i].destroy();
                    this._previews.splice(i, 1);
                    this._currentIndex = (i < this._currentIndex) ? this._currentIndex - 1 :
                    this._currentIndex % this._windows.length;
                    this._updateCoverflow();

                    return;
                }
            }
        }
    },
    
    _checkDestroyed: function(window) {
        this._checkDestroyedTimeoutId = 0;
        
        for (i in this._windows) {
            if (window == this._windows[i]) {
                if (this._windows.length == 1) {
                    this.destroy();
                } else {
                    this._windows.splice(i, 1);
                    this._previews[i].destroy();
                    this._previews.splice(i, 1);
                    this._currentIndex = (i < this._currentIndex) ? this._currentIndex - 1 : 
                        this._currentIndex % this._windows.length;
                    this._updateCoverflow();
                    return;
                }
            }
        }
    },

    _activateSelected: function() {
        this._manager.activateSelectedWindow(this._windows[this._currentIndex]);
        this.destroy();
    },

    _showDesktop: function() {
        for (i in this._windows) {
            if (!this._windows[i].minimized)
                this._windows[i].minimize();
        }
        this.destroy();
    },

    _onHideBackgroundCompleted: function() {
        global.overlay_group.remove_actor(this._background);
        Main.uiGroup.remove_actor(this.actor);

        // show all window actors
        global.window_group.show();
    },

    _onDestroy: function() {
        let monitor = this._activeMonitor;

        if (this._initialDelayTimeoutId == 0) {
            // preview windows
            let currentWorkspace = global.screen.get_active_workspace();
            for (i in this._previews) {
                let preview = this._previews[i];
                let metaWin = this._windows[i];
                let compositor = this._windows[i].get_compositor_private();

                if (i != this._currentIndex)
                    preview.lower_bottom();
                let rotation_vertex_x = 0.0;
                if (preview.get_anchor_point_gravity() == Clutter.Gravity.EAST) {
                    rotation_vertex_x = preview.width / 2;
                } else if (preview.get_anchor_point_gravity() == Clutter.Gravity.WEST) {
                    rotation_vertex_x = -preview.width / 2;
                }
				preview.move_anchor_point_from_gravity(Clutter.Gravity.CENTER);
                preview.rotation_center_y = new Clutter.Vertex({ x: rotation_vertex_x, y: 0.0, z: 0.0 });

                Tweener.addTween(preview, {
                    opacity: (!metaWin.minimized && metaWin.get_workspace() == currentWorkspace
                        || metaWin.is_on_all_workspaces()) ? 255 : 0,
                    x: ((metaWin.minimized) ? 0 : compositor.x + compositor.width / 2) - monitor.x,
                    y: ((metaWin.minimized) ? 0 : compositor.y + compositor.height / 2) - monitor.y,
                    width: (metaWin.minimized) ? 0 : compositor.width,
                    height: (metaWin.minimized) ? 0 : compositor.height,
                    rotation_angle_y: 0.0,
                    time: this._settings.animation_time,
                    transition: 'easeOutQuad',
                });
            }

            // window title and icon
            this._windowTitle.hide();
            this._applicationIconBox.hide();

            // panels
            let panels = this.getPanels();
            if (this._settings.hide_panel) {
                panels.forEach(function(panel) {
                    Tweener.removeTweens(panel.actor);
                    Tweener.addTween(panel.actor, {
                        opacity: 255,
                        time: this._settings.animation_time,
                        transistion: 'easeOutQuad'}
                    );
                }, this);
            }
            panels.forEach(function(panel) { panel.actor.set_reactive(true); });

            // background
            Tweener.removeTweens(this._background);
            Tweener.addTween(this._background, {
                dim_factor: 1.0,
                time: this._settings.animation_time,
                transition: 'easeOutQuad',
                onComplete: Lang.bind(this, this._onHideBackgroundCompleted),
            });
        }

        if (this._haveModal) {
            Main.popModal(this.actor);
            this._haveModal = false;
        }

        if (this._initialDelayTimeoutId != 0)
            Mainloop.source_remove(this._initialDelayTimeoutId);
        if (this._checkDestroyedTimeoutId != 0)
            Mainloop.source_remove(this._checkDestroyedTimeoutId);

        this._windowManager.disconnect(this._dcid);
        this._windowManager.disconnect(this._mcid);
        this._windows = null;
        this._windowTitle = null;
        this._icon = null;
        this._applicationIconBox = null;
        this._previews = null;
        this._initialDelayTimeoutId = null;
    },
    
    getPanels: function() {
        let panels = [Main.panel];
        if(Main.panel2)
            panels.push(Main.panel2);
        return panels;
    },

    destroy: function() {
        this._onDestroy();
    }
};
