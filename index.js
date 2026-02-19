import http from "http";
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import FormData from "form-data";

// Evita crash silencioso: erros não tratados viram log no Railway
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const WORKER_BASE = (process.env.WORKER_BASE || "").replace(/\/+$/, "");
const INGEST_KEY = String(process.env.INGEST_KEY || "").replace(/[\r\n\t]/g, "").trim();

if (!BOT_TOKEN) throw new Error("Faltou BOT_TOKEN.");
if (!WORKER_BASE) throw new Error("Faltou WORKER_BASE.");
if (!INGEST_KEY) throw new Error("Faltou INGEST_KEY.");

const bot = new Telegraf(BOT_TOKEN);

// =======================
// Helpers
// =======================
function parseMoney(s) {
  const n = Number(String(s || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function slugifyBook(raw) {
  let s = String(raw || "").trim().toLowerCase();
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {}
  s = s.replace(/&/g, "e");
  s = s.replace(/[^a-z0-9]+/g, "");
  return s;
}

function normalizeBook(s) {
  return slugifyBook(s);
}

function moneyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function genToken() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// =======================
// Worker calls
// =======================
async function ingestTelegram(payload) {
  const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-INGEST-KEY": INGEST_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

async function sendImageToWorker({ telegram_id, chat_id, fileUrl, filename, book_hint, caption }) {
  const imgResp = await fetch(fileUrl);
  if (!imgResp.ok) throw new Error("Falha ao baixar imagem do Telegram");

  const buf = Buffer.from(await imgResp.arrayBuffer());

  const form = new FormData();
  form.append("telegram_id", telegram_id);
  form.append("chat_id", chat_id);
  if (book_hint) form.append("book_hint", book_hint);
  if (caption) form.append("caption", caption);
  form.append("image", buf, { filename: filename || "ticket.jpg", contentType: "image/jpeg" });

  const res = await fetch(`${WORKER_BASE}/api/ai/parse-ticket`, {
    method: "POST",
    headers: {
      "X-INGEST-KEY": INGEST_KEY,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await res.json().catch(() => null);
  return { res, data };
}

// =======================
// Batch memory (confirm A)
// =======================
const pendingBatches = new Map(); // token -> { telegram_id, book, items:[{extracted, summary_}] }
const mediaGroups = new Map();
const pendingEdits = new Map();
const chatReviewSessions = new Map(); // chat_id -> { telegram_id, book, items, timer }

// Telegram álbum (media_group_id): buffer para processar tudo junto e evitar 3 mensagens de revisão
const pendingMediaGroups = new Map(); // mediaGroupId -> { ctx, messages: [] }
const pendingMediaGroupTimers = new Map();

// Junta todas as fotos enviadas em sequência (mesmo fora de álbum) em UM único "Revisão do lote"
function queueReviewItem(ctx, { telegram_id, chat_id, book_hint, item }) {
  const key = String(chat_id);
  let s = chatReviewSessions.get(key);
  if (!s) {
    s = { telegram_id, chat_id, book: book_hint || "", items: [], timer: null };
    chatReviewSessions.set(key, s);
  }
  // mantém a última casa enviada como "hint" do lote, mas cada item também carrega sua própria casa no resumo
  if (book_hint) s.book = book_hint;
  s.items.push(item);

  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(async () => {
    chatReviewSessions.delete(key);

    const token = genToken();
    // garante que cada item tenha match_date já para exibição/edição
    const itemsWithDate = (s.items || []).map(it => ({ ...it, extracted: ensureExtractedHasDate(it.extracted || {}) }));
    pendingBatches.set(token, {
      telegram_id: s.telegram_id,
      book: s.book,
      items: itemsWithDate,
    });

    const fakeCtx = {
      chat: { id: s.chat_id },
      telegram: ctx.telegram,
      reply: (text, payload) => ctx.telegram.sendMessage(s.chat_id, text, payload),
    };
    try {
      await renderBatchReview(fakeCtx, token, { page: 0 });
    } catch (e) {
      console.error("queueReviewItem render error:", e);
      try { await ctx.telegram.sendMessage(s.chat_id, "❌ Erro ao montar revisão. Tente enviar de novo."); } catch {}
    }
  }, 3000);
}
  // chat_id -> { token, index }
    // key -> { telegram_id, chat_id, book, items, timer }


function summarizeExtracted(x) {
  const event = (x?.event || "").toString().trim();
  const market = (x?.market || "").toString().trim();
  const odd = (x?.odd ?? "").toString().trim();
  const stake = (x?.stake ?? "").toString().trim();
  const sport = (x?.sport || "").toString().trim();
  const book = (x?.book || "").toString().trim();

  let s = `${event || "(sem jogo)"} — ${market || "(sem mercado)"}`;
  // inclui data da partida se presente (match_date no formato YYYY-MM-DD)
  if (x?.match_date) {
    try {
      const parts = String(x.match_date).split("-");
      if (parts.length >= 3) {
        const dd = parts[2].padStart(2, "0");
        const mm = parts[1].padStart(2, "0");
        const yy = parts[0];
        s = `${s} • ${dd}/${mm}/${yy}`;
      } else {
        s = `${s} • ${String(x.match_date)}`;
      }
    } catch (e) {
      s = `${s} • ${String(x.match_date)}`;
    }
  }
  if (odd) s += ` (odd ${odd})`;
  if (stake) s += ` • stake ${stake}`;
  if (sport) s += ` • ${sport}`;
  if (book) s += ` • ${book}`;
  return s;
}

// concise summary for spreadsheet (plain text, minimal)
function summarizeForSheet(x) {
  const event = (x?.event || "").toString().replace(/\\s+/g," ").trim();
  const market = (x?.market || "").toString().replace(/\\s+/g," ").trim();
  const odd = (x?.odd !== undefined && x?.odd !== null && Number.isFinite(Number(x.odd))) ? Number(x.odd).toFixed(2) : null;
  const stake = (x?.stake !== undefined && x?.stake !== null && Number.isFinite(Number(x.stake))) ? Number(x.stake).toFixed(2) : null;
  const sport = (x?.sport || "").toString().trim();
  const book = (x?.book || "").toString().trim();
  const date = x?.match_date || x?.datetime || "";
  let parts = [];
  if (event) parts.push(event);
  if (market) parts.push(market);
  if (odd) parts.push(`odd ${odd}`);
  if (stake) parts.push(`stake ${stake}`);
  if (sport) parts.push(sport);
  if (book) parts.push(book);
  if (date) parts.push(date);
  return parts.join(" • ");
}

// Remove/clean fields that may contain large raw_text / JSON / base64 before displaying
function sanitizeExtractedForDisplay(ex) {
  if (!ex || typeof ex !== "object") return ex;
  const out = { ...ex };
  // remove raw_text to avoid huge blobs
  if (out.raw_text) {
    // keep a tiny hint only
    try {
      const t = String(out.raw_text || "");
      // remove base64 images
      out.raw_text = t.replace(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]");
      // if still too long, truncate
      if (out.raw_text.length > 300) out.raw_text = out.raw_text.slice(0, 280) + "…";
    } catch (e) {
      out.raw_text = "[omitted]";
    }
  }

  // Gentle clean for display: collapse whitespace, unescape common escapes, truncate.
  ["event", "market", "book"].forEach((k) => {
    if (!out[k]) return;
    try {
      let v = String(out[k] || "");
      // remove base64 if ever embedded
      v = v.replace(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]");
      // unescape simple backslashes (but keep textual braces/colons intact)
      v = v.replace(/\\+/g, "");
      // collapse excessive whitespace
      v = v.replace(/\s+/g, " ").trim();
      // limit length for UI but preserve meaningful content
      if (v.length > 500) v = v.slice(0, 500) + "…";
      out[k] = v;
    } catch (e) { /* ignore */ }
  });

  return out;
}

// Prepare a minimal object to send to backend (avoid forwarding raw_text or large fields)
function sanitizeExtractedForPayload(ex) {
  if (!ex || typeof ex !== "object") return {};
  return {
    book: ex.book || null,
    event: ex.event || null,
    market: ex.market || null,
    odd: (ex.odd !== undefined && ex.odd !== null) ? ex.odd : null,
    stake: (ex.stake !== undefined && ex.stake !== null) ? ex.stake : null,
    sport: ex.sport || null,
    match_date: ex.match_date || ex.datetime || null,
  };
}

// Garantir que cada aposta tenha uma data clara antes de enviar ao Worker.
// Regras:
// - Se o objeto extraído já contém `date`, `match_date` ou `day`, tenta parsear e usar no formato YYYY-MM-DD.
// - Se não houver data reconhecível, assume a data de hoje (no timezone do servidor) para evitar lançamentos em dia aleatório.
function ensureExtractedHasDate(ex) {
  const obj = { ...(ex || {}) };
  const tryKeys = ["date", "match_date", "day", "dt"];
  let parsed = null;
  for (const k of tryKeys) {
    if (obj[k]) {
      const v = String(obj[k]);
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        parsed = d;
        break;
      }
      // tenta formatos dd/mm ou dd/mm/yyyy comuns
      const mm = v.match(/(\d{1,2})[\/\-](\d{1,2})([\/\-](\d{2,4}))?/);
      if (mm) {
        let day = parseInt(mm[1], 10);
        let month = parseInt(mm[2], 10) - 1;
        let year = mm[3] ? parseInt(mm[3].replace(/^\D+/,""), 10) : (new Date()).getFullYear();
        if (year < 100) year += 2000;
        const dd = new Date(year, month, day);
        if (!Number.isNaN(dd.getTime())) {
          parsed = dd;
          break;
        }
      }
    }
  }

  if (!parsed) {
    parsed = new Date(); // hoje
  }

  // formata YYYY-MM-DD (sem horário) para o Worker
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  obj.match_date = `${y}-${m}-${d}`;
  return obj;
}

function parseEditForm(text) {
  // Aceita:
  // Casa: ...
  // Descrição: ...
  // Mercado: ...
  // Odd: ...
  // Stake: ...
  // Esporte: ...
  const raw = String(text || "");

  const pick = (label) => {
    const re = new RegExp(`^\s*${label}\s*:\s*(.+?)\s*$`, "im");
    const mm = raw.match(re);
    return mm ? mm[1].trim() : "";
  };

  const out = {};
  const casa = pick("Casa");
  const desc = pick("Descri(?:ção|cao)");
  const mercado = pick("Mercado");
  const odd = pick("Odd");
  const stake = pick("Stake");
  const esporte = pick("Esporte");
  const data = pick("Data");

  if (casa) out.book = casa;
  if (desc) out.event = desc; // usamos event como "descrição/jogo"
  if (mercado) out.market = mercado;
  if (odd) out.odd = Number(String(odd).replace(",", "."));
  if (stake) out.stake = Number(String(stake).replace(",", "."));
  if (esporte) out.sport = esporte;
  if (data) {
    // tenta normalizar para YYYY-MM-DD
    const rawv = data.trim();
    let parsed = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawv)) {
      parsed = new Date(rawv);
    } else {
      const mm = rawv.match(/(\d{1,2})[\/\-](\d{1,2})([\/\-](\d{2,4}))?/);
      if (mm) {
        let day = parseInt(mm[1], 10);
        let month = parseInt(mm[2], 10) - 1;
        let year = mm[3] ? parseInt(mm[3].replace(/^\D+/,""), 10) : (new Date()).getFullYear();
        if (year < 100) year += 2000;
        parsed = new Date(year, month, day);
      }
    }
    if (parsed && !Number.isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      out.match_date = `${y}-${m}-${d}`;
    } else {
      out.match_date = rawv;
    }
  }

  return out;
}

function applyEditToExtracted(original, text) {
  const patch = parseEditForm(text);
  const out = { ...(original || {}) };

  for (const [k, v] of Object.entries(patch)) {
    if (v !== "" && v !== null && v !== undefined && !(Number.isNaN(v) && (k === "odd" || k === "stake"))) {
      out[k] = v;
    }
  }

  // normaliza números caso venham como string
  if (out.odd !== undefined && out.odd !== null) out.odd = Number(String(out.odd).replace(",", "."));
  if (out.stake !== undefined && out.stake !== null) out.stake = Number(String(out.stake).replace(",", "."));

  // book sempre como slug interno
  if (out.book !== undefined && out.book !== null && String(out.book).trim()) {
    out.book = normalizeBook(out.book);
  }

  return out;
}


async function renderBatchReview(ctx, token, opts = {}) {
  const pageSize = 6;
  const page = Math.max(0, Number(opts.page || 0));
  const editMessageId = opts.editMessageId || null;

  const batch = pendingBatches.get(token);
  if (!batch) {
    try { await ctx.answerCbQuery?.("Esse lote expirou."); } catch {}
    return;
  }

  const total = (batch.items || []).length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, pages - 1);
  const start = p * pageSize;
  const end = Math.min(total, start + pageSize);

  const lines = [];
  lines.push(`📌 *Revisão do lote*`);
  lines.push(`🏷️ Casa: *${(batch.book || "—")}*`);
  lines.push(`📦 Itens: *${total}*`);
  lines.push("");
  if (total === 0) {
    lines.push("⚠️ Nenhum item no lote. Envie novas fotos.");
  } else {
    // helper to escape Markdown special chars in dynamic content (we use Markdown)
    function escapeMarkdown(text) {
      if (!text) return "";
      return String(text)
        .replace(/\\/g, "\\\\")
        .replace(/_/g, "\\_")
        .replace(/\*/g, "\\*")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
        .replace(/~/g, "\\~")
        .replace(/`/g, "\\`")
        .replace(/>/g, "\\>")
        .replace(/#/g, "\\#")
        .replace(/\+/g, "\\+")
        .replace(/-/g, "\\-")
        .replace(/=/g, "\\=")
        .replace(/\|/g, "\\|")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/\./g, "\\.")
        .replace(/!/g, "\\!");
    }

    // helper to clean JSON-like dumps from strings
    function cleanField(s) {
      if (!s) return "";
      let t = String(s);
      // remove excessive backslashes
      t = t.replace(/\\+/g, "");
      // remove full {...} JSON blocks
      t = t.replace(/\{[\s\S]*?\}/g, "");
      // remove key:value pairs like "key":"value" or "key":value possibly comma separated
      t = t.replace(/"[^"]+"\s*:\s*"[^"]*"\s*,?/g, "");
      t = t.replace(/"[^"]+"\s*:\s*[^,\s}]+\s*,?/g, "");
      // remove stray quotes and commas left
      t = t.replace(/["{},]/g, " ");
      t = t.replace(/\s+/g, " ").trim();
      return t;
    }

    for (let i = start; i < end; i++) {
      const it = batch.items[i];
      const exRaw = it?.extracted || {};
      // defensive cleaning: remove any embedded JSON dumps in extracted fields
      // DEBUG: log before/after cleaning to trace lost fields
      try { console.log("DEBUG render: exRaw:", JSON.stringify(exRaw).slice(0,2000)); } catch(e){}
      // Try to recover fields if worker returned embedded JSON inside strings
      function tryParseEmbeddedJson(s) {
        try {
          if (!s || typeof s !== "string") return null;
          const m = s.match(/\{[\s\S]*\}/);
          if (!m) return null;
          const parsed = JSON.parse(m[0]);
          return parsed;
        } catch (e) { return null; }
      }

      // prefer the worker's extracted fields as-is; attempt to recover if empty
      let ex = sanitizeExtractedForDisplay(exRaw);
      try { console.log("DEBUG render: after sanitize:", JSON.stringify(ex).slice(0,2000)); } catch(e){}

      // If event/market/book are missing, try to parse them from raw_text if it contains JSON
      if ((!ex.event || String(ex.event).trim() === "") && ex.raw_text) {
        const fromJson = tryParseEmbeddedJson(ex.raw_text) || tryParseEmbeddedJson(String(exRaw.event || ""));
        if (fromJson) {
          ex.event = ex.event || fromJson.event || exRaw.event || ex.event;
          ex.market = ex.market || fromJson.market || exRaw.market || ex.market;
          ex.book = ex.book || fromJson.book || exRaw.book || ex.book;
        }
      }
      // conservative cleanup: only strip obvious JSON blocks, keep normal text intact
      ex.event = (ex.event && String(ex.event).replace(/\{[\s\S]*\}/g, "").replace(/\\+/g, "").trim()) || ex.event;
      ex.market = (ex.market && String(ex.market).replace(/\{[\s\S]*\}/g, "").replace(/\\+/g, "").trim()) || ex.market;
      ex.book = (ex.book && String(ex.book).replace(/\{[\s\S]*\}/g, "").replace(/\\+/g, "").trim()) || ex.book;
      // DEBUG: show raw extracted JSON above the rendered card for visibility
      try {
        const rawJson = JSON.stringify(exRaw, null, 2);
        lines.push("```json\n" + rawJson.slice(0,1200) + (rawJson.length > 1200 ? "\n…(truncated)" : "") + "\n```");
      } catch (e) {}

      // no sheet_summary: prefer only dynamic summary from extracted if needed
      const single = it?.summary_ || summarizeForSheet(exRaw) || "";
      const title = `${ex.book ? `${ex.book} • ` : ""}${ex.event || "(sem jogo)"}`;
      const market = ex.market || "";
      // date display helper
      function formatDisplayDateLocal(e) {
        try {
          if (e.match_date) {
            const parts = String(e.match_date).split("-");
            if (parts.length >= 3) return `${parts[2].padStart(2,"0")}/${parts[1].padStart(2,"0")}/${parts[0]}`;
          }
          if (e.datetime) {
            const d = new Date(e.datetime);
            if (!isNaN(d.getTime())) {
              const date = d.toLocaleDateString("pt-BR");
              const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
              return `${date} ${time}`;
            }
          }
        } catch (e) {}
        return "";
      }
      const dateDisplay = formatDisplayDateLocal(ex);
      const odd = (ex.odd !== undefined && ex.odd !== null) ? Number(ex.odd).toFixed(2) : "";
      const stake = (ex.stake !== undefined && ex.stake !== null) ? Number(ex.stake).toFixed(2) : "";
      const sport = ex.sport || "";

      // build formatted block exactly like requested (Portuguese labels, emojis)
      let block = `*${i + 1})* ${escapeMarkdown(title)}\n`;
      // status (default Pendente)
      block += `⏳ Status: Pendente\n`;
      // simple note placeholder for profit
      block += `🔷 Sem lucro ou prejuízo.\n`;
      // esporte
      block += `⚽ Esporte: ${escapeMarkdown(sport || "Futebol")}\n`;
      // aposta / mercado
      const apostaLabel = (market && market.length > 0) ? market : (ex.event || "—");
      block += `🎲 Aposta: ${escapeMarkdown(apostaLabel)}\n`;
      block += `🎯 Mercado: ${escapeMarkdown(market || "—")}\n`;
      // values
      const money = (v) => {
        try { return moneyBR(Number(v || 0)); } catch { return String(v || "0"); }
      };
      block += `💰 Valor Apostado: ${money(stake)}\n`;
      block += `🔵 Odd: ${escapeMarkdown(odd || "")}\n`;
      // potential return = stake * odd (total)
      let potential = "";
      try {
        if (Number.isFinite(Number(odd)) && Number.isFinite(Number(stake))) {
          potential = money(Number(odd) * Number(stake));
        }
      } catch (e) {}
      block += `📈 Retorno Potencial: ${potential || money(0)}\n`;
      // (Tipo removido)
      // date and time separate
      if (ex.datetime) {
        try {
          const dt = new Date(ex.datetime);
          if (!isNaN(dt.getTime())) {
            const dd = dt.toLocaleDateString("pt-BR");
            const tt = dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
            block += `📅 Data: ${escapeMarkdown(dd)}\n`;
            block += `⏱ Hora: ${escapeMarkdown(tt)}\n`;
          } else {
            block += `📅 Data: Definir Manualmente\n`;
            block += `⏱ Hora: Definir Manualmente\n`;
          }
        } catch (e) {
          block += `📅 Data: Definir Manualmente\n`;
          block += `⏱ Hora: Definir Manualmente\n`;
        }
      } else {
        block += `📅 Data: Definir Manualmente\n`;
        block += `⏱ Hora: Definir Manualmente\n`;
      }
      // push block
      lines.push(block);
    }
  }
  if (pages > 1) lines.push(`\nPágina ${p + 1}/${pages}`);

  const kb = [];

  if (total > 0) {
    for (let i = start; i < end; i++) {
      kb.push([{ text: `🗑 Remover ${i + 1}`, callback_data: `remove:${token}:${i}` }]);
    }
    kb.push([{ text: "✏️ Editar", callback_data: `edit:${token}` }]);
  }

  const nav = [];
  if (pages > 1 && p > 0) nav.push({ text: "⬅️", callback_data: `review:${token}:${p - 1}` });
  if (pages > 1 && p < pages - 1) nav.push({ text: "➡️", callback_data: `review:${token}:${p + 1}` });
  if (nav.length) kb.push(nav);

  kb.push([{ text: "✅ Confirmar lote", callback_data: `confirm:${token}` }]);
  kb.push([{ text: "❌ Cancelar", callback_data: `cancel:${token}` }]);

  const payload = {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: kb },
  };

  // tenta editar a mensagem existente (melhor UX)
  try {
    if (editMessageId && ctx.telegram && ctx.chat?.id) {
      await ctx.telegram.editMessageText(ctx.chat.id, editMessageId, null, lines.join("\n"), payload);
      batch.review_message_id = editMessageId;
      return;
    }
    if (typeof ctx.editMessageText === "function" && ctx.updateType === "callback_query") {
      await ctx.editMessageText(lines.join("\n"), payload);
      const msgId = ctx.callbackQuery?.message?.message_id;
      if (msgId) batch.review_message_id = msgId;
      return;
    }
  } catch (e) {
    // cai para reply
  }

  const msg = await ctx.reply(lines.join("\n"), payload);
  batch.review_message_id = msg.message_id;
}

async function sendConfirmMessage(ctx, book, items, token) {
  // Compat: agora usamos a revisão visual
  try { pendingBatches.set(token, { ...(pendingBatches.get(token) || {}), book, items }); } catch {}
  return renderBatchReview(ctx, token, { page: 0 });
}

// =======================
// Commands
// =======================
bot.start(async (ctx) => {
  await ctx.reply(
`✅ BagresPlanilhador conectado!

1) Para vincular sua conta do site:
• Gere o código no site (Perfil → Vincular Telegram)
• Depois envie aqui: /vincular 123456

2) Depois de vinculado:
• +30 betano
• -50 bet365

📸 Para lançar por bilhete:
Envie a foto do bilhete com a legenda = nome da casa (ex: "esportiva").`
  );
});

// /vincular 123456
bot.command("vincular", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const code = parts[1];

    if (!code || !/^\d{6}$/.test(code)) {
      await ctx.reply("❌ Use assim: /vincular 123456 (6 dígitos)");
      return;
    }

    const telegram_id = String(ctx.from?.id || "").trim();
    const telegram_username = String(ctx.from?.username || "").trim();

    await ingestTelegram({
      kind: "link",
      code,
      telegram_id,
      telegram_username,
    });

    await ctx.reply("✅ Telegram vinculado com sucesso! Agora pode mandar: +30 betano");
  } catch (e) {
    await ctx.reply(`❌ Erro ao vincular: ${e.message}`);
  }
});

// /debug <audit_id> - retorna registro de auditoria do Worker (raw_text + parsed_json)
bot.command("debug", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const id = parts[1];
    if (!id) {
      await ctx.reply("Use: /debug <audit_id>");
      return;
    }
    await ctx.reply("🔎 Buscando audit_id...");
    const res = await fetch(`${WORKER_BASE}/api/admin/ticket_audit?id=${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { "X-INGEST-KEY": INGEST_KEY }
    });
    const data = await res.json().catch(()=>null);
    if (!res.ok) {
      await ctx.reply(`❌ Erro: ${data?.message || `HTTP ${res?.status}`}`);
      return;
    }
    const audit = data.audit;
    if (!audit) {
      await ctx.reply("❌ Audit não encontrado.");
      return;
    }
    // Format nicely
    const lines = [];
    lines.push(`🧾 Audit ID: ${audit.id}`);
    if (audit.telegram_id) lines.push(`👤 Telegram: ${audit.telegram_id}`);
    if (audit.chat_id) lines.push(`💬 Chat: ${audit.chat_id}`);
    if (audit.message_id) lines.push(`✉️ Message: ${audit.message_id}`);
    if (audit.created_at) lines.push(`🕒 Criado em: ${audit.created_at}`);
    if (audit.image_name) lines.push(`🖼 Imagem: ${audit.image_name} (${audit.image_type || ""}, ${audit.image_size || 0} bytes)`);
    lines.push("");
    if (audit.parsed_json) {
      try {
        const parsed = JSON.parse(audit.parsed_json);
        lines.push("🔬 Parsed JSON:");
        lines.push("```json");
        lines.push(JSON.stringify(parsed, null, 2).slice(0, 1500));
        lines.push("```");
      } catch (e) {
        lines.push("🔬 Parsed (raw):");
        lines.push("```");
        lines.push(String(audit.parsed_json).slice(0, 1500));
        lines.push("```");
      }
    }
    if (audit.raw_text) {
      lines.push("");
      lines.push("📋 Raw text (excerto):");
      lines.push("```");
      lines.push(String(audit.raw_text).slice(0, 1000));
      lines.push("```");
    }

    // send as chunked messages if long
    const msg = lines.join("\n");
    if (msg.length > 4000) {
      // split
      for (let i = 0; i < msg.length; i += 3500) {
        await ctx.reply(msg.slice(i, i + 3500), { parse_mode: "Markdown" }).catch(()=>{});
      }
    } else {
      await ctx.reply(msg, { parse_mode: "Markdown" });
    }
  } catch (e) {
    console.error("debug command error:", e);
    await ctx.reply(`❌ Erro ao buscar audit: ${e.message || e}`);
  }
});

