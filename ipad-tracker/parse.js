// Pull device details out of OCR text from an iPad's Settings › General › About screen.
// Each row there is "Label   value", so the value is the rest of the line after its label,
// or the next line when OCR splits the row. Works in the browser (window.AboutParser) and Node (tests).
(function (root) {
  const LABELS = [
    // Most specific first: "Model Number" must not be taken as "Name".
    { key: 'serial', re: /\bs[eo]r[il1]a[il1]\s*(?:n[uo]m[bh]er|no\.?|#)?\b[:.]?/i },
    { key: 'modelNumber', re: /\bmode[il1]\s*n[uo]m[bh]er\b[:.]?/i },
    { key: 'modelName', re: /\bmode[il1]\s*name\b[:.]?/i },
    { key: 'os', re: /\b(?:ipad\s*os|ios|software)\s*version\b[:.]?/i },
    { key: 'imei', re: /\bimei\s*2?\b[:.]?/i },
    { key: 'wifi', re: /\bwi-?\s*fi\s*address\b[:.]?/i },
    { key: 'name', re: /^\W*name\b[:.]?/i },
  ];
  // Other About rows: a line holding one of these is never a value for the row above it.
  const OTHER_ROWS = /\b(songs|videos|photos|applications|capacity|available|bluetooth|seid|eid|modem|carrier|network|limited warranty|applecare|coverage|legal|certificate|about|general)\b/i;

  // Apple serials are 8–12 capital letters and digits without the letters O and I,
  // so an O or I read from the screen is a zero or a one.
  function cleanSerial(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
    return /^[A-Z0-9]{8,14}$/.test(s) ? s : '';
  }
  // Unlabelled text: only a 10–12 character mix of letters and digits counts.
  const looksLikeSerial = t => { const s = cleanSerial(t); return s.length >= 10 && s.length <= 12 && /\d/.test(s) && /[A-Z]/.test(s); };
  // Rows that open another screen end in a chevron, which OCR reads as ›, > or ».
  const strip = s => String(s || '').replace(/[\s|›>»]+$/, '').trim();
  const tidy = s => strip(s).replace(/\s{2,}/g, ' ');

  function labelOf(line) {
    for (const l of LABELS) {
      const m = l.re.exec(line);
      if (m) return { key: l.key, rest: line.slice(m.index + m[0].length) };
    }
    return null;
  }

  function parseAbout(text, opts = {}) {
    // Lines keep their wide gaps (label ··· value) so the app can offer each part on its own.
    const lines = String(text || '').split(/\r?\n/).map(strip).filter(Boolean);
    const out = { serial: '', name: '', modelName: '', modelNumber: '', os: '', assetTag: '', lines };
    for (let i = 0; i < lines.length; i++) {
      const hit = labelOf(lines[i]);
      if (!hit || !(hit.key in out) || out[hit.key]) continue;
      let value = tidy(hit.rest.replace(/^[\s:.\-–]+/, ''));
      const next = lines[i + 1];
      if (!value && next && !labelOf(next) && !OTHER_ROWS.test(next)) value = tidy(next);
      if (!value) continue;
      if (hit.key === 'serial') {
        // The value is usually one token; OCR sometimes splits it with a space.
        value = cleanSerial(value.split(/\s+/).length <= 3 ? value : value.split(/\s+/)[0]);
      }
      // "iPad" sometimes loses its thin leading i.
      if (hit.key === 'modelName') value = value.replace(/^[|l!]?Pad\b/, 'iPad');
      out[hit.key] = value;
    }

    // No "Serial Number" label found (cropped photo, OCR misread): take the one token
    // shaped like an Apple serial, skipping model numbers (MPQ03LL/A) and addresses.
    if (!out.serial) {
      const tokens = lines.filter(l => { const h = labelOf(l); return !(h && h.key !== 'serial') && !OTHER_ROWS.test(l); })
        .join(' ').split(/\s+/)
        .filter(t => !/[/:]/.test(t) && t !== out.modelNumber)
        .map(t => t.replace(/[^A-Za-z0-9]/g, ''))
        .filter(t => /^[A-Z0-9]+$/.test(t) && looksLikeSerial(t));
      const unique = [...new Set(tokens.map(cleanSerial))];
      if (unique.length === 1) out.serial = unique[0];
    }

    // Asset tag: a configured prefix (e.g. "LVB-") found anywhere, else optionally the device name.
    const prefix = String(opts.assetPrefix || '').trim();
    if (prefix) {
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`${esc}[-\\s]?[A-Za-z0-9-]+`, 'i').exec(lines.join('\n'));
      if (m) out.assetTag = m[0].replace(/\s+/g, '').toUpperCase();
    }
    if (!out.assetTag && opts.nameIsAssetTag && out.name) out.assetTag = out.name;
    return out;
  }

  const api = { parseAbout, cleanSerial };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AboutParser = api;
})(typeof self !== 'undefined' ? self : this);
