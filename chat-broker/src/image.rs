//! Image type, size and metadata handled from the bytes alone: the declared content type is never trusted, and
//! nothing is decoded. A port of `chat-plugin/server/image.ts`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mime {
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl Mime {
    pub fn as_str(self) -> &'static str {
        match self {
            Mime::Png => "image/png",
            Mime::Jpeg => "image/jpeg",
            Mime::Webp => "image/webp",
            Mime::Gif => "image/gif",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime: Mime,
    pub width: u32,
    pub height: u32,
}

/// Browsers decode what we serve; a huge canvas would stall every client that renders it.
/// 40 megapixels decodes to about 160 MB of RGBA, above any phone camera in use.
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;

/// Byte `at`, 0 past the end, as JavaScript reads `undefined` in the plugin's bit arithmetic.
fn byte(data: &[u8], at: usize) -> u32 {
    data.get(at).copied().map_or(0, u32::from)
}

fn ascii(data: &[u8], at: usize, text: &str) -> bool {
    data.get(at..at + text.len()) == Some(text.as_bytes())
}

fn u16be(data: &[u8], at: usize) -> u32 {
    (byte(data, at) << 8) | byte(data, at + 1)
}

fn u16le(data: &[u8], at: usize) -> u32 {
    byte(data, at) | (byte(data, at + 1) << 8)
}

fn u24le(data: &[u8], at: usize) -> u32 {
    byte(data, at) | (byte(data, at + 1) << 8) | (byte(data, at + 2) << 16)
}

fn u32be(data: &[u8], at: usize) -> u32 {
    (byte(data, at) << 24)
        | (byte(data, at + 1) << 16)
        | (byte(data, at + 2) << 8)
        | byte(data, at + 3)
}

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// Start-of-frame markers carry the size; C4 (Huffman), C8 (reserved) and CC (arithmetic) do not.
fn is_start_of_frame(marker: u32) -> bool {
    (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker)
}

/// EXIF Orientation (tag 0x0112 in IFD0) of an APP1 segment starting at `at`; 1 (upright) when absent.
fn exif_orientation(data: &[u8], at: usize) -> u32 {
    let end = data.len().min(at + 2 + u16be(data, at + 2) as usize);
    let tiff = at + 10;
    if !ascii(data, at + 4, "Exif\0\0") || tiff + 8 > end {
        return 1;
    }
    let big = ascii(data, tiff, "MM");
    if !big && !ascii(data, tiff, "II") {
        return 1;
    }
    let u16 = |offset: usize| {
        if big {
            u16be(data, tiff + offset)
        } else {
            u16le(data, tiff + offset)
        }
    };
    let u32 = |offset: usize| {
        if big {
            u32be(data, tiff + offset)
        } else {
            u16le(data, tiff + offset) | (u16le(data, tiff + offset + 2) << 16)
        }
    };
    let ifd = u32(4) as usize;
    if tiff + ifd + 2 > end {
        return 1;
    }
    for i in 0..u16(ifd) as usize {
        let entry = ifd + 2 + i * 12;
        if tiff + entry + 12 > end {
            return 1;
        }
        if u16(entry) == 0x0112 {
            let value = u16(entry + 8);
            return if (1..=8).contains(&value) { value } else { 1 };
        }
    }
    1
}

/// Orientations 5–8 turn the image a quarter, so viewers see width and height swapped.
fn turns_quarter(orientation: u32) -> bool {
    orientation >= 5
}

/// An APP1 segment holding nothing but the orientation tag.
fn orientation_segment(orientation: u32) -> Vec<u8> {
    let tiff: [u8; 26] = [
        0x4d,
        0x4d,
        0,
        42,
        0,
        0,
        0,
        8,
        0,
        1,
        0x01,
        0x12,
        0,
        3,
        0,
        0,
        0,
        1,
        0,
        orientation as u8,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    let mut body = b"Exif\0\0".to_vec();
    body.extend_from_slice(&tiff);
    let length = body.len() + 2;
    let mut segment = vec![0xff, 0xe1, (length >> 8) as u8, (length & 0xff) as u8];
    segment.extend_from_slice(&body);
    segment
}

fn info(mime: Mime, width: u32, height: u32) -> Option<ImageInfo> {
    Some(ImageInfo {
        mime,
        width,
        height,
    })
}

fn dimensions(data: &[u8]) -> Option<ImageInfo> {
    if data.len() >= 24 && data[..8] == PNG_SIGNATURE && ascii(data, 12, "IHDR") {
        return info(Mime::Png, u32be(data, 16), u32be(data, 20));
    }
    if (ascii(data, 0, "GIF87a") || ascii(data, 0, "GIF89a")) && data.len() >= 10 {
        return info(Mime::Gif, u16le(data, 6), u16le(data, 8));
    }
    if ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP") {
        if ascii(data, 12, "VP8X") && data.len() >= 30 {
            return info(Mime::Webp, u24le(data, 24) + 1, u24le(data, 27) + 1);
        }
        if ascii(data, 12, "VP8 ") && data.len() >= 30 {
            return info(
                Mime::Webp,
                u16le(data, 26) & 0x3fff,
                u16le(data, 28) & 0x3fff,
            );
        }
        if ascii(data, 12, "VP8L") && data.len() >= 25 && data[20] == 0x2f {
            return info(
                Mime::Webp,
                1 + (((byte(data, 22) & 0x3f) << 8) | byte(data, 21)),
                1 + (((byte(data, 24) & 0x0f) << 10)
                    | (byte(data, 23) << 2)
                    | ((byte(data, 22) & 0xc0) >> 6)),
            );
        }
        return None;
    }
    if byte(data, 0) == 0xff && byte(data, 1) == 0xd8 {
        let mut orientation = 1;
        let mut at = 2;
        while at + 4 <= data.len() {
            if data[at] != 0xff {
                return None;
            }
            let marker = u32::from(data[at + 1]);
            if marker == 0xff {
                at += 1;
                continue;
            }
            if marker == 0xda || marker == 0xd9 {
                return None;
            }
            if marker == 0xe1 && orientation == 1 {
                orientation = exif_orientation(data, at);
            }
            if is_start_of_frame(marker) {
                if at + 9 > data.len() {
                    return None;
                }
                let (width, height) = (u16be(data, at + 7), u16be(data, at + 5));
                return if turns_quarter(orientation) {
                    info(Mime::Jpeg, height, width)
                } else {
                    info(Mime::Jpeg, width, height)
                };
            }
            at += 2 + u16be(data, at + 2) as usize;
        }
    }
    None
}

/// The type and size of a PNG, JPEG, WebP or GIF; None for anything else (SVG included) and for sizes no client
/// should decode.
pub fn inspect_image(data: &[u8]) -> Option<ImageInfo> {
    let info = dimensions(data)?;
    let valid = |n: u32| n > 0 && n <= MAX_DIMENSION;
    (valid(info.width)
        && valid(info.height)
        && u64::from(info.width) * u64::from(info.height) <= MAX_PIXELS)
        .then_some(info)
}

/// JPEG APP1 holds EXIF (camera, GPS) and XMP; APP13 holds IPTC.
const JPEG_METADATA_MARKERS: [u8; 2] = [0xe1, 0xed];
const PNG_METADATA_CHUNKS: [&[u8]; 4] = [b"eXIf", b"tEXt", b"zTXt", b"iTXt"];

/// `data[from..to]`, clamped to the data as JavaScript's `subarray` clamps.
fn slice(data: &[u8], from: usize, to: usize) -> &[u8] {
    let to = to.min(data.len());
    &data[from.min(to)..to]
}

/// Removes location and authoring metadata from JPEG and PNG, keeping a JPEG's orientation so it still displays
/// upright. GIF and WebP pass through unchanged.
pub fn strip_metadata(data: &[u8], mime: Mime) -> Vec<u8> {
    let mut kept: Vec<u8> = Vec::with_capacity(data.len());
    match mime {
        Mime::Jpeg => {
            kept.extend_from_slice(slice(data, 0, 2));
            let mut at = 2;
            let mut orientation = 1;
            while at + 4 <= data.len() && data[at] == 0xff && data[at + 1] != 0xda {
                // Fill bytes may pad any marker; skip them as dimensions() does, or the lengths below misalign.
                if data[at + 1] == 0xff {
                    at += 1;
                    continue;
                }
                let end = at + 2 + u16be(data, at + 2) as usize;
                if !JPEG_METADATA_MARKERS.contains(&data[at + 1]) {
                    kept.extend_from_slice(slice(data, at, end));
                } else if data[at + 1] == 0xe1 && orientation == 1 {
                    orientation = exif_orientation(data, at);
                    if orientation != 1 {
                        kept.extend_from_slice(&orientation_segment(orientation));
                    }
                }
                at = end;
            }
            kept.extend_from_slice(slice(data, at, data.len()));
        }
        Mime::Png => {
            kept.extend_from_slice(slice(data, 0, 8));
            let mut at = 8;
            while at + 12 <= data.len() {
                let end = at + 12 + u32be(data, at) as usize;
                if !PNG_METADATA_CHUNKS.contains(&slice(data, at + 4, at + 8)) {
                    kept.extend_from_slice(slice(data, at, end));
                }
                at = end;
            }
        }
        Mime::Webp | Mime::Gif => return data.to_vec(),
    }
    kept
}