// =======================
// Wallet (+/-)
// =======================
bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (text.startsWith("/")) return;

  // se está em modo edição de bilhete (EDITAR = formulário numa única mensagem)
  const chatKey = `${ctx.chat?.id}:${ctx.from?.id}`;
  const pe = pendingEdits.get(chatKey);
  if (pe) {
    // só aceita se for resposta ao "formulário" que o bot mandou
    const repliedId = ctx.message?.reply_to_message?.message_id;
    if (!repliedId || repliedId !== pe.reply_to) return;


    // Edição por campo (botões)
    if (pe.mode === "field") {
      const batch = pendingBatches.get(pe.token);
      const item = batch?.items?.[pe.index];
      if (!batch || !item) return;

      const raw = (text || "").trim();
      const val = raw === "-" ? "" : raw;

      const ex = item.extracted || {};
      switch (pe.field) {
        case "book":
          ex.book = val ? normalizeBook(val) : "";
          break;
        case "event":
          ex.event = val;
          break;
        case "market":
          ex.market = val;
          break;
        case "date":
          {
            // aceita dd/mm[/yyyy] ou yyyy-mm-dd
            const rawv = val.trim();
            let parsed = null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(rawv)) {
              parsed = new Date(rawv);
            } else {
              const mm = rawv.match(/(\d{1,2})[\/\-](\d{1,2})([\/\-](\d{2,4}))?/);
              if (mm) {
                let day = parseInt(mm[1], 10);
                let month = parseInt(mm[2], 10) - 1;
                let year = mm[3] ? parseInt(mm[3].replace(/^\D+/,""), 10) : (new Date()).getFullYear();
                if (year < 100) year += 2000;
                parsed = new Date(year, month, day);
              }
            }
            if (parsed && !Number.isNaN(parsed.getTime())) {
              const y = parsed.getFullYear();
              const m = String(parsed.getMonth() + 1).padStart(2, "0");
              const d = String(parsed.getDate()).padStart(2, "0");
              ex.match_date = `${y}-${m}-${d}`;
            } else {
              // se valor inválido, armazena raw
              ex.match_date = rawv;
            }
          }
          break;
        case "odd":
          ex.odd = val ? Number(String(val).replace(",", ".")) : null;
          break;
        case "stake":
          ex.stake = val ? Number(String(val).replace(",", ".")) : null;
          break;
        case "sport":
          ex.sport = val;
          break;
        default:
          ex.event = val;
      }

      item.extracted = ex;
      item.summary_ = summarizeExtracted(ex);

      pendingEdits.delete(chatKey);
      if (pe.reply_to) try { await ctx.telegram.deleteMessage(ctx.chat.id, pe.reply_to); } catch {}
      await ctx.reply(`✅ Salvo com sucesso.`);
      await renderBatchReview(ctx, pe.token, { page: 0, editMessageId: batch?.review_message_id });
      return;
    }

    const batch = pendingBatches.get(pe.token);
    if (!batch || !batch.items[pe.index]) {
      pendingEdits.delete(chatKey);
      await ctx.reply("⚠️ Não achei esse lote/item. Tente enviar a foto de novo.");
      return;
    }

    const cur = batch.items[pe.index].extracted || {};
    const updated = applyEditToExtracted(cur, text);

    batch.items[pe.index].extracted = updated;
    batch.items[pe.index].summary_ = summarizeExtracted(updated);

    pendingEdits.delete(chatKey);
    await ctx.reply("✅ Atualizado! Vou te mostrar o lote atualizado:");
    await renderBatchReview(ctx, pe.token, { page: 0, editMessageId: batch?.review_message_id });
    return;
  }

  const m = text.match(/^([+-])\s*([\d.,]+)\s+([a-zA-Z0-9._-]{2,})$/);
  if (!m) return;

  const sign = m[1];
  const amount = parseMoney(m[2]);
  const book = normalizeBook(m[3]);

  if (!amount || amount <= 0) {
    await ctx.reply("❌ Valor inválido.");
    return;
  }

  const telegram_id = String(ctx.from?.id || "").trim();
  const telegram_username = String(ctx.from?.username || "").trim();
  const type = sign === "+" ? "deposit" : "withdraw";

  try {
    await ingestTelegram({
      kind: "wallet",
      telegram_id,
      telegram_username,
      type,
      amount,
      book,
      note: `telegram:${telegram_id}`,
      source: `telegram:${telegram_id}`,
    });

    const action = type === "deposit" ? "DEPÓSITO" : "SAQUE";
    await ctx.reply(`💰 ${action} ${moneyBR(amount)} em ${book}`);
  } catch (e) {
    await ctx.reply(`❌ Erro ao registrar: ${e.message}`);
  }
});

