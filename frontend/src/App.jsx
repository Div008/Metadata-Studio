// ─────────────────────────────────────────────────────────────────────────────
// App.jsx  –  Metadata Studio frontend
//
// What this file does 
//   • Shows a drag-and-drop zone to pick image/video files
//   • Sends each file to the local backend (main.py) to read its metadata
//   • Displays the metadata in editable fields
//   • On "Save All" → sends edited metadata back to backend → writes to disk
//   • On "Strip All" → removes all metadata from every file
//

// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef } from "react";
import axios from "axios";

// The backend URL — running locally on your machine
const API = "/api";

// Which fields are always shown in the "Editable" section
const ALWAYS_EDITABLE = [
  "Make", "Model", "Software", "Artist", "Copyright", "ImageDescription",
  "Orientation", "Date Modified", "Date Taken", "Date Created",
  "GPSInfo", "XPTitle", "XPComment", "XPAuthor", "XPKeywords",
];

// These prefixes mean the field is technical/read-only (e.g. "Video_codec")
const READONLY_PREFIXES = ["General_", "Video_", "Audio_", "Other_", "PNG_iCC"];

// The three date fields — always shown at the top, even if empty
const DATE_FIELDS = ["Date Modified", "Date Created", "Date Taken"];

// Is a metadata key editable by the user?
function isEditable(key) {
  if (key.startsWith("_")) return false; // internal flag, hide completely
  if (ALWAYS_EDITABLE.includes(key)) return true;
  if (READONLY_PREFIXES.some(p => key.startsWith(p))) return false;
  return true;
}

// Does this browser support the File System Access API (Chrome/Edge desktop)?
function canEditInPlace() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return !isMobile && !!window.showOpenFilePicker;
}

// Collect all files recursively from a dropped/selected folder
async function collectFilesFromDir(dirHandle, prefix = "") {
  const results = [];
  for await (const [name, handle] of dirHandle.entries()) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      results.push({ handle, displayName: fullPath });
    } else if (handle.kind === "directory") {
      const sub = await collectFilesFromDir(handle, fullPath);
      results.push(...sub);
    }
  }
  return results;
}

// ── Small reusable components ─────────────────────────────────────────────────

// Coloured label chip (e.g. "IMAGE", "saving…")
function Tag({ label, color = "#7dd3fc" }) {
  return (
    <span style={{ ...S.tag, color, borderColor: color + "44" }}>
      {label}
    </span>
  );
}

// Progress bar shown during batch operations
function ProgressBar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={S.progressWrap}>
      <div style={{ ...S.progressFill, width: `${pct}%` }} />
      <span style={S.progressLabel}>{done} / {total} ({pct}%)</span>
    </div>
  );
}

// ── FileCard: shows one file's metadata in an expandable card ─────────────────

