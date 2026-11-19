/**
 * "Báo Cáo & Nhật Ký" tab: reports and work logs that Claude writes from chat into a Drive folder.
 * Files are Markdown (.md) or Google Docs. Name convention: "[Báo cáo] 2026-11-19 – Tiêu đề" / "[Nhật ký] …".
 * Only files directly inside the configured folder can be read (no arbitrary file IDs).
 */

function docsFolderId_() {
  var s = getSettings_();
  if (s.docsFolderId) return s.docsFolderId;
  return typeof LOCAL_DOCS_FOLDER !== 'undefined' ? LOCAL_DOCS_FOLDER : '';
}

function docKind_(name) {
  var m = String(name).match(/^\[([^\]]+)\]\s*/);
  return m ? m[1] : 'Khác';
}

function listDocs_() {
  var id = docsFolderId_();
  if (!id) return { folder: '', files: [] };
  var folder = DriveApp.getFolderById(id), it = folder.getFiles(), files = [];
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    var mt = f.getMimeType();
    if (['text/markdown', 'text/plain', 'text/x-markdown', MimeType.GOOGLE_DOCS].indexOf(mt) < 0 && !/\.md$/i.test(f.getName())) continue;
    files.push({ id: f.getId(), name: f.getName(), kind: docKind_(f.getName()), title: f.getName().replace(/^\[[^\]]+\]\s*/, '').replace(/\.md$/i, ''),
                 updated: Utilities.formatDate(f.getLastUpdated(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm'), size: f.getSize(), gdoc: mt === MimeType.GOOGLE_DOCS });
  }
  var key = function (f) { var m = f.title.match(/^(\d{4}-\d{2}-\d{2})/); return (m ? m[1] : f.updated.slice(0, 10)) + ' ' + f.updated; };
  files.sort(function (a, b) { return key(a) < key(b) ? 1 : -1; }); // newest first
  return { folder: id, url: folder.getUrl(), files: files };
}

function getDoc_(p) {
  var id = docsFolderId_(), f = DriveApp.getFileById(p.id);
  var inFolder = false, parents = f.getParents();
  while (parents.hasNext()) if (parents.next().getId() === id) inFolder = true;
  if (!inFolder) throw new Error('Tài liệu không nằm trong thư mục báo cáo của app.');
  var text;
  if (f.getMimeType() === MimeType.GOOGLE_DOCS) {
    text = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + f.getId() + '/export?mimeType=text/markdown',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }).getContentText();
  } else {
    text = f.getBlob().getDataAsString('UTF-8');
  }
  return { id: f.getId(), name: f.getName(), title: f.getName().replace(/^\[[^\]]+\]\s*/, '').replace(/\.md$/i, ''), kind: docKind_(f.getName()),
           updated: Utilities.formatDate(f.getLastUpdated(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm'), url: f.getUrl(), text: text };
}