// =======================
// Photo -> AI -> list -> confirm
// =======================
bot.on("photo", async (ctx) => {
  try {
    const telegram_id = String(ctx.from?.id || "").trim();
    const chat_id = String(ctx.chat?.id || "").trim();
    const caption = String(ctx.message.caption || "").trim();
    const book_hint = caption && /[A-Za-zÀ-ÿ]/.test(caption) ? normalizeBook(caption) : "";

    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best?.file_id) {
      await ctx.reply("❌ Não achei o file_id da imagem.");
      return;
    }

    const media_group_id = ctx.message.media_group_id ? String(ctx.message.media_group_id) : null;

    const processMessage = async (msg, hint, telegramCtx) => {
      const photosM = msg.photo || [];
      const bestM = photosM[photosM.length - 1];
      if (!bestM?.file_id) return null;
      const linkM = await telegramCtx.telegram.getFileLink(bestM.file_id);
      const captionText = String(msg.caption || "").trim();
      const { res, data } = await sendImageToWorker({
        telegram_id,
        chat_id,
        fileUrl: linkM.href,
        filename: "ticket.jpg",
        book_hint: hint,
        caption: captionText,
      });
      if (!res.ok) {
        if (data?.code === "NOT_LINKED") {
          await telegramCtx.reply("⚠️ Seu Telegram não está vinculado. Use /vincular 123456.");
          return null;
        }
        await telegramCtx.reply(`❌ Erro no Worker (${res.status}): ${data?.message || "Falha ao ler bilhete."}`);
        return null;
      }
      return data;
    };

    if (media_group_id) {
      const entry = pendingMediaGroups.get(media_group_id) || { ctx, messages: [] };
      entry.ctx = ctx;
      entry.messages.push({ msg: ctx.message, hint: book_hint });
      pendingMediaGroups.set(media_group_id, entry);
      clearTimeout(pendingMediaGroupTimers.get(media_group_id));
      const t = setTimeout(async () => {
        const entry = pendingMediaGroups.get(media_group_id);
        pendingMediaGroups.delete(media_group_id);
        pendingMediaGroupTimers.delete(media_group_id);
        const telegramCtx = entry?.ctx || ctx;
        try {
          if (!entry?.messages?.length) return;
          try { await telegramCtx.reply("🧠 Lendo lote..."); } catch {}

          const bookHint = entry.messages[0]?.hint || "";
          const items = [];
          for (const { msg, hint } of entry.messages) {
            try {
              const r = await processMessage(msg, hint || bookHint, telegramCtx);
              if (r && r.extracted) items.push({ extracted: r.extracted, summary_: summarizeExtracted(r.extracted || {}) });
            } catch (e) {
              console.error("mediaGroup item error:", e);
              await telegramCtx.reply(`❌ Erro em uma foto do lote: ${e.message || "tente de novo."}`).catch(() => {});
            }
          }
          if (!items.length) {
            await telegramCtx.reply("❌ Não consegui ler esse lote. Tente fotos mais nítidas ou envie uma por vez.");
            return;
          }
          const token = genToken();
          const itemsWithDate = (items || []).map(it => ({ ...it, extracted: ensureExtractedHasDate(it.extracted || {}) }));
          pendingBatches.set(token, {
            telegram_id: telegramCtx.from.id,
            chat_id: telegramCtx.chat.id,
            book: bookHint,
            items: itemsWithDate,
            review_message_id: null,
          });
          await renderBatchReview(telegramCtx, token);
        } catch (e) {
          console.error("mediaGroup timeout error:", e);
          try { await telegramCtx.reply("❌ Erro ao processar o lote. Tente enviar as fotos de novo (uma por vez ou em álbum)."); } catch {}
        }
      }, 900);
      pendingMediaGroupTimers.set(media_group_id, t);
      return;
    }

    await ctx.reply("🔄 Processando bilhete...").catch(() => {});
    const one = await processMessage(ctx.message, book_hint, ctx);
    if (!one) return;

    // DEBUG: enviar ao chat o response bruto do Worker para investigação
    try {
      const safeJson = (obj) => {
        try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
      };
      // log no console para servidor
      console.log("DEBUG: worker response (truncated):", safeJson(one).slice(0, 4000));
      // enviar mensagem de debug ao usuário (truncada)
      const snippet = safeJson(one).slice(0, 1500);
      if (!one.extracted) {
        await ctx.reply("🔍 DEBUG: Worker não retornou `extracted`. Mostrando resposta parcial:", { parse_mode: "Markdown" }).catch(()=>{});
        await ctx.reply("```json\n" + snippet + (snippet.length >= 1500 ? "\n…(truncated)" : "") + "\n```", { parse_mode: "Markdown" }).catch(()=>{});
      } else {
        const exSnippet = safeJson(one.extracted).slice(0, 1500);
        await ctx.reply("🔍 DEBUG: `extracted` recebido (excerpt):", { parse_mode: "Markdown" }).catch(()=>{});
        await ctx.reply("```json\n" + exSnippet + (exSnippet.length >= 1500 ? "\n…(truncated)" : "") + "\n```", { parse_mode: "Markdown" }).catch(()=>{});
      }
    } catch (e) {
      console.error("DEBUG send error:", e);
    }

    // Auto-save if single item has high confidence
    try {
      const conf = (one.extracted && one.extracted.confidence && Number(one.extracted.confidence.overall)) ? Number(one.extracted.confidence.overall) : 0;
      if (conf >= 0.85) {
        // prepare payload and send to Worker directly
        const exRaw = ensureExtractedHasDate(one.extracted || {});
        const ex = sanitizeExtractedForPayload(exRaw);
        const payload = {
          kind: "bets_create",
          telegram_id,
          items: [{
            book: ex.book || null,
            event: ex.event || null,
            market: ex.market || null,
            odd: ex.odd !== undefined ? ex.odd : null,
            stake: ex.stake !== undefined ? ex.stake : null,
            sport: ex.sport || null,
            datetime: ex.match_date || ex.datetime || null,
          }],
        };
        try {
          await ctx.reply("✅ Confiança alta — gravando automaticamente...").catch(()=>{});
          const res = await ingestTelegram(payload);
          await ctx.reply(`✅ Gravado automaticamente!`).catch(()=>{});
          return;
        } catch (e) {
          console.error("auto-save error:", e);
          // fallthrough to normal review flow if auto-save failed
        }
      }
    } catch (e) { /* ignore */ }

    queueReviewItem(ctx, {
      telegram_id,
      chat_id,
      book_hint,
      item: { extracted: one.extracted, summary_: summarizeExtracted(one.extracted || {}) },
    });
  } catch (e) {
    console.error("photo handler error:", e);
    try { await ctx.reply("❌ Erro ao processar foto. Tente de novo ou envie com legenda (ex: betano)."); } catch {}
  }
});

