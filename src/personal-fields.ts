/**
 * Personal fields: phone numbers, postal addresses, precise locations,
 * birth dates, IP addresses and identity-document numbers. Their values
 * never leave the app; a change to one still does ("changed the phone").
 * The same rule runs on the EZLogs server, in the Rails gem and in both
 * SQL installs (tests/fixtures/personal_key_vectors.json is shared byte
 * for byte).
 *
 * A key is personal by its words. A model or table that is itself a
 * list of phones, addresses or IPs (`PhoneNumber`, `user_addresses`)
 * makes its value columns personal too: its `number` is the phone.
 *
 * A value is masked unless it is null, blank or a boolean
 * (`phone_verified: true` says nothing about the number). Only changed
 * values are sent for an update, so two masked sides mean it changed.
 */

export const PERSONAL_MASK = "[FILTERED]";

const WORDS: ReadonlySet<string> = new Set([
  "phone", "phones", "phonenumber", "telephone", "cellphone", "msisdn", "fax",
  "address", "addresses", "addr", "street", "postcode", "postal", "zipcode",
  "birth", "birthday", "birthdate", "born", "dob", "passport",
  "ip", "ips", "ipv4", "ipv6", "latitude", "longitude", "lat", "lng", "geolocation",
]);
const NUMBERED = /^(?:phone|address|addr|line)\d+$/; // phone1, address2, line1
// Documents whose number ends in "id" or "number" (checked before the "id"
// exclusion), and pairs of words that only together name a personal value.
const PHRASES = new RegExp(
  "(?:^|_)(?:" +
    "(?:tax|vat|national|passport|id_card|id|document|personal|fiscal)_(?:id|number|no|code)" +
    "|drivers?_licen[cs]e|national_insurance|social_insurance|fiscal_code|tax_code" +
    "|(?:tel|cell|mobile)_(?:number|no|phone)|cell_phone|house_number|remote_addr|forwarded_for|post_code" +
    ")(?:_|$)",
);
const DOCUMENT_ID = /(?:^|_)(?:tax|vat|national|passport|id_card)_(?:id|number|no)$/;
// A link to a record, a kind, a count, a time or a state: never the value itself.
const NOT_A_VALUE: ReadonlySet<string> = new Set([
  "id", "ids", "uuid", "type", "kind", "count", "at", "status", "state", "verified", "confirmed",
]);
// An email names the person (actors are named by it).
const EMAIL_WORDS = ["email", "mail"];
const PHONE_ALONGSIDE_EMAIL = ["phone", "phones", "mobile", "telephone"];
// A table that is a list of these: its value columns are personal.
const PERSONAL_TABLE_LAST: ReadonlySet<string> = new Set([
  "phone", "phones", "telephone", "telephones", "address", "addresses", "ip", "ips",
]);
const NUMBER_WORDS = ["number", "numbers"];
const PHONE_WORDS = ["phone", "telephone", "mobile"];

/** Lower-cased words of a key: `addressLine1` → address, line1; `IPAddress` → ip, address. */
export function personalWords(key: unknown): string[] {
  return String(key ?? "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

export function isPersonalKey(key: unknown): boolean {
  const w = personalWords(key);
  if (w.length === 0) return false;
  const joined = w.join("_");
  const last = w[w.length - 1] as string;
  const phrase = PHRASES.test(joined);
  const word = w.some((x) => WORDS.has(x) || NUMBERED.test(x));
  if (w.some((x) => EMAIL_WORDS.includes(x)) && !w.some((x) => PHONE_ALONGSIDE_EMAIL.includes(x))) return false;
  if (phrase && !NOT_A_VALUE.has(last)) return true;
  if (DOCUMENT_ID.test(joined)) return true;
  if (NOT_A_VALUE.has(last)) return false;
  return (
    word ||
    phrase ||
    (w.length === 1 && (last === "tel" || last === "mobile" || last === "cell")) ||
    (w.includes("zip") && (w.length === 1 || w.includes("code")))
  );
}

/**
 * A model or table that is a list of phones, addresses or IPs
 * (`user_addresses`, `PhoneNumber`), not one that only mentions one
 * (`phone_calls`, `address_books`).
 */
export function isPersonalTable(table: unknown): boolean {
  const w = personalWords(table);
  if (w.length === 0) return false;
  const last = w[w.length - 1] as string;
  return (
    PERSONAL_TABLE_LAST.has(last) ||
    (NUMBER_WORDS.includes(last) && w.length > 1 && PHONE_WORDS.includes(w[w.length - 2] as string))
  );
}

/**
 * A column of a row: personal by its own name, or a value column of a
 * personal table (never its key, a link, a kind, a count, a time or a state).
 */
export function isPersonalColumn(key: unknown, table?: unknown): boolean {
  if (isPersonalKey(key)) return true;
  if (!table || !isPersonalTable(table)) return false;
  const w = personalWords(key);
  return w.length > 0 && !NOT_A_VALUE.has(w[w.length - 1] as string) && !w.some((x) => EMAIL_WORDS.includes(x));
}

/** Null, blank and booleans say nothing about the person: "removed the phone" stays readable. */
export function maskPersonalValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim().length === 0) return value;
  return PERSONAL_MASK;
}

/** A value with every personal key inside it masked, at any depth. */
export function maskPersonalNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskPersonalNested);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isPersonalKey(k) ? maskPersonalValue(v) : maskPersonalNested(v);
    }
    return out;
  }
  return value;
}

/**
 * A phone number written with its country code or an IP address inside
 * text: what a job hands an SMS or a lookup service by position, where no
 * name says what it is. Validated (digit count, address shape), so
 * versions, amounts and ids stay.
 */
const INTL_PHONE = /(?<![\w+])(?:\+\d{1,3}|00[1-9]\d{0,2}[ .-])(?:[ .-]?\(?\d{1,7}\)?){2,6}(?![\w\-/]|[.,]\d)/g;
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const IPV6 = /(?<![\w:])(?=[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:)[0-9A-Fa-f:]{2,39}(?![\w:])/g;
const MAX_SCANNED = 65_536;

function isIpv4(text: string): boolean {
  // As Ruby's IPAddr reads it: no leading zeros ("01.2.3.4" is no address).
  return text.split(".").every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIpv6(text: string): boolean {
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

export function maskPersonalText(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_SCANNED || !/\d/.test(value)) return value;
  return value
    .replace(INTL_PHONE, (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15 ? PERSONAL_MASK : m;
    })
    .replace(IPV4, (m) => (isIpv4(m) ? PERSONAL_MASK : m))
    .replace(IPV6, (m) => (isIpv6(m) ? PERSONAL_MASK : m));
}

/** Every string inside a value, phones and IPs masked (maskPersonalText). */
export function maskPersonalTextDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskPersonalTextDeep);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskPersonalTextDeep(v);
    return out;
  }
  return maskPersonalText(value);
}
