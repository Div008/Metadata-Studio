# ─────────────────────────────────────────────────────────────────────────────
# main.py  –  Metadata Studio backend
#
# What this file does (plain English):
#   1. Receives an image or video file from the browser
#   2. Reads its metadata (EXIF dates, camera info, technical details)
#   3. Can write new metadata back into the file
#   4. Can strip all metadata from the file
#   5. Sends the result back to the browser
#
# Does NOT use the internet at all — everything runs on your own computer.
# Speed depends only on your CPU and disk, NOT your internet connection.
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, PngImagePlugin
from PIL.ExifTags import TAGS
import piexif
import os, shutil, subprocess, json, re, uuid
from pymediainfo import MediaInfo
from datetime import datetime

app = FastAPI()

# Allow the browser (frontend) to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

# ── File type detection ───────────────────────────────────────────────────────

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv", ".3gp"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".bmp", ".gif", ".heic", ".heif"}

def get_file_type(filename, content_type=""):
    ext = os.path.splitext(filename)[1].lower()
    if ext in VIDEO_EXTS: return "video"
    if ext in IMAGE_EXTS: return "image"
    if content_type.startswith("video/"): return "video"
    return "image"

# ── Helper utilities ──────────────────────────────────────────────────────────

def safe_temp_path(filename, suffix=""):
    """Create a unique temporary filename so two uploads don't clash."""
    base = os.path.basename(filename).replace(" ", "_")
    ext  = os.path.splitext(base)[1] or ".bin"
    return f"tmp_{uuid.uuid4().hex}{suffix}{ext}"

def ms_to_str(ms):
    """Convert browser's file.lastModified (milliseconds) to a readable date string."""
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
    except:
        return None

def clean_mediainfo_date(raw):
    """Extract a clean YYYY-MM-DD HH:MM:SS from messy MediaInfo date strings."""
    if not raw: return None
    match = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})', str(raw))
    return match.group(1) if match else str(raw)