// Imagem enviada como arquivo (documento) — mesmo fluxo do bilhete
bot.on("document", async (ctx) => {
  const doc = ctx.message?.document;
  if (!doc?.file_id) return;
  const mime = (doc.mime_type || "").toLowerCase();
  if (!mime.startsWith("image/")) return;
  try {
    await ctx.reply("🔄 Processando bilhete...").catch(() => {});
    const telegram_id = String(ctx.from?.id || "").trim();
    const chat_id = String(ctx.chat?.id || "").trim();
    const caption = String(ctx.message?.caption || "").trim();
    const book_hint = caption && /[A-Za-zÀ-ÿ]/.test(caption) ? normalizeBook(caption) : "";
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const captionText = String(ctx.message?.caption || "").trim();
    const { res, data } = await sendImageToWorker({
      telegram_id,
      chat_id,
      fileUrl: link.href,
      filename: doc.file_name || "ticket.jpg",
      book_hint,
      caption: captionText,
    });
    if (!res.ok) {
      if (data?.code === "NOT_LINKED") {
        await ctx.reply("⚠️ Seu Telegram não está vinculado. Use /vincular 123456.");
        return;
      }
      await ctx.reply(`❌ Erro no Worker (${res.status}): ${data?.message || "Falha ao ler bilhete."}`);
      return;
    }
    if (!data?.extracted) {
      await ctx.reply("❌ Não consegui ler o bilhete. Envie como foto (não como arquivo) ou tente outra imagem.");
      return;
    }
    const summary = summarizeExtracted(data.extracted || {});
    queueReviewItem(ctx, {
      telegram_id,
      chat_id,
      book_hint,
      item: { extracted: data.extracted, summary_: summary },
    });
  } catch (e) {
    console.error("document (image) handler error:", e);
    try { await ctx.reply("❌ Erro ao processar imagem. Tente enviar como foto (câmera/galeria) com legenda da casa."); } catch {}
  }
});

