# ─────────────────────────────────────────────────────────────────────────────
# main.py  –  Metadata Studio backend
# ─────────────────────────────────────────────────────────────────────────────
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
from PIL import Image, PngImagePlugin
from PIL.ExifTags import TAGS
import piexif
import os, shutil, subprocess, json, re, uuid, csv
from pymediainfo import MediaInfo
from datetime import datetime
from typing import List

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── HEIC / HEIF support ─────────────────────────────────────────────────────
# pillow-heif is an optional dependency. If installed, PIL can open HEIC natively.
# If not, we still accept HEIC uploads but return a clear error instead of crashing.
HEIC_SUPPORT = False
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIC_SUPPORT = True
    print("[INFO] HEIC/HEIF support enabled via pillow-heif")
except ImportError:
    print("[WARN] pillow-heif not installed — HEIC files will be rejected with a clear error. "
          "Install with:  pip install pillow-heif")

# ── File type detection ─────────────────────────────────────────────────────
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv", ".3gp"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".bmp", ".gif", ".heic", ".heif"}

def get_file_type(filename, content_type=""):
    ext = os.path.splitext(filename)[1].lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    if content_type.startswith("video/"):
        return "video"
    return "image"

# ── Helper utilities ────────────────────────────────────────────────────────
def safe_temp_path(filename, suffix=""):
    """Create a unique temporary filename so two uploads don't clash."""
    base = os.path.basename(filename).replace(" ", "_")
    ext  = os.path.splitext(base)[1] or ".bin"
    return f"tmp_{uuid.uuid4().hex}{suffix}{ext}"

def ms_to_str(ms):
    """Convert browser's file.lastModified (milliseconds) to a readable date string."""
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None

def clean_mediainfo_date(raw):
    if not raw:
        return None
    match = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})', str(raw))
    return match.group(1) if match else str(raw)