def normalize_date_for_exif(date_str):
    """
    EXIF requires dates in exactly this format: YYYY:MM:DD HH:MM:SS
    This function accepts many input formats and converts them.
    """
    if not date_str: return None
    date_str = str(date_str).strip()

    # Try common formats
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S", "%Y/%m/%d %H:%M:%S",
                "%Y-%m-%d", "%Y:%m:%d", "%Y/%m/%d"]:
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue

    # Fallback: extract numbers with regex
    m = re.search(r'(\d{4})[-/:](\d{1,2})[-/:](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?', date_str)
    if m:
        try:
            dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0))
            return dt.strftime("%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    return None

# ── Read metadata from an image file ─────────────────────────────────────────

def read_image_meta(path, original_last_modified_ms=None):
    """
    Opens an image and reads all its metadata.
    Returns a dictionary of field names → values.

    Date priority:
      Date Modified → from EXIF, else from browser's file.lastModified
      Date Taken    → from EXIF only (this is when the camera shutter clicked)
      Date Created  → from EXIF only (DateTimeDigitized)
    """
    meta = {}
    exif_dates = {}  # will hold date values found inside the file's EXIF

    try:
        with Image.open(path) as img:
            fmt = img.format or "JPEG"

            if fmt in {"JPEG", "TIFF", "WEBP"}:
                # Read EXIF data using piexif (more reliable than PIL's built-in)
                try:
                    exif_dict = piexif.load(path)

                    # IFD0 (main image info) — camera make, model, date modified, etc.
                    for tag_id, value in exif_dict.get("0th", {}).items():
                        tag_name = TAGS.get(tag_id, f"Tag_{tag_id}")
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", errors="ignore")
                        if value:
                            meta[tag_name] = str(value)
                            if tag_id == 306:   # DateTime = Date Modified
                                exif_dates["modified"] = str(value)

                    # Exif IFD — date taken, date digitized (created), etc.
                    for tag_id, value in exif_dict.get("Exif", {}).items():
                        tag_name = TAGS.get(tag_id, f"Tag_{tag_id}")
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", errors="ignore")
                        if value:
                            meta[tag_name] = str(value)
                            if tag_id == 36867: # DateTimeOriginal = Date Taken
                                exif_dates["taken"] = str(value)
                            if tag_id == 36868: # DateTimeDigitized = Date Created
                                exif_dates["created"] = str(value)
                except Exception as e:
                    print(f"EXIF read error: {e}")

            elif fmt == "PNG":
                # PNG stores metadata as text chunks instead of EXIF
                if hasattr(img, "text") and img.text:
                    for k, v in img.text.items():
                        meta[k] = str(v)
                        if k == "Date Taken":    exif_dates["taken"]    = str(v)
                        elif k == "Date Modified": exif_dates["modified"] = str(v)
                        elif k == "Date Created":  exif_dates["created"]  = str(v)

    except Exception as e:
        raise Exception(f"Cannot open image: {e}")

    # Remove the raw EXIF key names — we expose them under friendly names below
    for raw_key in ("DateTime", "DateTimeOriginal", "DateTimeDigitized"):
        meta.pop(raw_key, None)

    # The browser sends file.lastModified — this is the real OS modified time
    browser_mtime = ms_to_str(original_last_modified_ms) if original_last_modified_ms else None

    # ── Set the three date fields with source tracking ──
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

    # Date Created: only from EXIF — never fake it with OS time
    if exif_dates.get("created"):
        meta["Date Created"] = exif_dates["created"]
        meta["_date_created_source"] = "exif"
    else:
        meta["Date Created"] = ""
        meta["_date_created_source"] = "manual"

    return meta

# ── Read metadata from a video file ──────────────────────────────────────────

def read_video_meta(path, original_last_modified_ms=None):
    """
    Uses MediaInfo (a free library) to read video metadata.
    Returns a dictionary of field names → values.
    """
    meta = {}
    video_dates = {}

    try:
        media_info = MediaInfo.parse(path)
        for track in media_info.tracks:
            track_type = track.track_type  # "General", "Video", "Audio", etc.
            for key, value in track.to_data().items():
                if value:
                    meta[f"{track_type}_{key}"] = str(value)
                    # Pull out date fields from the General track
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

    # For video, use taken date as created if available, else leave empty
    if video_dates.get("taken"):
        meta["Date Created"] = video_dates["taken"]
        meta["_date_created_source"] = "exif"
    else:
        meta["Date Created"] = ""
        meta["_date_created_source"] = "manual"

    return meta

# ── Write metadata into an image file ────────────────────────────────────────

def save_image_meta(path, meta):
    """
    Takes the image at `path`, inserts the new metadata from `meta`,
    and returns the path to the modified temp file.
    """
    temp = safe_temp_path(path, suffix="_out")
    shutil.copy(path, temp)  # work on a copy so the original is safe

    try:
        with Image.open(temp) as img:
            fmt = img.format or "JPEG"

        if fmt in {"JPEG", "TIFF", "WEBP"}:
            try:
                exif_dict = piexif.load(temp)
            except:
                exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}

            # Write the three date fields into their correct EXIF slots
            if meta.get("Date Modified"):
                n = normalize_date_for_exif(meta["Date Modified"])
                if n: exif_dict["0th"][piexif.ImageIFD.DateTime] = n.encode()

            if meta.get("Date Taken"):
                n = normalize_date_for_exif(meta["Date Taken"])
                if n: exif_dict["Exif"][piexif.ExifIFD.DateTimeOriginal] = n.encode()

            if meta.get("Date Created"):
                n = normalize_date_for_exif(meta["Date Created"])
                if n: exif_dict["Exif"][piexif.ExifIFD.DateTimeDigitized] = n.encode()

            # Write other common fields
            for key in ["Make", "Model", "Software", "Artist", "Copyright",
                        "ImageDescription", "Orientation"]:
                if meta.get(key):
                    tag_id = getattr(piexif.ImageIFD, key, None)
                    if tag_id:
                        exif_dict["0th"][tag_id] = str(meta[key]).encode()

            piexif.insert(piexif.dump(exif_dict), temp)

        elif fmt == "PNG":
            # PNG uses text chunks instead of EXIF
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
        if os.path.exists(temp): os.remove(temp)
        raise e