// edit:token — foto única: mostra campos direto; lote: mostra Aposta 1, Aposta 2...
bot.action(/^review:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const page = Number(ctx.match[2]);
    const batch = pendingBatches.get(token);
    if (!batch) {
      await ctx.answerCbQuery("Esse lote expirou.");
      return;
    }
    await ctx.answerCbQuery("");
    await renderBatchReview(ctx, token, { page, editMessageId: batch.review_message_id });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

// editpick deve vir antes de edit para o regex não engolir editpick:token:index
bot.action(/^editpick:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const batch = pendingBatches.get(token);
    if (!batch || !batch.items?.[index]) {
      await ctx.answerCbQuery("Esse item expirou.");
      return;
    }
    await ctx.answerCbQuery("Editar");
    await sendFieldButtonsEdit(ctx, token, index);
  } catch (e) {
    console.error("editpick action error", e);
    try { await ctx.answerCbQuery("Erro."); } catch {}
  }
});

bot.action(/^edit:(.+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1].trim();
    if (!token) return ctx.answerCbQuery("Token inválido.");
    const batch = pendingBatches.get(token);
    if (!batch || !batch.items?.length) {
      await ctx.answerCbQuery("Esse lote expirou.");
      return;
    }
    await ctx.answerCbQuery("Editar");

    const total = batch.items.length;

    if (total === 1) {
      await sendFieldButtonsEdit(ctx, token, 0);
      return;
    }

    const rows = [];
    for (let i = 0; i < total; i++) {
      rows.push([Markup.button.callback(`Aposta ${i + 1}`, `editpick:${token}:${i}`)]);
    }
    rows.push([Markup.button.callback("⬅️ Voltar", `eback:${token}`)]);
    await ctx.editMessageText("✏️ Qual aposta deseja editar?", {
      reply_markup: { inline_keyboard: rows },
    });
  } catch (e) {
    console.error("edit action error", e);
    try { await ctx.answerCbQuery("Erro ao abrir edição."); } catch {}
  }
});

