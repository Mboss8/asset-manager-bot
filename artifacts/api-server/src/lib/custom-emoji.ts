import type { Telegraf } from "telegraf";

import { logger } from "./logger.js";

/**
 * Custom emoji injection layer (Bot API 9.4+).
 *
 * Wraps `bot.telegram.callApi` to transparently augment outbound messages
 * with custom_emoji entities and inline-button icons drawn from the iOS
 * pack `tgiosicons` (https://t.me/addemoji/tgiosicons). Zero changes
 * required at handler call sites — they keep using `ctx.reply(...)` /
 * `Markup.button.callback(...)` with plain Unicode emojis.
 *
 * Behavior:
 *  - Premium users: see the iOS-style custom emoji rendered in place of
 *    the matching Unicode codepoint, AND an icon on inline buttons.
 *  - Non-Premium users: see the original Unicode emoji (entity falls back
 *    to its baked-in fallback char; button icon field is silently ignored
 *    by clients that can't render it).
 *
 * Requirements:
 *  - The bot owner must have an active Telegram Premium subscription
 *    (Bot API 9.4 introduced this gate). If the API rejects our enhanced
 *    payload due to this, we self-disable and retry stripped — never
 *    crashes a user-facing send.
 *
 * Coverage: 83 of the bot's 84 in-use Unicode emojis have a pack match.
 * Primary pack is **Android-style `TgAndroidIcons`** (210 unique emoji
 * keys, monochrome line-art) — 48 direct hits + 24 visual-analogy
 * overrides re-using Android ids across semantically related emojis.
 * Cross-pack fallback to iOS `tgiosicons` for 11 emojis that neither
 * pack covers as Android (↩️ ⏳ ⏸ ▶️ 🌴 🎯 💡 📣 🧩 + the 🔴/🔵/🟡
 * color trio which Android only partially covers). One emoji left as
 * plain Unicode:
 *   - 🌿 herb: "低" priority label paired with ⚠️ (中) / 🔴 (高).
 *     Neither pack has a calm/low/green sticker that wouldn't conflict
 *     with another priority tier's semantics.
 *
 * Style mixing rationale: we accept cross-pack visual mismatch on the
 * 11 iOS fallback emojis (different stroke weight, fill style) as a
 * better trade-off than leaving them as raw Unicode. Within visual
 * pairs/trios (medals, calendars, color circles, in/out arrows) we
 * collapse to a single pack to preserve internal consistency.
 *
 * Visual-analogy overrides intentionally re-use the same custom_emoji_id
 * across semantically related Unicode emojis (e.g. 🥈 🥉 → 🥇 medal,
 * 🔴 🔵 🟡 → ⭕️ outline circle, ⛔ 📵 ☠️ → 🚫 forbidden) — Telegram
 * renders the iOS icon based on the id, not the original emoji, so users
 * see a clean iconified UI instead of [iOS-icon][unicode-emoji-fallback]
 * mismatches. Pack source: t.me/addemoji/tgiosicons (398 stickers, 185
 * unique emoji keys).
 */

