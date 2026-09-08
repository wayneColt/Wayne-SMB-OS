/** redact.js — strip anything resembling a payment card before the transcript touches D1. Names and phones stay: they are the operating data. fabricated:false */
export const PAN = /\b(?:\d[ -]*?){13,16}\b/g;
export const redact = (text) => String(text || "").replace(PAN, "[REDACTED-PAN]");