def normalize_date_for_exif(date_str):
    if not date_str:
        return None
    date_str = str(date_str).strip()
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S", "%Y/%m/%d %H:%M:%S",
                "%Y-%m-%d", "%Y:%m:%d", "%Y/%m/%d"]:
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue
    m = re.search(r'(\d{4})[-/:](\d{1,2})[-/:](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?', date_str)
    if m:
        try:
            dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0))
            return dt.strftime("%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    return None

# ── Read metadata from an image file ────────────────────────────────────────
def read_image_meta(path, original_last_modified_ms=None):
    meta = {}
    exif_dates = {}

    # HEIC guard: give a clear error instead of a cryptic PIL crash
    ext = os.path.splitext(path)[1].lower()
    if ext in {".heic", ".heif"} and not HEIC_SUPPORT:
        raise Exception(
            "HEIC/HEIF support is not installed on the server. "
            "Ask the admin to run:  pip install pillow-heif"
        )

    try:
        with Image.open(path) as img:
            fmt = img.format or "JPEG"
            if fmt in {"JPEG", "TIFF", "WEBP", "HEIF"}:
                try:
                    exif_dict = piexif.load(path)
                    for tag_id, value in exif_dict.get("0th", {}).items():
                        tag_name = TAGS.get(tag_id, f"Tag_{tag_id}")
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", errors="ignore")
                        if value:
                            meta[tag_name] = str(value)
                            if tag_id == 306:
                                exif_dates["modified"] = str(value)
                    for tag_id, value in exif_dict.get("Exif", {}).items():
                        tag_name = TAGS.get(tag_id, f"Tag_{tag_id}")
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", errors="ignore")
                        if value:
                            meta[tag_name] = str(value)
                            if tag_id == 36867:
                                exif_dates["taken"] = str(value)
                            if tag_id == 36868:
                                exif_dates["created"] = str(value)
                except Exception as e:
                    print(f"EXIF read error: {e}")
            elif fmt == "PNG":
                if hasattr(img, "text") and img.text:
                    for k, v in img.text.items():
                        meta[k] = str(v)
                        if k == "Date Taken":      exif_dates["taken"]    = str(v)
                        elif k == "Date Modified": exif_dates["modified"] = str(v)
                        elif k == "Date Created":  exif_dates["created"]  = str(v)
    except Exception as e:
        raise Exception(f"Cannot open image: {e}")

    for raw_key in ("DateTime", "DateTimeOriginal", "DateTimeDigitized"):
        meta.pop(raw_key, None)

    browser_mtime = ms_to_str(original_last_modified_ms) if original_last_modified_ms else None

    if exif_dates.get("modified"):
        meta["Date Modified"] = exif_dates["modified"]
        meta["_date_modified_source"] = "exif"
    elif browser_mtime:
        meta["Date Modified"] = browser_mtime
        meta["_date_modified_source"] = "os"
    else:
        meta["Date Modified"] = ""
        meta["_date_modified_source"] = "unknown"

    if exif_dates.get("taken"):
        meta["Date Taken"] = exif_dates["taken"]
        meta["_date_taken_source"] = "exif"
    else:
        meta["Date Taken"] = ""
        meta["_date_taken_source"] = "manual"

    if exif_dates.get("created"):
        meta["Date Created"] = exif_dates["created"]
        meta["_date_created_source"] = "exif"
    else:
        meta["Date Created"] = ""
        meta["_date_created_source"] = "manual"

    return meta

# ── Read metadata from a video file ─────────────────────────────────────────
def read_video_meta(path, original_last_modified_ms=None):
    meta = {}
    video_dates = {}
    try:
        media_info = MediaInfo.parse(path)
        for track in media_info.tracks:
            track_type = track.track_type
            for key, value in track.to_data().items():
                if value:
                    meta[f"{track_type}_{key}"] = str(value)
                    if track_type == "General":
                        if key in ("encoded_date", "tagged_date", "recorded_date",
                                   "com.apple.quicktime.creationdate"):
                            cleaned = clean_mediainfo_date(str(value))
                            if cleaned:
                                video_dates["taken"] = video_dates.get("taken") or cleaned
                        elif key in ("file_last_modification_date",
                                     "com.apple.quicktime.modificationdate"):
                            cleaned = clean_mediainfo_date(str(value))
                            if cleaned:
                                video_dates["modified"] = video_dates.get("modified") or cleaned
    except Exception as e:
        raise Exception(f"Cannot read video: {e}")

    browser_mtime = ms_to_str(original_last_modified_ms) if original_last_modified_ms else None

    if video_dates.get("modified"):
        meta["Date Modified"] = video_dates["modified"]
        meta["_date_modified_source"] = "exif"
    elif browser_mtime:
        meta["Date Modified"] = browser_mtime
        meta["_date_modified_source"] = "os"
    else:
        meta["Date Modified"] = ""
        meta["_date_modified_source"] = "unknown"

    if video_dates.get("taken"):
        meta["Date Taken"] = video_dates["taken"]
        meta["_date_taken_source"] = "exif"
    else:
        meta["Date Taken"] = ""
        meta["_date_taken_source"] = "manual"

    if video_dates.get("taken"):
        meta["Date Created"] = video_dates["taken"]
        meta["_date_created_source"] = "exif"
    else:
        meta["Date Created"] = ""
        meta["_date_created_source"] = "manual"

    return meta

# ── Write metadata into an image file ───────────────────────────────────────
def save_image_meta(path, meta):
    temp = safe_temp_path(path, suffix="_out")
    shutil.copy(path, temp)
    try:
        with Image.open(temp) as img:
            fmt = img.format or "JPEG"
        if fmt in {"JPEG", "TIFF", "WEBP"}:
            try:
                exif_dict = piexif.load(temp)
            except Exception:
                exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
            if meta.get("Date Modified"):
                n = normalize_date_for_exif(meta["Date Modified"])
                if n:
                    exif_dict["0th"][piexif.ImageIFD.DateTime] = n.encode()
            if meta.get("Date Taken"):
                n = normalize_date_for_exif(meta["Date Taken"])
                if n:
                    exif_dict["Exif"][piexif.ExifIFD.DateTimeOriginal] = n.encode()
            if meta.get("Date Created"):
                n = normalize_date_for_exif(meta["Date Created"])
                if n:
                    exif_dict["Exif"][piexif.ExifIFD.DateTimeDigitized] = n.encode()
            for key in ["Make", "Model", "Software", "Artist", "Copyright",
                        "ImageDescription", "Orientation"]:
                if meta.get(key):
                    tag_id = getattr(piexif.ImageIFD, key, None)
                    if tag_id:
                        exif_dict["0th"][tag_id] = str(meta[key]).encode()
            piexif.insert(piexif.dump(exif_dict), temp)
        elif fmt == "PNG":
            pnginfo = PngImagePlugin.PngInfo()
            for k, v in meta.items():
                if v and not k.startswith("_"):
                    pnginfo.add_text(k, str(v))
            second_temp = safe_temp_path(path, suffix="_png")
            with Image.open(temp) as img:
                img.save(second_temp, format="PNG", pnginfo=pnginfo)
            os.replace(second_temp, temp)
        return temp
    except Exception as e:
        if os.path.exists(temp):
            os.remove(temp)
        raise e

def remove_image_meta(path):
    temp = safe_temp_path(path, suffix="_clean")
    with Image.open(path) as img:
        fmt  = img.format or "JPEG"
        mode = img.mode
        if fmt in {"JPEG", "WEBP"} and mode in {"RGBA", "P", "LA"}:
            mode = "RGB"
        clean = Image.new(mode, img.size)
        clean.putdata(list(img.getdata()))
        clean.save(temp, format=fmt)
    return temp

# ── Video: write & strip via FFmpeg ─────────────────────────────────────────
def _ffmpeg():
    return "ffmpeg.exe" if os.name == "nt" else "ffmpeg"

def save_video_meta(path, meta):
    ext  = os.path.splitext(path)[1] or ".mp4"
    temp = f"tmp_{uuid.uuid4().hex}_out{ext}"
    cmd  = [_ffmpeg(), "-y", "-i", path]
    if meta.get("Date Taken"):
        cmd.extend(["-metadata", f"creation_time={str(meta['Date Taken']).strip()}"])
    if meta.get("Date Modified"):
        cmd.extend(["-metadata", f"date={str(meta['Date Modified']).strip()}"])
    if meta.get("Date Created"):
        cmd.extend(["-metadata", f"creation_time={str(meta['Date Created']).strip()}"])
    cmd.extend(["-c", "copy", temp])
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode != 0:
            raise Exception(f"FFmpeg failed: {result.stderr.decode(errors='ignore')[-500:]}")
        if not os.path.exists(temp) or os.path.getsize(temp) == 0:
            raise Exception("FFmpeg produced empty output.")
        return temp
    except subprocess.TimeoutExpired:
        raise Exception("FFmpeg timed out.")
    except FileNotFoundError:
        raise Exception("FFmpeg not installed.")
    except Exception:
        if os.path.exists(temp):
            os.remove(temp)
        raise

def remove_video_meta(path):
    ext  = os.path.splitext(path)[1] or ".mp4"
    temp = f"tmp_{uuid.uuid4().hex}_clean{ext}"
    cmd  = [_ffmpeg(), "-y", "-i", path, "-map_metadata", "-1", "-c", "copy", temp]
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode != 0:
            raise Exception(f"FFmpeg failed: {result.stderr.decode(errors='ignore')[-500:]}")
        if not os.path.exists(temp) or os.path.getsize(temp) == 0:
            raise Exception("FFmpeg produced empty output.")
        return temp
    except subprocess.TimeoutExpired:
        raise Exception("FFmpeg timed out.")
    except FileNotFoundError:
        raise Exception("FFmpeg not installed.")
    except Exception:
        if os.path.exists(temp):
            os.remove(temp)
        raise

# ── CSV / TXT report writer (for large datasets) ────────────────────────────
REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
os.makedirs(REPORT_DIR, exist_ok=True)

def write_metadata_report(results: list, fmt: str = "csv") -> str:
    """
    Write a summary report of all processed files into the reports/ folder.
    Returns the absolute path of the generated file.
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    if fmt == "csv":
        out_path = os.path.join(REPORT_DIR, f"metadata_report_{ts}.csv")
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "filename", "type", "status",
                "Date Modified", "Date Taken", "Date Created",
                "Make", "Model", "Software", "Artist", "Copyright",
                "error_message"
            ])
            for r in results:
                meta = r.get("metadata", {}) or {}
                writer.writerow([
                    r.get("filename", ""),
                    r.get("type", ""),
                    r.get("status", ""),
                    meta.get("Date Modified", ""),
                    meta.get("Date Taken", ""),
                    meta.get("Date Created", ""),
                    meta.get("Make", ""),
                    meta.get("Model", ""),
                    meta.get("Software", ""),
                    meta.get("Artist", ""),
                    meta.get("Copyright", ""),
                    r.get("error", ""),
                ])
    else:
        out_path = os.path.join(REPORT_DIR, f"metadata_report_{ts}.txt")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(f"Metadata Studio — Report generated {ts}\n")
            f.write("=" * 80 + "\n\n")
            for r in results:
                f.write(f"FILE: {r.get('filename', '')}\n")
                f.write(f"TYPE: {r.get('type', '')}   STATUS: {r.get('status', '')}\n")
                if r.get("error"):
                    f.write(f"ERROR: {r['error']}\n")
                else:
                    meta = r.get("metadata", {}) or {}
                    for k, v in meta.items():
                        if not k.startswith("_"):
                            f.write(f"  {k}: {v}\n")
                f.write("-" * 80 + "\n")
    return out_path

# ── API endpoints ───────────────────────────────────────────────────────────
@app.post("/read")
async def read_metadata(
    file: UploadFile = File(...),
    original_last_modified: str = Form(None),
):
    temp_path = safe_temp_path(file.filename)
    try:
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        ftype = get_file_type(file.filename, file.content_type)
        try:
            if ftype == "image":
                meta = read_image_meta(temp_path, original_last_modified)
            else:
                meta = read_video_meta(temp_path, original_last_modified)
            return {
                "type": ftype,
                "metadata": meta,
                "date_modified_source": meta.pop("_date_modified_source", "unknown"),
                "date_taken_source":    meta.pop("_date_taken_source",    "unknown"),
                "date_created_source":  meta.pop("_date_created_source",  "unknown"),
            }
        except Exception as e:
            # Return error INSIDE the response so the frontend can show it per-file
            return {
                "type": ftype,
                "metadata": {"Error": str(e)},
                "error": str(e),
                "date_modified_source": "unknown",
                "date_taken_source":    "unknown",
                "date_created_source":  "unknown",
            }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.post("/save")
async def save_metadata(
    file: UploadFile = File(...),
    metadata: str = Form(""),
    original_last_modified: str = Form(None),
):
    try:
        meta = json.loads(metadata) if metadata else {}
    except Exception:
        meta = {}
    for k in ["_date_created_available", "_date_modified_source",
              "_date_taken_source", "_date_created_source"]:
        meta.pop(k, None)

    temp_path = safe_temp_path(file.filename)
    modified_path = None
    try:
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        ftype = get_file_type(file.filename, file.content_type)
        if ftype == "image":
            modified_path = save_image_meta(temp_path, meta)
        else:
            modified_path = save_video_meta(temp_path, meta)
        with open(modified_path, "rb") as f:
            file_bytes = f.read()
        return Response(content=file_bytes, media_type="application/octet-stream")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        if modified_path and os.path.exists(modified_path):
            os.remove(modified_path)

@app.post("/remove")
async def remove_metadata(
    file: UploadFile = File(...),
    original_last_modified: str = Form(None),
):
    temp_path = safe_temp_path(file.filename)
    modified_path = None
    try:
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        ftype = get_file_type(file.filename, file.content_type)
        if ftype == "image":
            modified_path = remove_image_meta(temp_path)
        else:
            modified_path = remove_video_meta(temp_path)
        with open(modified_path, "rb") as f:
            file_bytes = f.read()
        return Response(content=file_bytes, media_type="application/octet-stream")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        if modified_path and os.path.exists(modified_path):
            os.remove(modified_path)

# ── NEW: Batch read + write CSV/TXT report to disk ──────────────────────────
@app.post("/batch_read_report")
async def batch_read_report(
    files: List[UploadFile] = File(...),
    format: str = Form("csv"),  # "csv" or "txt"
):
    """
    Accepts many files at once, reads metadata from each,
    writes a report to ./reports/ and returns the filename.
    Files that fail are recorded with their error message — nothing is silent.
    """
    results = []
    for f in files:
        temp_path = safe_temp_path(f.filename)
        row = {"filename": f.filename, "type": "", "status": "failed", "metadata": {}, "error": ""}
        try:
            with open(temp_path, "wb") as out:
                shutil.copyfileobj(f.file, out)
            ftype = get_file_type(f.filename, f.content_type)
            row["type"] = ftype
            try:
                if ftype == "image":
                    meta = read_image_meta(temp_path)
                else:
                    meta = read_video_meta(temp_path)
                row["status"] = "ok"
                row["metadata"] = meta
            except Exception as e:
                row["error"] = str(e)
        except Exception as e:
            row["error"] = f"IO error: {e}"
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        results.append(row)

    fmt = "txt" if format.lower() == "txt" else "csv"
    report_path = write_metadata_report(results, fmt=fmt)
    report_name = os.path.basename(report_path)
    return {
        "report": report_name,
        "total": len(results),
        "ok": sum(1 for r in results if r["status"] == "ok"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
        "failures": [
            {"filename": r["filename"], "error": r["error"]}
            for r in results if r["status"] == "failed"
        ],
    }

@app.get("/download_report/{filename}")
async def download_report(filename: str):
    safe = os.path.basename(filename)
    path = os.path.join(REPORT_DIR, safe)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Report not found")
    return FileResponse(path, filename=safe, media_type="application/octet-stream")