export const EMOJI_TO_CE: Record<string, string> = {
  // ── Android pack `TgAndroidIcons` direct hits (48) ──
  "ℹ️": "5879785854284599288",
  "⏰": "5985616167740379273",
  "⚙️": "5877260593903177342",
  "⚠️": "5881702736843511327",
  "⚡": "5843553939672274145",
  "✅": "5843908536467198016",
  "❌": "5778527486270770928",
  // ➕/➖ pair: same emoji key "➕" has TWO sticker variants in pack;
  // first = circled-plus, second = circled-minus (pack ships no separate
  // Unicode ➖ key — author overloaded ➕). Symmetric pair on
  // 录入收入 / 录入支出.
  "➕": "5877219383691972108",
  "➖": "5875019892284985369",
  "➡️": "5877468380125990242",
  "⬅️": "5875082500023258804",
  "🆕": "5886306834410640699",
  "🎉": "5994502837327892086",
  "🏠": "5967822972931542886",
  "🏷": "5854776233950188167",
  "👁": "5960714428394507968",
  "👋": "5994750571041525522",
  "👍": "5992199545151295755",
  "👑": "5807868868886009920",
  "👤": "5771887475421090729",
  "👥": "5915556996215476302",
  "💰": "5811989245761426317",
  "💾": "5884448719889240368",
  "📁": "5875206779196935950",
  "📂": "6017174676898321263",
  "📄": "5839323457015256759",
  "📅": "5967412305338568701",
  "📈": "5776219138917668486",
  "📊": "5877485980901971030",
  "📌": "5908961403917570106",
  "📍": "5944940516754853337",
  "📎": "5877495434124988415",
  "📝": "5886330010054168711",
  "📢": "5771695636411847302",
  "📥": "5877307202888273539",
  "📺": "5836749569014109509",
  "🔄": "5839200986022812209",
  "🔓": "6034962180875490251",
  "🔔": "5909201569898827582",
  "🔕": "5909123362839335003",
  "🔗": "5877465816030515018",
  "🔥": "6008118472066732010",
  "🗃": "5877316724830768997",
  "🗑": "5879896690210639947",
  "🚫": "5872829476143894491",
  "🛡": "5926783847453692661",
  "🤖": "5931415565955503486",
  "🥇": "5961051261204696786",

  // ── Android pack visual-analogy overrides (24) — re-using Android ids
  // across semantically related Unicode emojis to keep style uniform ──
  "⛔": "5872829476143894491",  // → 🚫 forbidden
  "📵": "5872829476143894491",  // → 🚫 forbidden
  "☠️": "5872829476143894491",  // → 🚫 forbidden
  "♻️": "5839200986022812209",  // → 🔄 cycle
  "💱": "5839200986022812209",  // → 🔄 cycle
  "📆": "5967412305338568701",  // → 📅 calendar
  "🗓": "5967412305338568701",  // → 📅 calendar
  "🏢": "5967822972931542886",  // → 🏠 building
  "🗄": "5875206779196935950",  // → 📁 folder
  "📋": "5877597667231534929",  // → 🗒 notepad (closer to clipboard than 🗃)
  "📭": "5877307202888273539",  // → 📥 inbox
  "📨": "5877540355187937244",  // → 📤 outbox
  "🔙": "5875082500023258804",  // → ⬅️ left arrow
  "🆔": "5771887475421090729",  // → 👤 person
  "🚨": "5881702736843511327",  // → ⚠️ warning
  "📚": "5897850551156084824",  // → 📖 open book
  "📡": "5967432491684860012",  // → 🛜 wifi
  "🚀": "5875465628285931233",  // → ✈️ plane
  "🚧": "5994636050033545139",  // → 🪧 sign
  "🔧": "5988023995125993550",  // → 🛠 tools
  "🔍": "5874960879434338403",  // → 🔎 magnifier
  "🥈": "5961051261204696786",  // → 🥇 medal (medal trio collapse)
  "🥉": "5961051261204696786",  // → 🥇 medal
  "🏆": "5961051261204696786",  // → 🥇 trophy→medal

  // ── iOS pack `tgiosicons` fallback (11) — Android pack has no
  // suitable analog, so we cross-pack to iOS. Style mismatch is the
  // explicit trade-off vs. having no icon at all. ──
  "↩️": "5895507195524550741",  // iOS reply arrow
  "⏳": "5891211339170326418",  // iOS hourglass
  "⏸": "5891211339170326418",  // iOS hourglass (analog for pause)
  "▶️": "5773626993010546707",  // iOS play
  "🌴": "6041933986538721961",  // iOS palm tree
  "🎯": "6032949275732742941",  // iOS bullseye
  "💡": "5891120964468480450",  // iOS lightbulb
  "📣": "6039450962865688331",  // iOS megaphone (📢 horn covered by Android)
  "🧩": "5837069325034331827",  // iOS puzzle piece
  // 🔴 / 🔵 / 🟡 — Android only has 🔴 (filled red); switching one would
  // break the color-coded trio (yellow showing red would be wrong). All
  // three on iOS outline-circle keeps the trio visually consistent.
  "🔴": "5776428312414917091",
  "🔵": "5776428312414917091",
  "🟡": "5776428312414917091",
};

/**
 * Sorted longest-first so multi-codeunit / variant-selector emojis match
 * before their shorter prefixes (e.g. "⬅️" with VS-16 before "⬅").
 */
const EMOJI_KEYS_BY_LENGTH = Object.keys(EMOJI_TO_CE).sort((a, b) => b.length - a.length);

let enhancementsEnabled = true;

function disableEnhancements(reason: string): void {
  if (!enhancementsEnabled) return;
  enhancementsEnabled = false;
  logger.warn({ reason }, "[custom-emoji] enhancements disabled — falling back to Unicode-only");
}

interface AnyEntity {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  [k: string]: unknown;
}

/**
 * Scan `text` for known emojis and emit custom_emoji entities.
 * Telegram entity offsets/lengths are in UTF-16 code units, which is
 * exactly what JS string indices give us.
 */