function FileCard({ file, index, onUpdateMeta, onRemoveFile, saving }) {
  const [expanded, setExpanded] = useState(false);
  const isVideo = file.type === "video";
  const meta    = file.meta;

  // Split metadata into three groups
  const dateEntries     = DATE_FIELDS.map(k => [k, meta[k] ?? ""]);
  const editableEntries = Object.entries(meta).filter(
    ([k]) => isEditable(k) && !DATE_FIELDS.includes(k) && k !== "Error"
  );
  const techEntries = Object.entries(meta).filter(
    ([k]) => !isEditable(k) && !k.startsWith("_") && k !== "Error"
  );

  // Badge shown next to each date field explaining where the value came from
  function DateSourceBadge({ fieldKey }) {
    const src =
      fieldKey === "Date Modified" ? file.dateModifiedSource :
      fieldKey === "Date Taken"    ? file.dateTakenSource    :
                                     file.dateCreatedSource;

    if (src === "exif")   return <span style={S.badge.exif}   title="Read from inside the file's EXIF data">EXIF</span>;
    if (src === "os")     return <span style={S.badge.os}     title="Read from your OS filesystem">✓ OS</span>;
    return                       <span style={S.badge.manual} title="Not found — type a value to embed it">✎ manual</span>;
  }

  return (
    <div style={{ ...S.fileCard, opacity: saving ? 0.65 : 1 }}>

      {/* ── Card header (always visible) ── */}
      <div style={S.fileHeader}>
        {/* File type icon */}
        <div style={{
          ...S.fileIconWrap,
          background: isVideo
            ? "linear-gradient(135deg,#7c3aed,#4f46e5)"
            : "linear-gradient(135deg,#0369a1,#0ea5e9)"
        }}>
          {isVideo ? "🎬" : "🖼️"}
        </div>

        {/* Filename + tags — clicking expands the card */}
        <div style={{ flex: 1, minWidth: 0 }} onClick={() => setExpanded(v => !v)}>
          <div style={S.fileName} title={file.displayName}>{file.displayName}</div>
          <div style={S.fileTags}>
            <Tag label={file.type.toUpperCase()} color={isVideo ? "#a78bfa" : "#38bdf8"} />
            {meta.Error  && <Tag label="Error" color="#ef4444" />}
            {!meta.Error && <Tag label={`${editableEntries.length + DATE_FIELDS.length} editable`} />}
            {!meta.Error && <Tag label={`${techEntries.length} technical`} />}
            {saving      && <Tag label="saving…" color="#f59e0b" />}
          </div>
        </div>

        {/* Remove this file from the list */}
        <button style={S.removeBtn} onClick={e => { e.stopPropagation(); onRemoveFile(index); }}>✕</button>

        {/* Expand/collapse arrow */}
        <div style={S.chevron} onClick={() => setExpanded(v => !v)}>
          {expanded ? "▲" : "▼"}
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div style={S.cardBody}>

          {/* Saving overlay */}
          {saving && <div style={S.savingOverlay}>⟳ Saving…</div>}

          {/* Error state */}
          {meta.Error ? (
            <div style={{ color: "#ef4444", padding: 20, textAlign: "center" }}>
              ❌ {meta.Error}
            </div>
          ) : (
            <>
              {/* ── Date fields ── */}
              <div style={S.sectionLabel}>📅 Dates</div>
              <div style={{ ...S.grid, marginBottom: 20 }}>
                {dateEntries.map(([key, val]) => (
                  <div key={key} style={S.field}>
                    <label style={S.label}>
                      {key} <DateSourceBadge fieldKey={key} />
                    </label>
                    <input
                      style={S.input}
                      type="text"
                      placeholder="YYYY-MM-DD HH:MM:SS"
                      value={val}
                      onChange={e => onUpdateMeta(index, key, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              {/* ── Other editable fields (camera info, artist, etc.) ── */}
              {editableEntries.length > 0 && (
                <>
                  <div style={S.sectionLabel}>✏️ Editable Metadata</div>
                  <div style={{ ...S.grid, marginBottom: 20 }}>
                    {editableEntries.map(([key, val]) => (
                      <div key={key} style={S.field}>
                        <label style={S.label}>{key}</label>
                        <input
                          style={S.input}
                          type="text"
                          value={val || ""}
                          onChange={e => onUpdateMeta(index, key, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── Technical read-only fields (codec info, resolution, etc.) ── */}
              {techEntries.length > 0 && (
                <>
                  <div style={S.sectionLabel}>🔧 Technical / Read-Only</div>
                  <div style={{ ...S.grid, opacity: 0.5 }}>
                    {techEntries.map(([key, val]) => (
                      <div key={key} style={S.field}>
                        <label style={S.label}>{key}</label>
                        <div style={S.readonly}>{val}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App component ────────────────────────────────────────────────────────

export default function App() {
  // State: list of loaded files
  const [files, setFiles] = useState([]);

  // State: true while any batch operation is running (blocks buttons)
  const [busy, setBusy] = useState(false);

  // State: set of file indexes currently being saved individually
  const [savingIdx, setSavingIdx] = useState(new Set());

  // State: toast notification at the top { msg, type }
  const [toast, setToast] = useState(null);

  // State: progress bar { done, total }
  const [progress, setProgress] = useState(null);

  // State: is the user dragging a file over the drop zone?
  const [dragOver, setDragOver] = useState(false);

  const dropRef    = useRef(null);   // ref to the drop zone div
  const toastTimer = useRef(null);   // ref to auto-dismiss timer

  // Are we on Chrome/Edge desktop where we can edit files in-place?
  const inPlace = canEditInPlace();

  // ── Show a toast notification ──────────────────────────────────────────────
  function showToast(msg, type = "info", duration = 4000) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    if (duration) toastTimer.current = setTimeout(() => setToast(null), duration);
  }

  // ── Send one file to /read and get back its metadata ──────────────────────
  async function readFileObject(file) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("original_last_modified", file.lastModified.toString());

    const res  = await axios.post(`${API}/read`, formData);
    const meta = { ...res.data.metadata };

    // Always ensure the three date keys exist (even if empty string)
    if (!("Date Created"  in meta)) meta["Date Created"]  = "";
    if (!("Date Taken"    in meta)) meta["Date Taken"]    = "";
    if (!("Date Modified" in meta)) meta["Date Modified"] = "";

    return {
      name:               file.name || "unknown",
      displayName:        file.name || "unknown",
      lastModifiedMs:     file.lastModified,
      type:               res.data.type,
      meta,
      dateModifiedSource: res.data.date_modified_source || "unknown",
      dateTakenSource:    res.data.date_taken_source    || "unknown",
      dateCreatedSource:  res.data.date_created_source  || "unknown",
      _rawFile:           file,  // kept for mobile download mode
    };
  }

  // ── Read a FileSystemFileHandle (desktop in-place mode) ───────────────────
  async function readHandle(handle, displayName) {
    const file   = await handle.getFile();
    const result = await readFileObject(file);
    return { ...result, handle, displayName: displayName || file.name };
  }

  // ── Load a batch of FileSystemFileHandle entries ──────────────────────────
  async function loadHandles(entries) {
    if (!entries.length) return;
    setBusy(true);
    setProgress({ done: 0, total: entries.length });
    showToast(`Reading ${entries.length} file(s)…`, "info", 0);

    const loaded = [];
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
      try {
        const result = await readHandle(entries[i].handle, entries[i].displayName);
        if (result) loaded.push(result);
      } catch (e) {
        console.error(e);
        failed++;
      }
      setProgress({ done: i + 1, total: entries.length });
    }

    // Append to existing list (don't replace)
    setFiles(prev => [...prev, ...loaded]);
    setProgress(null);
    setBusy(false);
    showToast(
      loaded.length
        ? `✅ Added ${loaded.length} file(s)${failed ? ` · ${failed} failed` : ""}`
        : "No supported files found.",
      loaded.length ? "success" : "warn"
    );
  }

  // ── Load files from a plain <input type="file"> (mobile fallback) ─────────
  async function loadMobileFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const arr = Array.from(fileList);
    setBusy(true);
    setProgress({ done: 0, total: arr.length });
    showToast(`Reading ${arr.length} file(s)…`, "info", 0);

    const loaded = [];
    let failed = 0, lastError = "";

    for (let i = 0; i < arr.length; i++) {
      try {
        const result = await readFileObject(arr[i]);
        if (result.meta?.Error) { failed++; lastError = result.meta.Error; }
        else loaded.push(result);
      } catch (e) {
        failed++;
        lastError = e.message || "Unknown error";
      }
      setProgress({ done: i + 1, total: arr.length });
    }

    setFiles(prev => [...prev, ...loaded]);
    setProgress(null);
    setBusy(false);

    if (loaded.length === 0) {
      showToast(`❌ Failed: ${lastError}`, "error", 8000);
    } else {
      showToast(`✅ Added ${loaded.length} file(s)${failed ? ` · ${failed} failed` : ""}`, "success");
    }
  }

  // ── File picker button (desktop) ───────────────────────────────────────────
  async function handleSelectFiles() {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      await loadHandles(handles.map(h => ({ handle: h, displayName: null })));
    } catch (e) {
      if (e.name !== "AbortError") showToast(`❌ ${e.message}`, "error");
    }
  }

  // ── Folder picker button (desktop) ────────────────────────────────────────
  async function handleSelectFolder() {
    try {
      const dir     = await window.showDirectoryPicker({ mode: "readwrite" });
      showToast("Scanning folder…", "info", 2500);
      const entries = await collectFilesFromDir(dir, dir.name);
      if (!entries.length) { showToast("No supported files found.", "warn"); return; }
      await loadHandles(entries);
    } catch (e) {
      if (e.name !== "AbortError") showToast(`❌ ${e.message}`, "error");
    }
  }

  // ── Drag & drop handlers ───────────────────────────────────────────────────
  function handleDragOver(e)  { e.preventDefault(); e.stopPropagation(); setDragOver(true); }
  function handleDragLeave(e) { if (!dropRef.current?.contains(e.relatedTarget)) setDragOver(false); }

  async function handleDrop(e) {
    e.preventDefault(); e.stopPropagation(); setDragOver(false);
    const items   = [...e.dataTransfer.items];
    const entries = [];

    for (const item of items) {
      if (item.kind !== "file") continue;
      try {
        const h = await item.getAsFileSystemHandle();
        if (h.kind === "file") {
          entries.push({ handle: h, displayName: h.name });
        } else if (h.kind === "directory") {
          const sub = await collectFilesFromDir(h, h.name);
          entries.push(...sub);
        }
      } catch { /* browser doesn't support getAsFileSystemHandle */ }
    }
    if (entries.length) await loadHandles(entries);
  }

  // ── Update one metadata field in state ────────────────────────────────────
  const updateMeta = useCallback((index, key, value) => {
    setFiles(prev => {
      const next    = [...prev];
      next[index]   = { ...next[index], meta: { ...next[index].meta, [key]: value } };
      return next;
    });
  }, []);

  // ── Remove one file from the list ─────────────────────────────────────────
  const removeFile = useCallback(index => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ── Re-read a file from disk after saving (so UI shows fresh values) ──────
  async function rereadAfterSave(file, index) {
    try {
      await new Promise(r => setTimeout(r, 200)); // wait for OS flush
      const freshFile = await file.handle.getFile();
      const readForm  = new FormData();
      readForm.append("file", freshFile);
      readForm.append("original_last_modified", freshFile.lastModified.toString());
      const res       = await axios.post(`${API}/read`, readForm);
      const freshMeta = { ...res.data.metadata };
      if (!("Date Created"  in freshMeta)) freshMeta["Date Created"]  = "";
      if (!("Date Taken"    in freshMeta)) freshMeta["Date Taken"]    = "";
      if (!("Date Modified" in freshMeta)) freshMeta["Date Modified"] = "";

      setFiles(prev => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          meta:               freshMeta,
          lastModifiedMs:     freshFile.lastModified,
          dateModifiedSource: res.data.date_modified_source || "unknown",
          dateTakenSource:    res.data.date_taken_source    || "unknown",
          dateCreatedSource:  res.data.date_created_source  || "unknown",
        };
        return next;
      });
    } catch { /* non-critical — UI just keeps old values */ }
  }

  // ── Save one file ─────────────────────────────────────────────────────────
  async function saveFile(file, index) {
    setSavingIdx(s => new Set(s).add(index));
    try {
      const formData = new FormData();

      if (inPlace && file.handle) {
        // Desktop: get the current file bytes from the handle
        const orig = await file.handle.getFile();
        formData.append("file", orig);
        formData.append("original_last_modified", orig.lastModified.toString());
      } else {
        // Mobile: use the raw File object captured at load time
        formData.append("file", file._rawFile);
        formData.append("original_last_modified", (file._rawFile.lastModified || Date.now()).toString());
      }

      formData.append("metadata", JSON.stringify(file.meta));

      const res = await axios.post(`${API}/save`, formData, { responseType: "blob" });

      if (inPlace && file.handle) {
        // Desktop: write the modified bytes back to the original file on disk
        const writable = await file.handle.createWritable();
        await writable.write(res.data);
        await writable.close();
        // Re-read to sync the UI with what's actually on disk
        await rereadAfterSave(file, index);
      } else {
        // Mobile: trigger a download of the modified file
        const url  = window.URL.createObjectURL(new Blob([res.data]));
        const link = document.createElement("a");
        link.href  = url;
        link.setAttribute("download", file.displayName || "modified_file");
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      }

      return null; // null = success
    } catch (e) {
      let msg = e.message || "Unknown error";
      if (e.response?.data) {
        try { msg = JSON.parse(await e.response.data.text()).detail || msg; } catch {}
      }
      return msg; // return error string
    } finally {
      setSavingIdx(s => { const n = new Set(s); n.delete(index); return n; });
    }
  }

  // ── Save all files ────────────────────────────────────────────────────────
  async function handleSaveAll() {
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    showToast("Saving…", "info", 0);
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const err = await saveFile(files[i], i);
      if (err) errors.push(`${files[i].displayName}: ${err}`);
      setProgress({ done: i + 1, total: files.length });
    }

    setProgress(null);
    setBusy(false);

    if (errors.length) {
      showToast(`❌ ${errors.length} file(s) failed.`, "error");
      alert(errors.join("\n"));
    } else {
      showToast(
        inPlace ? `✅ Saved ${files.length} file(s) in-place!` : `✅ ${files.length} file(s) downloaded!`,
        "success"
      );
    }
  }

  // ── Strip metadata from all files ─────────────────────────────────────────
  async function handleStripAll() {
    if (!window.confirm(`Strip ALL metadata from ${files.length} file(s)? This cannot be undone.`)) return;
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    showToast("Stripping…", "info", 0);
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      setSavingIdx(s => new Set(s).add(i));
      try {
        const formData = new FormData();

        if (inPlace && files[i].handle) {
          const orig = await files[i].handle.getFile();
          formData.append("file", orig);
          formData.append("original_last_modified", orig.lastModified.toString());
        } else {
          formData.append("file", files[i]._rawFile);
          formData.append("original_last_modified", (files[i]._rawFile.lastModified || Date.now()).toString());
        }

        const res = await axios.post(`${API}/remove`, formData, { responseType: "blob" });

        if (inPlace && files[i].handle) {
          const writable = await files[i].handle.createWritable();
          await writable.write(res.data);
          await writable.close();
          await rereadAfterSave(files[i], i);
        } else {
          const url  = window.URL.createObjectURL(new Blob([res.data]));
          const link = document.createElement("a");
          link.href  = url;
          link.setAttribute("download", files[i].displayName || "stripped_file");
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.URL.revokeObjectURL(url);
        }
      } catch {
        errors.push(files[i].displayName);
      } finally {
        setSavingIdx(s => { const n = new Set(s); n.delete(i); return n; });
      }
      setProgress({ done: i + 1, total: files.length });
    }

    setProgress(null);
    setBusy(false);

    if (errors.length) showToast(`❌ Failed: ${errors.join(", ")}`, "error");
    else showToast(`🧹 Stripped ${files.length} file(s).`, "success");
  }

  // Toast colour map
  const TOAST_COLOR = { info: "#3b82f6", success: "#22c55e", error: "#ef4444", warn: "#f59e0b" };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      {/* Decorative background gradients */}
      <div style={S.bg} />

      {/* Main content — full width with generous padding */}
      <div style={S.container}>

        {/* ── Header ── */}
        <header style={S.header}>
          <div style={S.logo}>META</div>
          <div>
            <h1 style={S.title}>Metadata Studio</h1>
            <p style={S.subtitle}>
              {inPlace
                ? "View · Edit · Erase — directly on your files. No downloads needed."
                : "View · Edit · Erase — process files and download the results."}
            </p>
          </div>
        </header>

        {/* ── Drop zone (desktop) or file picker (mobile) ── */}
        {inPlace ? (
          <div
            ref={dropRef}
            style={{
              ...S.dropZone,
              borderColor: dragOver ? "#818cf8" : "#1e293b",
              background:  dragOver ? "rgba(129,140,248,0.09)" : "rgba(10,6,30,0.6)",
              transform:   dragOver ? "scale(1.008)" : "scale(1)",
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div style={S.dropIcon}>{dragOver ? "📂" : "⊕"}</div>
            <div style={S.dropTitle}>{dragOver ? "Drop to add files" : "Drag & drop files or folders here"}</div>
            <div style={S.dropHint}>JPG · PNG · WEBP · MP4 · MOV · MKV · AVI · and more</div>
            <div style={S.dropBtns}>
              <button style={{ ...S.dropBtn, ...S.btnIndigo }} onClick={handleSelectFiles} disabled={busy}>
                📄 Select Files
              </button>
              <button style={{ ...S.dropBtn, ...S.btnGhost }} onClick={handleSelectFolder} disabled={busy}>
                📁 Select Folder
              </button>
            </div>
          </div>
        ) : (
          /* Mobile: plain file input buttons */
          <div style={S.mobileZone}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>📱</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>Mobile Mode</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20, lineHeight: 1.5 }}>
              Select files to view and edit metadata. Modified files will be downloaded automatically.
            </div>
            <div style={S.dropBtns}>
              <label style={{ ...S.dropBtn, ...S.btnIndigo, cursor: "pointer" }}>
                📄 Select Files
                <input type="file" hidden multiple accept="image/*,video/*"
                  onChange={e => loadMobileFiles(e.target.files)} />
              </label>
              <label style={{ ...S.dropBtn, ...S.btnGhost, cursor: "pointer", color: "#818cf8" }}>
                📁 Select Folder
                <input type="file" hidden multiple accept="image/*,video/*"
                  webkitdirectory="true" directory="true"
                  onChange={e => loadMobileFiles(e.target.files)} />
              </label>
            </div>
          </div>
        )}

        {/* ── Toast notification ── */}
        {toast && (
          <div style={{
            ...S.notice,
            background:   TOAST_COLOR[toast.type] + "18",
            borderColor:  TOAST_COLOR[toast.type],
            color:        TOAST_COLOR[toast.type],
          }}>
            {toast.msg}
          </div>
        )}

        {/* ── Progress bar ── */}
        {progress && <ProgressBar done={progress.done} total={progress.total} />}

        {/* ── Stats + action buttons ── */}
        {files.length > 0 && (
          <div style={S.actionRow}>
            <div style={S.statsChip}>
              {files.length} file{files.length !== 1 ? "s" : ""} ·{" "}
              {files.filter(f => f.type === "image").length} images ·{" "}
              {files.filter(f => f.type === "video").length} videos
            </div>
            <div style={S.actionBtns}>
              <button style={{ ...S.btn, ...S.btnGreen }} onClick={handleSaveAll} disabled={busy}>
                💾 {inPlace ? "Save All" : "Save & Download All"}
              </button>
              <button style={{ ...S.btn, ...S.btnRed }} onClick={handleStripAll} disabled={busy}>
                🧹 {inPlace ? "Strip All" : "Strip & Download All"}
              </button>
              <button style={{ ...S.btn, ...S.btnDark }} onClick={() => setFiles([])} disabled={busy}>
                ✕ Clear All
              </button>
            </div>
          </div>
        )}

        {/* ── File cards ── */}
        <div style={S.fileList}>
          {files.map((file, i) => (
            <FileCard
              key={`${file.displayName}_${i}`}
              file={file}
              index={i}
              onUpdateMeta={updateMeta}
              onRemoveFile={removeFile}
              saving={savingIdx.has(i)}
            />
          ))}
        </div>

        {/* ── Empty state ── */}
        {files.length === 0 && !busy && (
          <div style={S.empty}>
            <div style={{ fontSize: 52, marginBottom: 14 }}>🗂️</div>
            <p style={{ color: "#334155", fontSize: 15 }}>Select or drop files to get started.</p>
          </div>
        )}

        <footer style={S.footer}>
          {inPlace ? "Chrome & Edge Desktop · In-place editing · No internet required" : "Mobile Mode · Process & Download · No internet required"}
        </footer>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Uses plain JS objects (React inline styles).
// No CSS files, no Tailwind — everything is here.

const S = {
  // Full-page wrapper
  page: {
    minHeight: "100vh",
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    background: "#060610",
    color: "#e2e8f0",
    position: "relative",
    overflowX: "hidden",
  },

  // Decorative background (two soft radial gradients)
  bg: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    background: [
      "radial-gradient(ellipse 80% 50% at 15% 0%, #1a0a3a 0%, transparent 60%)",
      "radial-gradient(ellipse 70% 40% at 90% 100%, #001830 0%, transparent 60%)",
    ].join(", "),
  },

  // Content wrapper — full width with max-width cap and side padding
  container: {
    position: "relative", zIndex: 1,
    width: "100%",
    padding: "36px 48px 80px",
    boxSizing: "border-box",
  },

  // Header row
  header: { display: "flex", alignItems: "center", gap: 18, marginBottom: 28 },
  logo: {
    background: "linear-gradient(135deg,#818cf8,#38bdf8)", color: "#fff",
    fontWeight: 900, fontSize: 10, letterSpacing: "0.2em",
    padding: "11px 9px", borderRadius: 9, lineHeight: 1, flexShrink: 0,
  },
  title: {
    fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: "-0.02em",
    background: "linear-gradient(90deg,#e0e7ff,#7dd3fc)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
  },
  subtitle: { margin: "4px 0 0", fontSize: 13, color: "#475569" },

  // Drop zone
  dropZone: {
    border: "2px dashed", borderRadius: 16,
    padding: "40px 32px 30px",
    textAlign: "center", marginBottom: 18,
    transition: "border-color 0.2s, background 0.2s, transform 0.15s",
    cursor: "default",
  },
  dropIcon:  { fontSize: 44, lineHeight: 1, marginBottom: 12, color: "#818cf8" },
  dropTitle: { fontSize: 18, fontWeight: 600, color: "#c7d2fe", marginBottom: 6 },
  dropHint:  { fontSize: 12, color: "#334155", letterSpacing: "0.05em", marginBottom: 20 },
  dropBtns:  { display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" },
  dropBtn:   { padding: "11px 26px", borderRadius: 9, fontWeight: 600, fontSize: 14, cursor: "pointer", border: "none" },
  btnIndigo: { background: "linear-gradient(135deg,#4f46e5,#818cf8)", color: "#fff" },
  btnGhost:  { background: "rgba(129,140,248,0.1)", color: "#818cf8", border: "1px solid #312e81" },

  // Mobile zone
  mobileZone: {
    border: "2px solid #1e293b", borderRadius: 16,
    padding: "40px 32px 30px", textAlign: "center",
    marginBottom: 18, background: "rgba(10,6,30,0.6)",
  },

  // Toast notification bar
  notice: {
    padding: "12px 18px", borderRadius: 10,
    border: "1px solid", marginBottom: 16,
    fontSize: 14, fontWeight: 500, lineHeight: 1.5,
  },

  // Progress bar
  progressWrap:  { height: 6, background: "#0f172a", borderRadius: 99, marginBottom: 18, position: "relative", overflow: "visible" },
  progressFill:  { height: "100%", background: "linear-gradient(90deg,#4f46e5,#38bdf8)", borderRadius: 99, transition: "width 0.2s" },
  progressLabel: { position: "absolute", right: 0, top: 10, fontSize: 11, color: "#475569" },

  // Action row (stats chip + buttons)
  actionRow:  { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20, flexWrap: "wrap" },
  statsChip:  { fontSize: 13, color: "#475569", background: "#0a0e1a", border: "1px solid #1e293b", borderRadius: 8, padding: "7px 16px" },
  actionBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn:        { padding: "9px 20px", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" },
  btnGreen:   { background: "linear-gradient(135deg,#166534,#22c55e)", color: "#fff" },
  btnRed:     { background: "linear-gradient(135deg,#7f1d1d,#ef4444)", color: "#fff" },
  btnDark:    { background: "#0f172a", color: "#64748b", border: "1px solid #1e293b" },

  // File list
  fileList: { display: "flex", flexDirection: "column", gap: 10 },

  // File card
  fileCard: {
    background: "rgba(8,5,20,0.85)", border: "1px solid #1e293b",
    borderRadius: 14, overflow: "hidden",
    backdropFilter: "blur(10px)", transition: "opacity 0.2s",
  },
  fileHeader:   { display: "flex", alignItems: "center", gap: 14, padding: "13px 16px", userSelect: "none", cursor: "pointer" },
  fileIconWrap: { width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 20 },
  fileName:     { fontWeight: 600, fontSize: 14, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  fileTags:     { display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" },
  tag:          { fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px", letterSpacing: "0.05em", border: "1px solid", background: "transparent" },
  removeBtn:    { background: "none", border: "none", color: "#475569", fontSize: 15, cursor: "pointer", padding: "4px 9px", borderRadius: 6, flexShrink: 0 },
  chevron:      { color: "#475569", fontSize: 12, flexShrink: 0 },

  // Card expanded body
  cardBody:     { padding: "18px 20px", borderTop: "1px solid #0f172a", position: "relative" },
  savingOverlay:{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 600, color: "#7dd3fc", zIndex: 2 },

  // Section label inside card (e.g. "📅 DATES")
  sectionLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#334155", textTransform: "uppercase", marginBottom: 10 },

  // Metadata grid — responsive columns
  grid:  { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 },
  field: { display: "flex", flexDirection: "column" },
  label: { fontSize: 11, fontWeight: 600, color: "#475569", marginBottom: 4, display: "flex", alignItems: "center", gap: 5, overflow: "hidden", whiteSpace: "nowrap" },
  input: { padding: "8px 11px", borderRadius: 7, border: "1px solid #1e293b", background: "#070b16", color: "#c7d2fe", fontSize: 13, outline: "none" },
  readonly: {
    padding: "8px 11px", borderRadius: 7,
    background: "rgba(30,41,59,0.5)", color: "#64748b",
    fontSize: 11, wordBreak: "break-all",
    border: "1px solid #1e293b", fontFamily: "monospace", lineHeight: 1.4,
  },

  // Date source badges
  badge: {
    exif:   { fontSize: 9, fontWeight: 700, color: "#818cf8", background: "rgba(129,140,248,0.12)", border: "1px solid rgba(129,140,248,0.25)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
    os:     { fontSize: 9, fontWeight: 700, color: "#22c55e", background: "rgba(34,197,94,0.1)",    border: "1px solid rgba(34,197,94,0.2)",    borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
    manual: { fontSize: 9, fontWeight: 700, color: "#f59e0b", background: "rgba(245,158,11,0.1)",   border: "1px solid rgba(245,158,11,0.2)",   borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
  },

  // Empty state
  empty:  { textAlign: "center", padding: "70px 20px" },

  // Footer
  footer: { marginTop: 60, textAlign: "center", color: "#1e293b", fontSize: 11, letterSpacing: "0.04em" },
};