function sendFieldButtonsEdit(ctx, token, index) {
  const rows = [
    [
      Markup.button.callback("🏷️ Casa", `ef:${token}:${index}:book`),
      Markup.button.callback("🧾 Descrição", `ef:${token}:${index}:event`),
    ],
    [
      Markup.button.callback("📌 Mercado", `ef:${token}:${index}:market`),
      Markup.button.callback("📈 Odds", `ef:${token}:${index}:odd`),
    ],
    [
      Markup.button.callback("💰 Stake", `ef:${token}:${index}:stake`),
      Markup.button.callback("🏅 Esporte", `ef:${token}:${index}:sport`),
    ],
    [
      Markup.button.callback("📅 Data", `ef:${token}:${index}:date`),
    ],
    [Markup.button.callback("⬅️ Voltar", `eback:${token}`)],
  ];
  return ctx.editMessageText("✏️ Escolha o campo para editar:", {
    reply_markup: { inline_keyboard: rows },
  });
}

bot.action(/^eback:(.+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const batch = pendingBatches.get(token);
    if (batch) await renderBatchReview(ctx, token, { page: 0, editMessageId: batch.review_message_id });
    try { await ctx.answerCbQuery("Ok"); } catch {}
  } catch (e) {
    console.error("eback error", e);
  }
});


