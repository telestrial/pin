mod curator;
mod docstore;
mod identity;
mod pkarr;
mod rpc;
mod sia;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
      sia::sia_connect,
      sia::sia_upload_item,
      sia::sia_upload_items_packed,
      sia::sia_download_item,
      sia::sia_pin_from_share_url,
      sia::sia_resolve_object_id,
      sia::sia_delete_object,
      sia::sia_prune_slabs,
      sia::sia_account_snapshot,
      sia::sia_list_pinned_objects,
      sia::sia_get_object_slabs,
      pkarr::pkarr_publish,
      pkarr::pkarr_resolve,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
