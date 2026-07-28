//! System tray + app lifecycle.
//!
//! Closing the Pin window HIDES it instead of quitting. The Curator lives in
//! this process — iroh endpoint, doc engine, the background loops — so closing
//! the surface must not kill the backend. The tray is how you get the window
//! back, and (along with the pin menu's Quit) the only place that actually
//! exits.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// Latched once the user asks to exit, so `handle_window_event` stops
/// swallowing close requests. Without it, a hiccup in the exit path would leave
/// a window that can never be closed.
static QUITTING: AtomicBool = AtomicBool::new(false);

const MAIN_WINDOW: &str = "main";

/// Bring the window back from the tray.
fn show_main(app: &AppHandle) {
  if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
  }
}

fn quit(app: &AppHandle) {
  QUITTING.store(true, Ordering::SeqCst);
  app.exit(0);
}

/// Exit for real. The pin menu's Quit invokes this; the tray's Quit item takes
/// the same path.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
  quit(&app);
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open Pin", true, None::<&str>)?;
  let quit_item = MenuItem::with_id(app, "quit", "Quit Pin", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&open, &quit_item])?;

  TrayIconBuilder::with_id("main")
    .icon(
      app
        .default_window_icon()
        .cloned()
        .expect("bundled window icon"),
    )
    .tooltip("Pin")
    .menu(&menu)
    // Left-click is the "give me the window back" gesture; right-click is the
    // menu. Don't pop the menu on both.
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "open" => show_main(app),
      "quit" => quit(app),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main(tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}

/// Close = hide. Wired at the builder so it covers every close path: the pin
/// menu's Close, Alt+F4, and any OS window control.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
  if let WindowEvent::CloseRequested { api, .. } = event {
    if QUITTING.load(Ordering::SeqCst) {
      return;
    }
    api.prevent_close();
    let _ = window.hide();
  }
}