const EDIT_FIELD_UI = {
  book:   { label: "Casa",      prompt: "Qual é o nome da casa de apostas?" },
  stake:  { label: "Stake",     prompt: "Qual valor da sua stake?" },
  event:  { label: "Descrição", prompt: "Qual a descrição correta da aposta?" },
  market: { label: "Mercado",   prompt: "Qual mercado? (ex: Ambas marcam, Over 2.5, ML)" },
  odd:    { label: "Odds",      prompt: "Qual a odd?" },
  sport:  { label: "Esporte",   prompt: "Qual esporte? (Futebol, NBA, Tênis...)" },
  date:   { label: "Data",      prompt: "Qual a data do jogo? (dd/mm/aaaa ou yyyy-mm-dd)" },
};

function fieldLabel(field) {
  return (EDIT_FIELD_UI[field] && EDIT_FIELD_UI[field].label) ? EDIT_FIELD_UI[field].label : field;
}

function fieldPrompt(field) {
  const ui = EDIT_FIELD_UI[field];
  if (!ui) return `✏️ ${field}\nDigite o novo valor.`;
  return `✏️ ${ui.label}\n${ui.prompt}`;
}

bot.action(/^ef:(.+):(\d+):([a-z_]+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const field = String(ctx.match[3]);

    const batch = pendingBatches.get(token);
    if (!batch || !batch.items || !batch.items[index]) {
      await ctx.answerCbQuery("Esse item expirou.");
      return;
    }

    const label = ({
      book: "Casa",
      event: "Descrição",
      market: "Mercado",
      odd: "Odd",
      stake: "Stake",
      sport: "Esporte",
      date: "Data",
    })[field] || field;

    await ctx.answerCbQuery(`Editar: ${label}`);

    const chatId = ctx.chat?.id;
    const telegram_id = ctx.from?.id;
    if (!chatId || !telegram_id) return;

    const key = `${chatId}:${telegram_id}`;
    const promptText = fieldPrompt(field) + "\n\n(Envie o valor ou - para limpar)";
    // envia mensagem pedindo reply (force_reply) para facilitar captura
    const promptMsg = await ctx.reply(promptText, { parse_mode: "Markdown", reply_markup: { force_reply: true } });
    pendingEdits.set(key, { token, index, mode: "field", field, reply_to: promptMsg.message_id });
  } catch (e) {
    console.error("ef action error", e);
    try { await ctx.answerCbQuery("Erro ao iniciar edição."); } catch {}
  }
});

bot.action(/^efback:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const key = `${ctx.chat?.id}:${ctx.from?.id}`;
    pendingEdits.delete(key);
    await ctx.answerCbQuery("Ok");
    await sendFieldButtonsEdit(ctx, token, index);
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

bot.action(/^remove:(.+):(\d+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const index = Number(ctx.match[2]);
    const batch = pendingBatches.get(token);
    if (!batch) { await ctx.answerCbQuery("Esse lote expirou."); return; }
    if (!batch.items || !batch.items[index]) { await ctx.answerCbQuery("Item inválido."); return; }

    batch.items.splice(index, 1);
    batch.items.forEach((it) => {
      it.summary_line = it.summary_line || summarizeExtracted(it.extracted || {});
    });

    await ctx.answerCbQuery("Removido");
    await renderBatchReview(ctx, token, { page: 0, editMessageId: batch.review_message_id });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
  }
});

