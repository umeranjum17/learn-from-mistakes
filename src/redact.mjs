// One redaction for every string a source keeps: known key shapes, any value whose key name says it is a
// secret, and email addresses. Each match becomes [redacted].
const R = '[redacted]';
const RULES = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, R], // PEM blocks, cut-off ones too
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R], // sk-… and sk-ant-…
  [/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/g, R], // JWTs
  [/\b(Bearer\s+)[\w.~+/=-]+/gi, `$1${R}`],
  // KEY=value, key: value and "key": "value" where the key name has token, secret, password, key or auth
  [/(["']?)([\w.-]*(?:token|secret|passw(?:or)?d|key|auth)[\w.-]*)\1(\s*[:=]\s*)(["']?)[^\s"',;}]+\4/gi, `$1$2$1$3$4${R}$4`],
  [/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, R],
];

export const redact = (text) => RULES.reduce((t, [re, to]) => t.replace(re, to), String(text));
