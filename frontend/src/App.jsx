// ─────────────────────────────────────────────────────────────────────────────
// App.jsx  –  Metadata Studio frontend
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useCallback, useRef } from "react";
import axios from "axios";

const API = "/api";

const ALWAYS_EDITABLE = [
  "Make", "Model", "Software", "Artist", "Copyright", "ImageDescription",
  "Orientation", "Date Modified", "Date Taken", "Date Created",
  "GPSInfo", "XPTitle", "XPComment", "XPAuthor", "XPKeywords",
];
const READONLY_PREFIXES = ["General_", "Video_", "Audio_", "Other_", "PNG_iCC"];
const DATE_FIELDS = ["Date Modified", "Date Created", "Date Taken"];

function isEditable(key) {
  if (key.startsWith("_")) return false;
  if (ALWAYS_EDITABLE.includes(key)) return true;
  if (READONLY_PREFIXES.some(p => key.startsWith(p))) return false;
  return true;
}

function canEditInPlace() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return !isMobile && !!window.showOpenFilePicker;
}

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

function Tag({ label, color = "#7dd3fc" }) {
  return (
    <span style={{ ...S.tag, color, borderColor: color + "44" }}>
      {label}
    </span>
  );
}

function ProgressBar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={S.progressWrap}>
      <div style={{ ...S.progressFill, width: `${pct}%` }} />
      <span style={S.progressLabel}>{done} / {total} ({pct}%)</span>
    </div>
  );
}