// =======================
// Confirm / Cancel actions
// =======================
bot.action(/^confirm:(.+)$/i, async (ctx) => {
  const token = (ctx.match[1] || "").trim();
  const batch = token ? pendingBatches.get(token) : null;

  try {
    if (!batch) {
      await ctx.answerCbQuery("Esse lote expirou.");
      return;
    }

    await ctx.answerCbQuery("Verificando confiança...");
    // checa se alguma aposta não tem esporte
    // Evaluate confidences
    const items = batch.items || [];
    const confidences = items.map((it) => (it.extracted && it.extracted.confidence && it.extracted.confidence.overall) ? Number(it.extracted.confidence.overall) : 0.0);
    const anyLow = confidences.some(c => c < 0.6);
    const anyMedium = confidences.some(c => c >= 0.6 && c < 0.85);
    const allHigh = confidences.every(c => c >= 0.85);

    if (allHigh) {
      // safe to auto-save
      await ctx.answerCbQuery("Confiança alta — gravando...");
      pendingBatches.delete(token); // avoid double submit
      // build payload and send (same as previous behavior)
      const payload = {
        kind: "bets_create",
        telegram_id: batch.telegram_id,
        items: (batch.items || []).map((x) => {
          const exRaw = ensureExtractedHasDate(x.extracted || {});
          const ex = sanitizeExtractedForPayload(exRaw);
          return {
            book: ex.book || null,
            event: ex.event || null,
            market: ex.market || null,
            odd: ex.odd !== undefined ? ex.odd : null,
            stake: ex.stake !== undefined ? ex.stake : null,
            sport: ex.sport || null,
            datetime: ex.match_date || ex.datetime || null,
          };
        }),
      };
      const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-INGEST-KEY": INGEST_KEY },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      const msg = data?.message || data?.error || (res.ok ? null : `HTTP ${res.status}`);
      const noButtons = { reply_markup: { inline_keyboard: [] } };
      if (!res.ok) {
        await ctx.editMessageText(`❌ Não foi possível gravar.`, noButtons);
        await ctx.reply(`❌ Erro: ${msg || "Tente de novo mais tarde."}`);
        return;
      }
      const okCount = (data.results || []).filter((r) => r.ok).length;
      const failCount = (data.results || []).filter((r) => !r.ok).length;
      const text = failCount > 0
        ? `✅ Gravado!\nOK: ${okCount}\nFalhas: ${failCount}`
        : `✅ Lote gravado com sucesso! (${okCount} aposta${okCount !== 1 ? "s" : ""})`;
      await ctx.editMessageText(text, noButtons);
      return;
    }

    if (anyLow) {
      // open field-by-field review for first low-confidence item
      const idx = confidences.findIndex(c => c < 0.6);
      await ctx.editMessageText(`🛠 Revisão necessária: item #${idx+1} com baixa confiança. Abrindo edição...`, { reply_markup: { inline_keyboard: [] } });
      await sendFieldButtonsEdit(ctx, token, idx);
      return;
    }

    if (anyMedium) {
      // prompt user: confirm anyway or edit
      const kb = [
        [ { text: "✅ Confirmar mesmo assim", callback_data: `force_confirm:${token}` }, { text: "✏️ Editar", callback_data: `edit:${token}` } ],
      ];
      await ctx.editMessageText(`⚠️ Alguns itens têm confiança média. Deseja confirmar mesmo assim ou editar?`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
      return;
    }

    // fallback
    await ctx.editMessageText("Não foi possível determinar ação. Use Editar.", { reply_markup: { inline_keyboard: [] } });
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
    await ctx.reply(`❌ Falha ao gravar: ${e.message || "Erro inesperado. Tente de novo."}`);
  }
});

bot.action(/^cancel:(.+)$/i, async (ctx) => {
  const token = ctx.match[1];
  pendingBatches.delete(token);
  await ctx.answerCbQuery("Cancelado");
  try {
    await ctx.editMessageText("❌ Lote cancelado.", { reply_markup: { inline_keyboard: [] } });
  } catch {}
});

// Force confirm (used when medium confidence and user wants to save anyway)
bot.action(/^force_confirm:(.+)$/i, async (ctx) => {
  try {
    const token = ctx.match[1];
    const batch = pendingBatches.get(token);
    if (!batch) { await ctx.answerCbQuery("Lote expirou."); return; }
    await ctx.answerCbQuery("Confirmando (forçado)...");
    pendingBatches.delete(token);
    const payload = {
      kind: "bets_create",
      telegram_id: batch.telegram_id,
      items: (batch.items || []).map((x) => {
        const exRaw = ensureExtractedHasDate(x.extracted || {});
        const ex = sanitizeExtractedForPayload(exRaw);
        return {
          book: ex.book || null,
          event: ex.event || null,
          market: ex.market || null,
          odd: ex.odd !== undefined ? ex.odd : null,
          stake: ex.stake !== undefined ? ex.stake : null,
          sport: ex.sport || null,
          datetime: ex.match_date || ex.datetime || null,
        };
      }),
    };
    const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-INGEST-KEY": INGEST_KEY },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    const noButtons = { reply_markup: { inline_keyboard: [] } };
    if (!res.ok) {
      await ctx.editMessageText(`❌ Não foi possível gravar.`, noButtons);
      await ctx.reply(`❌ Erro: ${data?.message || data?.error || `HTTP ${res.status}`}`);
      return;
    }
    const okCount = (data.results || []).filter((r) => r.ok).length;
    const text = `✅ Lote gravado (forçado). (${okCount} aposta${okCount !== 1 ? "s" : ""})`;
    await ctx.editMessageText(text, noButtons);
  } catch (e) {
    try { await ctx.answerCbQuery("Erro"); } catch {}
    await ctx.reply(`❌ Falha ao confirmar forçado: ${e.message || "Erro inesperado."}`);
  }
});

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// =======================
// Webhook server (resolve 409)
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "bagres").trim();
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;

const server = http.createServer((req, res) => {
  if (req.url === webhookPath && req.method === "POST") {
    return bot.webhookCallback(webhookPath)(req, res);
  }
  res.statusCode = 200;
  res.end("ok");
});

server.listen(PORT, () => {
  console.log(`🌐 Webhook server on :${PORT} path=${webhookPath}`);
});

// setWebhook em segundo plano (falha não derruba o processo)
(async () => {
  if (!PUBLIC_URL) return;
  try {
    await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`);
    console.log("✅ Webhook set:", `${PUBLIC_URL}${webhookPath}`);
  } catch (e) {
    console.error("❌ Falha ao setWebhook:", e);
  }
})();
