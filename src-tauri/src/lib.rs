mod channel;
mod curator;
mod docstore;
mod identity;
mod pkarr;
mod rpc;
mod sia;
mod tray;

/// A second (third, …) desktop instance on one machine, for testing anything that
/// needs two dialable peers — engagement over `/hey`, cross-instance sync, two
/// identities talking to each other. A browser tab can't stand in: it has no
/// listening socket, so it can never *receive* a knock.
///
/// One env var does the whole job because Tauri resolves the identifier at RUNTIME,
/// not at build time — `app_local_data_dir()` is `data_local_dir().join(identifier)`,
/// and the Windows webview's forced user-data dir resolves the same value. So
/// suffixing it here relocates every store this app has at once: the WebView2
/// profile (localStorage, hence the Sia AppKey, hence the identity), the Curator's
/// dir (node key, docs.redb, blobs, publish state) and the logs. Nothing downstream
/// needs to know — `curator.rs` keeps asking for `app_local_data_dir()` and lands
/// somewhere else, `curator_reset` included.
///
/// Unset means today's state, so the account already on this machine is the primary
/// instance and nothing has to migrate.
///
/// Debug-only: the identifier decides where a shipped app keeps a user's data, and a
/// stray env var must not be able to move it.
fn apply_instance_suffix(config: &mut tauri::utils::config::Config) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(raw) = std::env::var("PIN_INSTANCE") else {
        return;
    };
    // The identifier becomes a path component, so keep it to characters that are
    // one everywhere. An empty result (all punctuation, say) means no suffix.
    let name: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect();
    if name.is_empty() {
        return;
    }
    config.identifier = format!("{}.{name}", config.identifier);
    // Two windows called "Pin" are indistinguishable in the taskbar, and the tray
    // reads its tooltip off this too.
    for window in &mut config.app.windows {
        window.title = format!("{} ({name})", window.title);
    }
}

/// Our own crates, so the log filter is a WHITELIST.
///
/// A blacklist of the noisy dependencies is a list somebody has to maintain, and the cost
/// of missing an entry is the whole file: one dependency logging per packet buries every
/// line we wrote. This way a new dependency arrives quiet.
const OURS: [&str; 11] = [
    "app_lib",
    "pin_channel",
    "pin_core",
    "pin_crypto",
    "pin_curator",
    "pin_derive",
    "pin_engagement",
    "pin_manifest",
    "pin_pkarr",
    "pin_rpc",
    "pin_sia",
];

/// What level our own crates log at, from `PIN_LOG`.
///
/// Taken as an argument rather than read here so the rule is testable without touching
/// process-wide environment. A value that doesn't parse is IGNORED: a typo in a debugging
/// session must not be able to turn the log off, which is the one outcome that would be
/// indistinguishable from the app having stopped working.
fn ours_level(raw: Option<String>) -> log::LevelFilter {
    raw.and_then(|v| v.trim().parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info)
}

/// The desktop log, filtered so it can answer a question about our own loops.
///
/// It could not before: a session was hundreds of `iroh_blobs` and `iroh::socket` lines at
/// INFO — one per stored blob, one per datagram — with nothing of ours in it, because the
/// global level admitted every dependency at that level. Everything else stays at WARN,
/// which is where a dependency's genuine problem still surfaces.
///
/// `PIN_LOG` overrides the level our crates log at (`debug`, `trace`, `off`), for a session
/// that needs more than a pass report without a rebuild. An unparseable value is ignored
/// rather than silencing anything.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let ours = ours_level(std::env::var("PIN_LOG").ok());
    let mut builder = tauri_plugin_log::Builder::default().level(log::LevelFilter::Warn);
    for target in OURS {
        builder = builder.level_for(target, ours);
    }
    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    apply_instance_suffix(context.config_mut());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(curator::CuratorState::default())
        .manage(sia::SiaState::default())
        .manage(pkarr::PkarrState::default())
        .invoke_handler(tauri::generate_handler![
            curator::start_curator,
            curator::stop_curator,
            curator::curator_status,
            curator::curator_doc_ticket,
            curator::docs_namespace,
            curator::docs_put_record,
            curator::docs_get_record,
            curator::docs_delete_record,
            curator::docs_list_records,
            curator::docs_list_all,
            curator::docs_open_channel,
            curator::docs_share_channel,
            curator::docs_put_channel_record,
            curator::docs_get_channel_record,
            curator::docs_delete_channel_record,
            curator::docs_import_channel,
            curator::docs_channel_namespaces,
            curator::docs_subscribe_changes,
            curator::curator_start_pull,
            curator::curator_start_keep_alive,
            curator::curator_start_channel_docs,
            curator::curator_start_channel_sync,
            curator::curator_start_snapshot,
            curator::curator_start_repack,
            curator::curator_reset,
            curator::curator_start_instance,
            curator::curator_start_rendezvous,
            curator::curator_start_identity,
            curator::curator_start_engagement,
            curator::curator_start_deliver,
            curator::curator_deliver_probe,
            curator::curator_start_sync,
            sia::sia_connect,
            sia::sia_upload_item,
            sia::sia_upload_items_packed,
            sia::sia_download_item,
            sia::sia_pin_from_share_url,
            sia::sia_resolve_object_id,
            sia::sia_delete_object,
            sia::sia_prune_slabs,
            channel::channel_publish,
            channel::channel_resolve,
            channel::channel_republish_pointer,
            channel::channel_resolve_conversations_url,
            channel::channel_fetch_conversations,
            channel::channel_resolve_tallies_url,
            channel::channel_fetch_tallies,
            sia::sia_account_snapshot,
            sia::sia_list_pinned_objects,
            sia::sia_get_object_slabs,
            pkarr::pkarr_publish,
            pkarr::pkarr_resolve,
            tray::quit_app,
        ])
        // Closing the window hides it to the tray; the Curator keeps running.
        .on_window_event(tray::handle_window_event)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(log_plugin())?;
            }
            tray::init(app.handle())?;
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::ours_level;
    use log::LevelFilter;

    #[test]
    fn the_default_is_info() {
        assert_eq!(ours_level(None), LevelFilter::Info);
    }

    #[test]
    fn a_named_level_is_taken() {
        assert_eq!(ours_level(Some("debug".into())), LevelFilter::Debug);
        assert_eq!(ours_level(Some(" TRACE ".into())), LevelFilter::Trace);
        // Turning our own lines off is a legitimate thing to ask for; only a value that
        // means nothing is refused.
        assert_eq!(ours_level(Some("off".into())), LevelFilter::Off);
    }

    #[test]
    fn a_value_that_means_nothing_leaves_the_log_alone() {
        // The failure this prevents: a typo silencing the log, which reads exactly like
        // the loops having stopped running.
        assert_eq!(ours_level(Some("verbose".into())), LevelFilter::Info);
        assert_eq!(ours_level(Some(String::new())), LevelFilter::Info);
    }
}
