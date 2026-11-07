import type { ImageMime } from "../shared/chat";

// Image type, size and metadata handled from the bytes alone: the declared content type and
// file name are never trusted, and nothing is decoded.

interface ImageInfo { mime: ImageMime; width: number; height: number }

// Browsers decode what we serve; a huge canvas would stall every client that renders it.
// 40 megapixels decodes to about 160 MB of RGBA, above any phone camera in use.
const maxDimension = 16_384;
const maxPixels = 40_000_000;

const ascii = (data: Uint8Array, at: number, text: string) =>
  data.length >= at + text.length && [...text].every((char, i) => data[at + i] === char.charCodeAt(0));
const u16be = (d: Uint8Array, at: number) => (d[at] << 8) | d[at + 1];
const u16le = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u24le = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8) | (d[at + 2] << 16);
const u32be = (d: Uint8Array, at: number) => ((d[at] << 24) >>> 0) + ((d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]);

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Start-of-frame markers carry the size; C4 (Huffman), C8 (reserved) and CC (arithmetic) do not.
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

// EXIF Orientation (tag 0x0112 in IFD0) of an APP1 segment starting at `at`; 1 (upright) when absent.
function exifOrientation(data: Uint8Array, at: number): number {
  const end = Math.min(data.length, at + 2 + u16be(data, at + 2));
  const tiff = at + 10;
  if (!ascii(data, at + 4, "Exif\0\0") || tiff + 8 > end) return 1;
  const big = ascii(data, tiff, "MM");
  if (!big && !ascii(data, tiff, "II")) return 1;
  const u16 = (offset: number) => big ? u16be(data, tiff + offset) : u16le(data, tiff + offset);
  const u32 = (offset: number) => big ? u32be(data, tiff + offset) : (u16le(data, tiff + offset) | (u16le(data, tiff + offset + 2) << 16)) >>> 0;
  const ifd = u32(4);
  if (tiff + ifd + 2 > end) return 1;
  for (let i = 0, count = u16(ifd); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (tiff + entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

// Orientations 5–8 turn the image a quarter, so viewers see width and height swapped.
const turnsQuarter = (orientation: number) => orientation >= 5;

// An APP1 segment holding nothing but the orientation tag.
function orientationSegment(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  return new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
}

function dimensions(data: Uint8Array): ImageInfo | null {
  if (data.length >= 24 && pngSignature.every((byte, i) => data[i] === byte) && ascii(data, 12, "IHDR")) {
    return { mime: "image/png", width: u32be(data, 16), height: u32be(data, 20) };
  }
  if ((ascii(data, 0, "GIF87a") || ascii(data, 0, "GIF89a")) && data.length >= 10) {
    return { mime: "image/gif", width: u16le(data, 6), height: u16le(data, 8) };
  }
  if (ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP")) {
    if (ascii(data, 12, "VP8X") && data.length >= 30) {
      return { mime: "image/webp", width: u24le(data, 24) + 1, height: u24le(data, 27) + 1 };
    }
    if (ascii(data, 12, "VP8 ") && data.length >= 30) {
      return { mime: "image/webp", width: u16le(data, 26) & 0x3fff, height: u16le(data, 28) & 0x3fff };
    }
    if (ascii(data, 12, "VP8L") && data.length >= 25 && data[20] === 0x2f) {
      return {
        mime: "image/webp",
        width: 1 + (((data[22] & 0x3f) << 8) | data[21]),
        height: 1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6)),
      };
    }
    return null;
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let orientation = 1;
    for (let at = 2; at + 4 <= data.length;) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(data, at);
      if (isStartOfFrame(marker)) {
        if (at + 9 > data.length) return null;
        const width = u16be(data, at + 7), height = u16be(data, at + 5);
        return turnsQuarter(orientation)
          ? { mime: "image/jpeg", width: height, height: width }
          : { mime: "image/jpeg", width, height };
      }
      at += 2 + u16be(data, at + 2);
    }
  }
  return null;
}

export function inspectImage(data: Uint8Array): ImageInfo | null {
  const info = dimensions(data);
  if (!info) return null;
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= maxDimension;
  return valid(info.width) && valid(info.height) && info.width * info.height <= maxPixels ? info : null;
}

// JPEG APP1 holds EXIF (camera, GPS) and XMP; APP13 holds IPTC.
const jpegMetadataMarkers = new Set([0xe1, 0xed]);
const pngMetadataChunks = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

// Removes location and authoring metadata from JPEG and PNG, keeping a JPEG's orientation so it
// still displays upright. GIF and WebP pass through unchanged.
export function stripMetadata(data: Uint8Array, mime: ImageMime): Uint8Array {
  const kept: Uint8Array[] = [];
  if (mime === "image/jpeg") {
    kept.push(data.subarray(0, 2));
    let at = 2;
    let orientation = 1;
    while (at + 4 <= data.length && data[at] === 0xff && data[at + 1] !== 0xda) {
      // Fill bytes may pad any marker; skip them as dimensions() does, or the lengths below misalign.
      if (data[at + 1] === 0xff) { at += 1; continue; }
      const end = at + 2 + u16be(data, at + 2);
      if (!jpegMetadataMarkers.has(data[at + 1])) {
        kept.push(data.subarray(at, end));
      } else if (data[at + 1] === 0xe1 && orientation === 1) {
        orientation = exifOrientation(data, at);
        if (orientation !== 1) kept.push(orientationSegment(orientation));
      }
      at = end;
    }
    kept.push(data.subarray(at));
  } else if (mime === "image/png") {
    kept.push(data.subarray(0, 8));
    for (let at = 8; at + 12 <= data.length;) {
      const end = at + 12 + u32be(data, at);
      const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
      if (!pngMetadataChunks.has(type)) kept.push(data.subarray(at, end));
      at = end;
    }
  } else {
    return data;
  }
  return new Uint8Array(Buffer.concat(kept));
}
