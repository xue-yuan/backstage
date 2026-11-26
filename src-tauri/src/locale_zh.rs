//! Traditional Chinese for the messages the Mac app shows before the page loads.
//! Keys are the English text passed to tr() in main.rs; {name} placeholders must match.

pub const ZH: &[(&str, &str)] = &[
    ("uv was not found. Install uv first (for example: brew install uv).", "找不到 uv。請先安裝 uv（例如 brew install uv）。"),
    ("Could not run {program}: {error}", "無法執行 {program}：{error}"),
    ("uv found no Python matching {request}.\nRun this in Terminal: uv python install 3.14\n\n{details}", "uv 找不到符合 {request} 的 Python。\n請在終端機執行：uv python install 3.14\n\n{details}"),
    ("127.0.0.1:{port} is already in use (maybe another Backstage is still open).\nQuit it, then open Backstage again.", "127.0.0.1:{port} 已經被其他程式使用（可能是另一個 Backstage 還開著）。\n請關掉它之後再打開 Backstage。"),
    ("Could not create the folder {path}: {error}", "無法建立資料夾 {path}：{error}"),
    ("Could not write server.log: {error}", "無法寫入 server.log：{error}"),
    ("Could not start {program}: {error}", "無法啟動 {program}：{error}"),
    ("Saved to Downloads: {name}", "已存到「下載項目」：{name}"),
    ("The local server did not start within 20 seconds.\nDetails are in {path}", "本機 server 沒有在 20 秒內啟動。\n詳細訊息在 {path}"),
    ("Could not open the page: {error}", "無法打開頁面：{error}"),
    ("Starting…", "正在啟動…"),
];
