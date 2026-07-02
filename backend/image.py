from PIL import Image
import piexif

# Create image
img = Image.new("RGB", (500, 500), color="green")

# EXIF metadata
exif_dict = {
    "0th": {
        piexif.ImageIFD.DateTime: b"2026:06:17 12:00:00"
    },
    "Exif": {
        piexif.ExifIFD.DateTimeOriginal: b"2024:01:10 10:00:00",
        piexif.ExifIFD.DateTimeDigitized: b"2024:01:10 10:05:00",
    },
    "GPS": {},
    "1st": {},
    "thumbnail": None
}

# Convert to bytes
exif_bytes = piexif.dump(exif_dict)

# Save image
img.save("digitized_test.jpg", exif=exif_bytes)

print("digitized_test.jpg created successfully")