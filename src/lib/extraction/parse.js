/**
 * Turns a model reply into an object, tolerating everything models actually do
 * to JSON: markdown fences, a sentence of preamble, and — the one that really
 * happens in production — a reply cut off mid-structure by the output limit.
 *
 * Every recovery is recorded as a warning rather than being silently applied,
 * so the UI can tell the user their data was reconstructed.
 */

export const PARSE_WARNINGS = {
  strippedFence: 'stripped_code_fence',
  strippedProse: 'stripped_surrounding_prose',
  repairedTruncation: 'repaired_truncated_json',
};

/** Remove a BOM and any ```json fence, including an unterminated one. */
function stripFence(text) {
  let out = text.replace(/^﻿/, '').trim();
  const opening = /^```[a-zA-Z]*[ \t]*\r?\n?/;
  if (!opening.test(out)) return { text: out, stripped: false };
  out = out.replace(opening, '');
  // The closing fence is absent when the reply was truncated.
  out = out.replace(/\r?\n?```[\s\S]*$/, '');
  return { text: out.trim(), stripped: true };
}

/**
 * Walk `text` from `start` to `end`, tracking JSON string state so that braces
 * inside a string value are never mistaken for structure. This matters more
 * than it sounds: `rawText` routinely contains `{`, `}` and `"`.
 *
 * @returns {{ stack: string[], inString: boolean, closedAt: number }}
 *   `closedAt` is the index just past a complete top-level value, or -1.
 */
function scan(text, start, end = text.length) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < end; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return { stack, inString, closedAt: i + 1 };
    }
  }

  return { stack, inString, closedAt: -1 };
}

/**
 * Close an unterminated value so it can be parsed.
 * Trims back any half-written token, then closes open strings and containers.
 */
function closeOpenStructures(fragment, { stack, inString }) {
  let out = fragment;
  if (inString) out += '"';

  // Drop a dangling separator or a key with no value yet.
  out = out.replace(/[\s,]+$/, '');
  if (/:\s*$/.test(out)) out += 'null';

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}

/**
 * Rebuild a truncated object. Tries closing at the end first, then walks back
 * to earlier element boundaries — a reply can be cut mid-number or mid-escape,
 * where closing in place still will not parse.
 */
function parseTruncated(text, start) {
  const cuts = [text.length];
  // Candidate boundaries: commas at depth, scanned right to left.
  for (let i = text.length - 1, found = 0; i > start && found < 24; i -= 1) {
    if (text[i] === ',') {
      cuts.push(i);
      found += 1;
    }
  }

  for (const cut of cuts) {
    const state = scan(text, start, cut);
    if (state.stack.length === 0) continue;
    const candidate = closeOpenStructures(text.slice(start, cut), state);
    try {
      return JSON.parse(candidate);
    } catch {
      /* try an earlier boundary */
    }
  }
  return undefined;
}

/**
 * Parse a model reply into `{ data, warnings }`.
 * Returns `data: null` when nothing salvageable was found — the caller decides
 * what to do, and must preserve the original text either way.
 *
 * @param {string} text raw assistant message content
 * @returns {{ data: object|null, warnings: string[] }}
 */
export function parseExtractionPayload(text) {
  const warnings = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { data: null, warnings };
  }

  const fenced = stripFence(text);
  if (fenced.stripped) warnings.push(PARSE_WARNINGS.strippedFence);
  const body = fenced.text;

  // Fast path: the whole reply is valid JSON.
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed, warnings };
    }
  } catch {
    /* fall through to recovery */
  }

  const start = body.indexOf('{');
  if (start === -1) return { data: null, warnings };

  // A complete object with prose around it.
  const state = scan(body, start);
  if (state.closedAt !== -1) {
    try {
      const parsed = JSON.parse(body.slice(start, state.closedAt));
      if (parsed && typeof parsed === 'object') {
        if (start > 0 || state.closedAt < body.length) {
          warnings.push(PARSE_WARNINGS.strippedProse);
        }
        return { data: parsed, warnings };
      }
    } catch {
      /* fall through to truncation repair */
    }
  }

  const repaired = parseTruncated(body, start);
  if (repaired && typeof repaired === 'object') {
    warnings.push(PARSE_WARNINGS.repairedTruncation);
    return { data: repaired, warnings };
  }

  return { data: null, warnings };
}

export const __testing = { scan, stripFence, closeOpenStructures };