function ErrorReportModal({ failures, onClose }) {
  if (!failures || failures.length === 0) return null;
  return (
    <div style={S.modalBackdrop} onClick={onClose}>
      <div style={S.modalCard} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div style={{ fontSize: 22 }}>⚠️</div>
          <div>
            <div style={S.modalTitle}>
              {failures.length} file{failures.length !== 1 ? "s" : ""} failed to load
            </div>
            <div style={S.modalSub}>
              The rest were loaded successfully. Details below:
            </div>
          </div>
          <button style={S.modalClose} onClick={onClose}>✕</button>
        </div>
        <div style={S.modalBody}>
          {failures.map((f, i) => (
            <div key={i} style={S.failRow}>
              <div style={S.failName} title={f.filename}>{f.filename}</div>
              <div style={S.failErr}>{f.error}</div>
            </div>
          ))}
        </div>
        <div style={S.modalFooter}>
          <button style={{ ...S.btn, ...S.btnIndigo }} onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function FileCard({ file, index, onUpdateMeta, onRemoveFile, saving }) {
  const [expanded, setExpanded] = useState(false);
  const [techExpanded, setTechExpanded] = useState(false); // NEW: track tech section expansion
  const isVideo = file.type === "video";
  const meta    = file.meta;

  const dateEntries     = DATE_FIELDS.map(k => [k, meta[k] ?? ""]);
  const editableEntries = Object.entries(meta).filter(
    ([k]) => isEditable(k) && !DATE_FIELDS.includes(k) && k !== "Error"
  );
  const techEntries = Object.entries(meta).filter(
    ([k]) => !isEditable(k) && !k.startsWith("_") && k !== "Error"
  );

  // NEW: Show only first 3 tech entries unless expanded
  const visibleTechEntries = techExpanded ? techEntries : techEntries.slice(0, 3);
  const hasMoreTech = techEntries.length > 3;

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
      <div style={S.fileHeader}>
        <div style={{
          ...S.fileIconWrap,
          background: isVideo
            ? "linear-gradient(135deg,#7c3aed,#4f46e5)"
            : "linear-gradient(135deg,#0369a1,#0ea5e9)"
        }}>
          {isVideo ? "🎬" : "🖼️"}
        </div>
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
        <button style={S.removeBtn} onClick={e => { e.stopPropagation(); onRemoveFile(index); }}>✕</button>
        <div style={S.chevron} onClick={() => setExpanded(v => !v)}>
          {expanded ? "▲" : "▼"}
        </div>
      </div>
      {expanded && (
        <div style={S.cardBody}>
          {saving && <div style={S.savingOverlay}>⟳ Saving…</div>}
          {meta.Error ? (
            <div style={{ color: "#ef4444", padding: 20, textAlign: "center" }}>
              ❌ {meta.Error}
            </div>
          ) : (
            <>
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
              {techEntries.length > 0 && (
                <>
                  <div style={S.sectionLabel}>🔧 Technical / Read-Only</div>
                  <div style={{ ...S.grid, opacity: 0.5 }}>
                    {visibleTechEntries.map(([key, val]) => (
                      <div key={key} style={S.field}>
                        <label style={S.label}>{key}</label>
                        <div style={S.readonly}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {hasMoreTech && (
                    <button
                      style={S.techExpandBtn}
                      onClick={() => setTechExpanded(!techExpanded)}
                    >
                      {techExpanded
                        ? `▲ Show less (${techEntries.length - 3} hidden)`
                        : `▼ Show ${techEntries.length - 3} more technical fields`
                      }
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [savingIdx, setSavingIdx] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [progress, setProgress] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [failures, setFailures] = useState(null);

  const dropRef    = useRef(null);
  const toastTimer = useRef(null);

  const inPlace = canEditInPlace();

  function showToast(msg, type = "info", duration = 4000) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    if (duration) toastTimer.current = setTimeout(() => setToast(null), duration);
  }

  async function readFileObject(file) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("original_last_modified", file.lastModified.toString());
    const res  = await axios.post(`${API}/read`, formData);
    const meta = { ...res.data.metadata };
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
      _rawFile:           file,
      _error:             res.data.error || (meta.Error ? meta.Error : null),
    };
  }

  async function readHandle(handle, displayName) {
    const file   = await handle.getFile();
    const result = await readFileObject(file);
    return { ...result, handle, displayName: displayName || file.name };
  }

  async function loadHandles(entries) {
    if (!entries.length) return;
    setBusy(true);
    setProgress({ done: 0, total: entries.length });
    showToast(`Reading ${entries.length} file(s)…`, "info", 0);

    const loaded   = [];
    const failed   = [];
    for (let i = 0; i < entries.length; i++) {
      try {
        const result = await readHandle(entries[i].handle, entries[i].displayName);
        if (result._error) {
          failed.push({ filename: result.displayName, error: result._error });
        } else {
          loaded.push(result);
        }
      } catch (e) {
        failed.push({
          filename: entries[i].displayName,
          error: e.response?.data?.detail || e.message || "Unknown error",
        });
      }
      setProgress({ done: i + 1, total: entries.length });
    }

    setFiles(prev => [...prev, ...loaded]);
    setProgress(null);
    setBusy(false);

    if (loaded.length) {
      showToast(`✅ Added ${loaded.length} file(s)`, "success");
    }
    if (failed.length) {
      setFailures(failed);
      showToast(`⚠️ ${failed.length} file(s) failed — see details`, "error", 6000);
    } else if (!loaded.length) {
      showToast("No supported files found.", "warn");
    }
  }

  async function loadMobileFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const arr = Array.from(fileList);
    setBusy(true);
    setProgress({ done: 0, total: arr.length });
    showToast(`Reading ${arr.length} file(s)…`, "info", 0);

    const loaded = [];
    const failed = [];
    for (let i = 0; i < arr.length; i++) {
      try {
        const result = await readFileObject(arr[i]);
        if (result._error) {
          failed.push({ filename: arr[i].name, error: result._error });
        } else {
          loaded.push(result);
        }
      } catch (e) {
        failed.push({
          filename: arr[i].name,
          error: e.response?.data?.detail || e.message || "Unknown error",
        });
      }
      setProgress({ done: i + 1, total: arr.length });
    }

    setFiles(prev => [...prev, ...loaded]);
    setProgress(null);
    setBusy(false);

    if (loaded.length) {
      showToast(`✅ Added ${loaded.length} file(s)`, "success");
    }
    if (failed.length) {
      setFailures(failed);
      showToast(`⚠️ ${failed.length} file(s) failed — see details`, "error", 6000);
    } else if (!loaded.length) {
      showToast("No supported files found.", "warn");
    }
  }

  async function handleSelectFiles() {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      await loadHandles(handles.map(h => ({ handle: h, displayName: null })));
    } catch (e) {
      if (e.name !== "AbortError") showToast(`❌ ${e.message}`, "error");
    }
  }

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
      } catch { /* fallback */ }
    }
    if (entries.length) await loadHandles(entries);
  }

  const updateMeta = useCallback((index, key, value) => {
    setFiles(prev => {
      const next    = [...prev];
      next[index]   = { ...next[index], meta: { ...next[index].meta, [key]: value } };
      return next;
    });
  }, []);

  const removeFile = useCallback(index => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  async function rereadAfterSave(file, index) {
    try {
      await new Promise(r => setTimeout(r, 200));
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
    } catch { /* non-critical */ }
  }

  async function saveFile(file, index) {
    setSavingIdx(s => new Set(s).add(index));
    try {
      const formData = new FormData();
      if (inPlace && file.handle) {
        const orig = await file.handle.getFile();
        formData.append("file", orig);
        formData.append("original_last_modified", orig.lastModified.toString());
      } else {
        formData.append("file", file._rawFile);
        formData.append("original_last_modified", (file._rawFile.lastModified || Date.now()).toString());
      }
      formData.append("metadata", JSON.stringify(file.meta));
      const res = await axios.post(`${API}/save`, formData, { responseType: "blob" });
      if (inPlace && file.handle) {
        const writable = await file.handle.createWritable();
        await writable.write(res.data);
        await writable.close();
        await rereadAfterSave(file, index);
      } else {
        const url  = window.URL.createObjectURL(new Blob([res.data]));
        const link = document.createElement("a");
        link.href  = url;
        link.setAttribute("download", file.displayName || "modified_file");
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      }
      return null;
    } catch (e) {
      let msg = e.message || "Unknown error";
      if (e.response?.data) {
        try { msg = JSON.parse(await e.response.data.text()).detail || msg; } catch {}
      }
      return msg;
    } finally {
      setSavingIdx(s => { const n = new Set(s); n.delete(index); return n; });
    }
  }

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

  async function handleExportReport(format = "csv") {
    if (files.length === 0) {
      showToast("No files loaded to export.", "warn");
      return;
    }
    setBusy(true);
    showToast(`Generating ${format.toUpperCase()} report for ${files.length} file(s)…`, "info", 0);
    try {
      const formData = new FormData();
      for (const f of files) {
        const blob = inPlace && f.handle
          ? await f.handle.getFile()
          : f._rawFile;
        formData.append("files", blob, f.displayName || f.name);
      }
      formData.append("format", format);
      const res = await axios.post(`${API}/batch_read_report`, formData);
      const dl = await axios.get(`${API}/download_report/${res.data.report}`, {
        responseType: "blob",
      });
      const url  = window.URL.createObjectURL(new Blob([dl.data]));
      const link = document.createElement("a");
      link.href  = url;
      link.setAttribute("download", res.data.report);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      if (res.data.failed > 0) {
        setFailures(res.data.failures);
        showToast(
          `📄 Report saved (${res.data.ok} ok, ${res.data.failed} failed)`,
          "warn", 6000
        );
      } else {
        showToast(`📄 Report saved — ${res.data.ok} file(s)`, "success");
      }
    } catch (e) {
      showToast(`❌ Report failed: ${e.response?.data?.detail || e.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const TOAST_COLOR = { info: "#3b82f6", success: "#22c55e", error: "#ef4444", warn: "#f59e0b" };

  return (
    <div style={S.page}>
      <div style={S.bg} />
      <div style={S.container}>
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
            <div style={S.dropHint}>JPG · PNG · WEBP · MP4 · MOV · MKV · AVI · HEIC* · and more</div>
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

        {progress && <ProgressBar done={progress.done} total={progress.total} />}

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
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => handleExportReport("csv")} disabled={busy}>
                📄 Export CSV
              </button>
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => handleExportReport("txt")} disabled={busy}>
                📝 Export TXT
              </button>
              <button style={{ ...S.btn, ...S.btnDark }} onClick={() => setFiles([])} disabled={busy}>
                ✕ Clear All
              </button>
            </div>
          </div>
        )}

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

      <ErrorReportModal failures={failures} onClose={() => setFailures(null)} />
    </div>
  );
}

const S = {
  page: {
    minHeight: "100vh",
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    background: "#060610",
    color: "#e2e8f0",
    position: "relative",
    overflowX: "hidden",
  },
  bg: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    background: [
      "radial-gradient(ellipse 80% 50% at 15% 0%, #1a0a3a 0%, transparent 60%)",
      "radial-gradient(ellipse 70% 40% at 90% 100%, #001830 0%, transparent 60%)",
    ].join(", "),
  },
  container: {
    position: "relative", zIndex: 1,
    width: "100%",
    padding: "36px 48px 80px",
    boxSizing: "border-box",
  },
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
  mobileZone: {
    border: "2px solid #1e293b", borderRadius: 16,
    padding: "40px 32px 30px", textAlign: "center",
    marginBottom: 18, background: "rgba(10,6,30,0.6)",
  },
  notice: {
    padding: "12px 18px", borderRadius: 10,
    border: "1px solid", marginBottom: 16,
    fontSize: 14, fontWeight: 500, lineHeight: 1.5,
  },
  progressWrap:  { height: 6, background: "#0f172a", borderRadius: 99, marginBottom: 18, position: "relative", overflow: "visible" },
  progressFill:  { height: "100%", background: "linear-gradient(90deg,#4f46e5,#38bdf8)", borderRadius: 99, transition: "width 0.2s" },
  progressLabel: { position: "absolute", right: 0, top: 10, fontSize: 11, color: "#475569" },
  actionRow:  { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20, flexWrap: "wrap" },
  statsChip:  { fontSize: 13, color: "#475569", background: "#0a0e1a", border: "1px solid #1e293b", borderRadius: 8, padding: "7px 16px" },
  actionBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  btn:        { padding: "9px 20px", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" },
  btnGreen:   { background: "linear-gradient(135deg,#166534,#22c55e)", color: "#fff" },
  btnRed:     { background: "linear-gradient(135deg,#7f1d1d,#ef4444)", color: "#fff" },
  btnDark:    { background: "#0f172a", color: "#64748b", border: "1px solid #1e293b" },
  fileList: { display: "flex", flexDirection: "column", gap: 10 },
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
  cardBody:     { padding: "18px 20px", borderTop: "1px solid #0f172a", position: "relative" },
  savingOverlay:{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 600, color: "#7dd3fc", zIndex: 2 },
  sectionLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#334155", textTransform: "uppercase", marginBottom: 10 },
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
  badge: {
    exif:   { fontSize: 9, fontWeight: 700, color: "#818cf8", background: "rgba(129,140,248,0.12)", border: "1px solid rgba(129,140,248,0.25)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
    os:     { fontSize: 9, fontWeight: 700, color: "#22c55e", background: "rgba(34,197,94,0.1)",    border: "1px solid rgba(34,197,94,0.2)",    borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
    manual: { fontSize: 9, fontWeight: 700, color: "#f59e0b", background: "rgba(245,158,11,0.1)",   border: "1px solid rgba(245,158,11,0.2)",   borderRadius: 4, padding: "1px 5px", flexShrink: 0 },
  },
  empty:  { textAlign: "center", padding: "70px 20px" },
  footer: { marginTop: 60, textAlign: "center", color: "#1e293b", fontSize: 11, letterSpacing: "0.04em" },

  // NEW: Technical section expand button
  techExpandBtn: {
    marginTop: 12,
    padding: "8px 16px",
    background: "rgba(129,140,248,0.08)",
    border: "1px solid rgba(129,140,248,0.2)",
    borderRadius: 8,
    color: "#818cf8",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s",
  },

  modalBackdrop: {
    position: "fixed", inset: 0, zIndex: 100,
    background: "rgba(0,0,0,0.7)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, backdropFilter: "blur(6px)",
  },
  modalCard: {
    background: "#0b0d1a", border: "1px solid #1e293b",
    borderRadius: 14, maxWidth: 640, width: "100%",
    maxHeight: "80vh", display: "flex", flexDirection: "column",
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
  },
  modalHeader: {
    display: "flex", alignItems: "flex-start", gap: 14,
    padding: "18px 20px", borderBottom: "1px solid #1e293b",
  },
  modalTitle: { fontSize: 16, fontWeight: 700, color: "#f59e0b" },
  modalSub:   { fontSize: 12, color: "#64748b", marginTop: 2 },
  modalClose: {
    marginLeft: "auto", background: "none", border: "none",
    color: "#64748b", fontSize: 18, cursor: "pointer", padding: "2px 8px",
  },
  modalBody: {
    padding: "12px 20px", overflowY: "auto", flex: 1,
  },
  failRow: {
    padding: "10px 12px", borderRadius: 8,
    background: "rgba(239,68,68,0.06)",
    border: "1px solid rgba(239,68,68,0.2)",
    marginBottom: 8,
  },
  failName: {
    fontSize: 13, fontWeight: 600, color: "#e2e8f0",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },
  failErr: {
    fontSize: 12, color: "#f87171", marginTop: 4,
    fontFamily: "monospace", wordBreak: "break-word",
  },
  modalFooter: {
    padding: "14px 20px", borderTop: "1px solid #1e293b",
    display: "flex", justifyContent: "flex-end",
  },
};