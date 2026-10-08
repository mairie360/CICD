// Marker user of the log test (MAIR-290): unique values for one run, and the strings that betray
// them in a log (the value itself and the encodings a request or an error usually gives it).
import { randomInt } from "node:crypto";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// Values that pass the usual validations (a real e-mail domain, letters-only names, a French
// mobile number, a password with every character class) and that no fixture can hold by chance.
export function generateMarker(random = randomInt) {
  const word = (n) => Array.from({ length: n }, () => LETTERS[random(LETTERS.length)]).join("");
  const digits = (n) => Array.from({ length: n }, () => String(random(10))).join("");
  const capitalized = (text) => text[0].toUpperCase() + text.slice(1);
  return {
    email: `gdpr.${word(10)}@example.com`,
    first_name: capitalized(`marker${word(8)}`),
    last_name: capitalized(`tracer${word(8)}`),
    phone: `06${digits(8)}`,
    password: `Mk${word(6)}!${digits(4)}${word(4).toUpperCase()}`,
  };
}

// The base64 characters that only depend on `value`, for its three possible alignments inside a
// longer encoded string (a JWT payload, a Basic header, a dumped buffer).
function base64Needles(value) {
  const needles = [];
  const bytes = Buffer.from(value);
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift, 0x78), bytes]).toString("base64");
    const firstGroup = Math.ceil(shift / 3);
    const lastGroup = Math.floor((shift + bytes.length) / 3); // exclusive
    const core = encoded.slice(firstGroup * 4, lastGroup * 4);
    if (core.length >= 8) {
      needles.push(core);
      const url = core.replaceAll("+", "-").replaceAll("/", "_");
      if (url !== core) needles.push(url);
    }
  }
  return needles;
}

// [{ field, variant, text }]: what to look for. Logs are searched case-insensitively.
export function needles(marker, sensitive = {}) {
  const list = [];
  const add = (field, variant, text) => {
    if (text && !list.some((n) => n.text.toLowerCase() === text.toLowerCase())) list.push({ field, variant, text });
  };
  for (const [field, value] of Object.entries(marker)) {
    add(field, "raw", value);
    add(field, "url-encoded", encodeURIComponent(value));
    add(field, "json-escaped", JSON.stringify(value).slice(1, -1));
    for (const text of base64Needles(value)) add(field, "base64", text);
  }
  // The national significant number is what the database stores (MAIR-480): it is inside
  // "06…", "+336…" and "336…" alike.
  if (marker.phone) add("phone", "national number", marker.phone.replace(/^0/, ""));
  for (const [name, value] of Object.entries(sensitive)) {
    add(name, "raw", value);
    add(name, "url-encoded", encodeURIComponent(value));
    // A captured `Authorization` header ("Bearer <jwt>"): the credential is the part after the
    // scheme, and a log may print it alone.
    const credential = /^(?:bearer|basic)\s+(\S{8,})$/i.exec(value)?.[1];
    if (credential) add(name, "credential", credential);
  }
  return list;
}