# ── Strip all metadata from an image ─────────────────────────────────────────

def remove_image_meta(path):
    """Creates a pixel-identical copy with zero metadata."""
    temp = safe_temp_path(path, suffix="_clean")
    with Image.open(path) as img:
        fmt  = img.format or "JPEG"
        mode = img.mode
        # JPEG can't handle transparency — convert to RGB if needed
        if fmt in {"JPEG", "WEBP"} and mode in {"RGBA", "P", "LA"}:
            mode = "RGB"
        clean = Image.new(mode, img.size)
        clean.putdata(list(img.getdata()))
        clean.save(temp, format=fmt)
    return temp

# ── Video: write & strip via FFmpeg ──────────────────────────────────────────

def _ffmpeg(): return "ffmpeg.exe" if os.name == "nt" else "ffmpeg"

def save_video_meta(path, meta):
    """Uses FFmpeg to copy the video and inject new metadata tags."""
    ext  = os.path.splitext(path)[1] or ".mp4"
    temp = f"tmp_{uuid.uuid4().hex}_out{ext}"
    cmd  = [_ffmpeg(), "-y", "-i", path]

    if meta.get("Date Taken"):
        cmd.extend(["-metadata", f"creation_time={str(meta['Date Taken']).strip()}"])
    if meta.get("Date Modified"):
        cmd.extend(["-metadata", f"date={str(meta['Date Modified']).strip()}"])
    if meta.get("Date Created"):
        cmd.extend(["-metadata", f"creation_time={str(meta['Date Created']).strip()}"])

    cmd.extend(["-c", "copy", temp])  # -c copy = don't re-encode, just remux (fast)

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
        if os.path.exists(temp): os.remove(temp)
        raise

def remove_video_meta(path):
    """Uses FFmpeg to copy the video with all metadata stripped."""
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
        if os.path.exists(temp): os.remove(temp)
        raise

# ── API endpoints ─────────────────────────────────────────────────────────────
# These are the three URLs the browser calls:
#   POST /read   → read metadata from a file
#   POST /save   → write new metadata into a file
#   POST /remove → strip all metadata from a file

@app.post("/read")
async def read_metadata(
    file: UploadFile = File(...),
    original_last_modified: str = Form(None)  # browser sends real OS mtime in ms
):
    temp_path = safe_temp_path(file.filename)
    try:
        # Save uploaded bytes to a temp file
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        ftype = get_file_type(file.filename, file.content_type)

        try:
            if ftype == "image":
                meta = read_image_meta(temp_path, original_last_modified)
            else:
                meta = read_video_meta(temp_path, original_last_modified)
        except Exception as e:
            # Return the error inside the metadata dict instead of crashing
            meta = {"Error": str(e)}

        return {
            "type": ftype,
            "metadata": meta,
            # Pop the source flags out of meta and return them at the top level
            "date_modified_source": meta.pop("_date_modified_source", "unknown"),
            "date_taken_source":    meta.pop("_date_taken_source",    "unknown"),
            "date_created_source":  meta.pop("_date_created_source",  "unknown"),
        }
    finally:
        if os.path.exists(temp_path): os.remove(temp_path)


@app.post("/save")
async def save_metadata(
    file: UploadFile = File(...),
    metadata: str = Form(""),
    original_last_modified: str = Form(None)
):
    # Parse the JSON metadata string sent from the browser
    try:
        meta = json.loads(metadata) if metadata else {}
    except:
        meta = {}

    # Remove internal tracking fields before processing
    for k in ["_date_created_available", "_date_modified_source",
              "_date_taken_source", "_date_created_source"]:
        meta.pop(k, None)

    temp_path     = safe_temp_path(file.filename)
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
        if os.path.exists(temp_path): os.remove(temp_path)
        if modified_path and os.path.exists(modified_path): os.remove(modified_path)


@app.post("/remove")
async def remove_metadata(
    file: UploadFile = File(...),
    original_last_modified: str = Form(None)
):
    temp_path     = safe_temp_path(file.filename)
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
        if os.path.exists(temp_path): os.remove(temp_path)
        if modified_path and os.path.exists(modified_path): os.remove(modified_path)