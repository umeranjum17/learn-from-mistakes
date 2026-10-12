// One redaction for every string a source keeps: known key shapes, any value whose key name says it is a
// secret, and email addresses. Each match becomes [redacted].
const R = '[redacted]';
const VALUE = String.raw`(?:\\"(?:(?!\\")[\s\S])*(?:\\"|$)|"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|(?!\[redacted\])[^\s"'\\}\]&]+)`;
const RULES = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, R], // PEM blocks, cut-off ones too
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R], // sk-… and sk-ant-…
  [/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, R], // Stripe secret, restricted and test keys
  [/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/g, R], // JWTs
  [/\b((?:Bearer|Basic|Token)\s+)[\w.~+/=-]+/gi, `$1${R}`],
  [/\b([a-z][\w+.-]*:\/\/[^\s:/@"']+:)[^\s"']+(?=@)/gi, `$1${R}`], // the password in scheme://user:password@host
  [/\b(?:npm_|glpat-)[A-Za-z0-9_-]{20,}/g, R],
  // KEY=value, key: value and "key": "value" (JSON-escaped too) where the key name has token, secret, password,
  // key or auth. A quoted value is replaced whole, to its closing quote or the end; a bare one to a space or quote.
  // A --flag followed by a space takes its value the same way.
  [new RegExp(String.raw`((?:\\?["'])?[\w.-]*(?:token|secret|passw(?:or)?d|key|auth)[\w.-]*(?:\\?["'])?\s*[:=]\s*)` + VALUE, 'gi'), `$1${R}`],
  [new RegExp(String.raw`(--[\w.-]*(?:token|secret|passw(?:or)?d|key|auth)[\w.-]*\s+)` + VALUE, 'gi'), `$1${R}`],
  [/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, R],
];

export const redact = (text) => RULES.reduce((t, [re, to]) => t.replace(re, to), String(text));

// An excerpt of a source's text: whitespace collapsed, the first 4000 characters redacted, then cut to 300, so no
// secret is split at the edge of the kept part.
export const excerpt = (text) => redact(String(text).replace(/\s+/g, ' ').trim().slice(0, 4000)).slice(0, 300);
