// Tiny EXIF reader (JPEG APP1, PNG eXIf, WebP EXIF chunk). Returns { tagName: value } or null.
const TAGS = {
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x011a: 'XResolution', 0x011b: 'YResolution',
  0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright', 0x8769: '_ExifIFD', 0x8825: '_GPSIFD',
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISO', 0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized', 0x9204: 'ExposureBias', 0x9207: 'MeteringMode', 0x9209: 'Flash', 0x920a: 'FocalLength',
  0xa001: 'ColorSpace', 0xa002: 'PixelWidth', 0xa003: 'PixelHeight', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance',
  0xa405: 'FocalLength35mm', 0xa433: 'LensMake', 0xa434: 'LensModel',
};
const GPS_TAGS = { 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0006: 'GPSAltitude' };
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readTiff(view, start) {
  const le = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, le);
  const u32 = (o) => view.getUint32(start + o, le);
  if (u16(2) !== 42) return null;
  const out = {};
  const readValue = (type, count, valOff) => {
    const size = (SIZES[type] || 1) * count;
    const off = size > 4 ? u32(valOff) : valOff;
    const vals = [];
    for (let i = 0; i < Math.min(count, 64); i++) {
      const o = off + i * (SIZES[type] || 1);
      if (start + o + (SIZES[type] || 1) > view.byteLength) break;
      if (type === 3) vals.push(u16(o));
      else if (type === 4) vals.push(u32(o));
      else if (type === 9) vals.push(view.getInt32(start + o, le));
      else if (type === 5) { const d = u32(o + 4); vals.push(d ? u32(o) / d : 0); }
      else if (type === 10) { const d = view.getInt32(start + o + 4, le); vals.push(d ? view.getInt32(start + o, le) / d : 0); }
      else vals.push(view.getUint8(start + o));
    }
    if (type === 2) return String.fromCharCode(...vals.filter((c) => c)).trim();
    return vals.length === 1 ? vals[0] : vals;
  };
  const walk = (ifdOff, map, depth = 0) => {
    if (!ifdOff || depth > 3 || start + ifdOff + 2 > view.byteLength) return;
    const n = u16(ifdOff);
    for (let i = 0; i < n && i < 400; i++) {
      const e = ifdOff + 2 + i * 12;
      if (start + e + 12 > view.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const name = map[tag];
      if (!name) continue;
      const val = readValue(type, count, e + 8);
      if (name === '_ExifIFD') walk(val, TAGS, depth + 1);
      else if (name === '_GPSIFD') walk(val, GPS_TAGS, depth + 1);
      else out[name] = val;
    }
  };
  walk(u32(4), TAGS);
  return out;
}

export async function readExif(file) {
  const buf = await file.slice(0, 512 * 1024).arrayBuffer();
  const v = new DataView(buf);
  try {
    if (v.getUint16(0) === 0xffd8) { // JPEG
      let o = 2;
      while (o + 4 < v.byteLength) {
        const marker = v.getUint16(o), len = v.getUint16(o + 2);
        if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return readTiff(v, o + 10);
        if ((marker & 0xff00) !== 0xff00) break;
        o += 2 + len;
      }
      return null;
    }
    if (v.getUint32(0) === 0x89504e47) { // PNG chunks
      let o = 8;
      while (o + 8 < v.byteLength) {
        const len = v.getUint32(o), type = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
        if (type === 'eXIf') return readTiff(v, o + 8);
        o += 12 + len;
      }
      return null;
    }
    if (v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) { // RIFF....WEBP
      let o = 12;
      while (o + 8 < v.byteLength) {
        const type = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
        const len = v.getUint32(o + 4, true);
        if (type === 'EXIF') { const s = o + 8; return readTiff(v, v.getUint32(s) === 0x45786966 ? s + 6 : s); }
        o += 8 + len + (len % 2);
      }
    }
  } catch { /* corrupt data */ }
  return null;
}

/** Human-friendly formatting of the most useful tags. */
export function describeExif(x) {
  if (!x) return [];
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== '' && v !== null) rows.push([k, String(v)]); };
  add('Camera', [x.Make, x.Model].filter(Boolean).join(' ').trim());
  add('Lens', [x.LensMake, x.LensModel].filter(Boolean).join(' ').trim());
  add('Date taken', x.DateTimeOriginal || x.DateTime);
  if (x.ExposureTime) add('Exposure', x.ExposureTime >= 1 ? `${x.ExposureTime}s` : `1/${Math.round(1 / x.ExposureTime)}s`);
  if (x.FNumber) add('Aperture', `f/${(+x.FNumber).toFixed(1)}`);
  add('ISO', Array.isArray(x.ISO) ? x.ISO[0] : x.ISO);
  if (x.FocalLength) add('Focal length', `${(+x.FocalLength).toFixed(1)} mm${x.FocalLength35mm ? ` (${x.FocalLength35mm} mm eq.)` : ''}`);
  if (x.Flash !== undefined) add('Flash', x.Flash & 1 ? 'Fired' : 'No flash');
  if (x.PixelWidth && x.PixelHeight) add('Pixel size', `${x.PixelWidth} × ${x.PixelHeight}`);
  if (x.Orientation) add('Orientation', { 1: 'Normal', 3: '180°', 6: '90° CW', 8: '90° CCW' }[x.Orientation] || x.Orientation);
  add('Software', x.Software);
  add('Artist', x.Artist);
  add('Copyright', x.Copyright);
  add('Description', x.ImageDescription);
  const dms = (v, ref) => (Array.isArray(v) && v.length === 3 ? ((v[0] + v[1] / 60 + v[2] / 3600) * (ref === 'S' || ref === 'W' ? -1 : 1)).toFixed(6) : null);
  const lat = dms(x.GPSLatitude, x.GPSLatitudeRef), lon = dms(x.GPSLongitude, x.GPSLongitudeRef);
  if (lat && lon) rows.push(['GPS', `${lat}, ${lon}`, 'gps']);
  return rows;
}