export function buildCustomEmojiEntities(text: string, base: AnyEntity[] = []): AnyEntity[] {
  if (!enhancementsEnabled) return base;
  const out: AnyEntity[] = [...base];
  // Track occupied ranges to avoid overlap with caller-provided entities
  // or with shorter emojis we've already matched in this text.
  const occupied: Array<[number, number]> = base.map((e) => [e.offset, e.offset + e.length]);
  const overlaps = (start: number, end: number): boolean =>
    occupied.some(([s, e]) => start < e && end > s);

  for (const emoji of EMOJI_KEYS_BY_LENGTH) {
    const ceId = EMOJI_TO_CE[emoji];
    let pos = 0;
    while (true) {
      const idx = text.indexOf(emoji, pos);
      if (idx === -1) break;
      const end = idx + emoji.length;
      if (!overlaps(idx, end)) {
        out.push({
          type: "custom_emoji",
          offset: idx,
          length: emoji.length,
          custom_emoji_id: ceId,
        });
        occupied.push([idx, end]);
      }
      pos = end;
    }
  }
  // Telegram expects entities sorted by ascending offset (longer first
  // ties broken by length desc) — required by validation in some clients.
  out.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return out;
}

interface KbButton {
  text?: string;
  icon_custom_emoji_id?: string;
  [k: string]: unknown;
}

/**
 * Add `icon_custom_emoji_id` to inline buttons whose text starts with a
 * mapped emoji, AND strip that leading emoji (plus optional VS16 + one
 * trailing whitespace) from the text — Telegram already renders the
 * custom emoji as the button icon, so leaving the Unicode emoji in the
 * text caused a visual `[iOS-icon][unicode-emoji][label]` triplicate
 * (B3 P3.2 v2b polish; user-reported "好丑").
 *
 * Non-Premium clients silently ignore `icon_custom_emoji_id`. To preserve
 * graceful fallback in that scenario, when enhancements get disabled at
 * runtime (Premium expired → API rejection), `stripEnhancements()` already
 * clears the icon field; the text is permanently shorter on the
 * already-sent message but new sends will retain the leading emoji
 * because we re-render from the original handler each time (handlers
 * never mutate menus.ts in place — they construct fresh button arrays
 * per send). So strip is safe.
 */
function enhanceButton(btn: KbButton): void {
  if (!enhancementsEnabled) return;
  if (typeof btn?.text !== "string") return;
  if (btn.icon_custom_emoji_id) return; // already set (don't clobber)
  for (const emoji of EMOJI_KEYS_BY_LENGTH) {
    if (btn.text.startsWith(emoji)) {
      btn.icon_custom_emoji_id = EMOJI_TO_CE[emoji];
      // Strip leading emoji + optional VS-16 (U+FE0F) + optional single
      // whitespace. Keep further text verbatim.
      let rest = btn.text.slice(emoji.length);
      if (rest.charCodeAt(0) === 0xfe0f) rest = rest.slice(1);
      if (rest.charCodeAt(0) === 0x20) rest = rest.slice(1);
      btn.text = rest;
      return;
    }
  }
}

interface ReplyMarkup {
  inline_keyboard?: KbButton[][];
  [k: string]: unknown;
}

function enhanceReplyMarkup(rm: ReplyMarkup | undefined): void {
  if (!rm?.inline_keyboard) return;
  for (const row of rm.inline_keyboard) {
    if (Array.isArray(row)) for (const btn of row) enhanceButton(btn);
  }
}

const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);
const CAPTION_METHODS = new Set([
  "sendPhoto",
  "sendVideo",
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendVoice",
  "sendVideoNote",
  "sendPaidMedia",
  "editMessageCaption",
]);
const REPLY_MARKUP_METHODS = new Set([
  ...TEXT_METHODS,
  ...CAPTION_METHODS,
  "editMessageReplyMarkup",
  "sendInvoice",
  "sendDice",
  "sendPoll",
  "sendLocation",
  "sendVenue",
  "sendContact",
]);

/**
 * Pattern match Telegram error responses that indicate the bot owner
 * lacks Premium and therefore can't use custom emoji. Conservative:
 * matches loosely so we self-disable on first sign of trouble rather
 * than spam-failing every send. False positives just degrade to Unicode.
 */
const PREMIUM_ERR = /premium|custom.?emoji|EMOJI_INVALID|BOT_LACKS|FORBIDDEN.*emoji/i;

interface PayloadShape {
  text?: string;
  caption?: string;
  entities?: AnyEntity[];
  caption_entities?: AnyEntity[];
  reply_markup?: ReplyMarkup;
  parse_mode?: string;
  [k: string]: unknown;
}

function stripEnhancements(method: string, payload: PayloadShape): void {
  if (TEXT_METHODS.has(method) && payload.entities) {
    payload.entities = payload.entities.filter(
      (e) => e.type !== "custom_emoji",
    );
    if (payload.entities.length === 0) delete payload.entities;
  }
  if (CAPTION_METHODS.has(method) && payload.caption_entities) {
    payload.caption_entities = payload.caption_entities.filter(
      (e) => e.type !== "custom_emoji",
    );
    if (payload.caption_entities.length === 0) delete payload.caption_entities;
  }
  if (payload.reply_markup?.inline_keyboard) {
    for (const row of payload.reply_markup.inline_keyboard) {
      if (Array.isArray(row)) {
        for (const btn of row) {
          if (btn?.icon_custom_emoji_id) delete btn.icon_custom_emoji_id;
        }
      }
    }
  }
}

/**
 * Install the custom-emoji wrapper around `Telegram.prototype.callApi`.
 *
 * IMPORTANT — must patch the **prototype**, not the instance: Telegraf
 * 4.16.3 (telegraf.js handleUpdate) creates a fresh `new Telegram(...)`
 * for every incoming update and hands it to the Context, so any patch
 * confined to `bot.telegram` is bypassed for `ctx.reply` / `ctx.editMessageText`
 * etc. Patching the prototype means all Telegram instances (the bot's
 * canonical one AND every per-update one) share the patched callApi.
 *
 * Idempotent — calling twice is harmless (second wrap detects the marker
 * and bails). Place this in `createBot()` after the Telegraf instance
 * is constructed and before any handlers are wired.
 */
export function installCustomEmojiWrapper(bot: Telegraf): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto: any = Object.getPrototypeOf(bot.telegram);
  if (proto.__customEmojiInstalled) {
    logger.debug("[custom-emoji] wrapper already installed on prototype, skipping");
    return;
  }
  const original = proto.callApi;
  proto.callApi = async function patched(
    this: unknown,
    method: string,
    payload: PayloadShape = {},
    opts?: unknown,
  ): Promise<unknown> {
    if (enhancementsEnabled) {
      try {
        // Bot API spec: `entities` and `parse_mode` are mutually exclusive.
        // This codebase uses `parse_mode: "HTML"` on the vast majority of
        // sends (form-handler, helpers, dispatch, etc.) — so we MUST NOT
        // inject text/caption entities when parse_mode is present, or
        // Telegram will drop our entities (best case) or reject the
        // message. v2 may add an HTML→entities parser to recover this
        // surface; for now we accept that custom emoji in message bodies
        // only render on the small set of plain-text sends. Buttons are
        // independent (icon_custom_emoji_id is a button-level field) and
        // keep getting iOS icons regardless of parse_mode.
        const canInjectText = !payload.parse_mode;
        if (canInjectText && TEXT_METHODS.has(method) && typeof payload.text === "string") {
          payload.entities = buildCustomEmojiEntities(payload.text, payload.entities ?? []);
          if (payload.entities.length === 0) delete payload.entities;
        }
        if (canInjectText && CAPTION_METHODS.has(method) && typeof payload.caption === "string") {
          payload.caption_entities = buildCustomEmojiEntities(
            payload.caption,
            payload.caption_entities ?? [],
          );
          if (payload.caption_entities.length === 0) delete payload.caption_entities;
        }
        // Button enhancement always runs — icon_custom_emoji_id is
        // orthogonal to text formatting. Mutates reply_markup in place;
        // safe because handlers in this codebase always construct fresh
        // markup objects per send (Markup.inlineKeyboard returns a new
        // object), so cross-send leakage is not a concern.
        if (REPLY_MARKUP_METHODS.has(method) && payload.reply_markup) {
          enhanceReplyMarkup(payload.reply_markup);
        }
      } catch (e) {
        logger.error({ err: e, method }, "[custom-emoji] inject failed, sending unchanged");
      }
    }
    try {
      return await original.call(this, method, payload, opts);
    } catch (err: unknown) {
      const e = err as { description?: string; response?: { description?: string }; message?: string };
      const msg = e?.response?.description || e?.description || e?.message || "";
      if (enhancementsEnabled && PREMIUM_ERR.test(msg)) {
        disableEnhancements(`API rejected enhancements: ${msg}`);
        stripEnhancements(method, payload);
        return await original.call(this, method, payload, opts);
      }
      throw err;
    }
  };
  proto.__customEmojiInstalled = true;
  logger.info(
    { mappedEmojis: Object.keys(EMOJI_TO_CE).length },
    "[custom-emoji] wrapper installed (Bot API 9.4+ icon_custom_emoji_id + entities)",
  );
}
