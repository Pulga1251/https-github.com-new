import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WORKER_BASE = (process.env.WORKER_BASE || "").replace(/\/+$/, "");
const INGEST_KEY = String(process.env.INGEST_KEY || "").replace(/[\r\n\t]/g, "").trim();

if (!BOT_TOKEN) throw new Error("Faltou BOT_TOKEN.");
if (!WORKER_BASE) throw new Error("Faltou WORKER_BASE.");
if (!INGEST_KEY) throw new Error("Faltou INGEST_KEY.");

const bot = new Telegraf(BOT_TOKEN);

function parseMoney(s) {
  const n = Number(String(s || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normalizeBook(s) {
  return String(s || "").trim().toLowerCase();
}

function moneyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

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

async function getSaldoByTelegram(telegram_id) {
  const res = await fetch(
    `${WORKER_BASE}/api/ingest/telegram/saldo?telegram_id=${encodeURIComponent(String(telegram_id))}`,
    {
      method: "GET",
      headers: { "X-INGEST-KEY": INGEST_KEY },
    }
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

bot.start(async (ctx) => {
  await ctx.reply(
`✅ BagresPlanilhador conectado!

Comandos:
• +30 betano
• -50 bet365
• /saldo
• /vincular 123456`
  );
});

// ✅ /vincular 123456
bot.command("vincular", async (ctx) => {
  try {
    const parts = String(ctx.message.text || "").trim().split(/\s+/);
    const code = parts[1] || "";
    if (!/^\d{6}$/.test(code)) {
      await ctx.reply("❌ Use assim: /vincular 123456");
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

    await ctx.reply("✅ Telegram vinculado com sucesso! Agora pode lançar: +30 betano / -50 bet365");
  } catch (e) {
    await ctx.reply(`❌ Erro ao vincular: ${e.message}`);
  }
});

// ✅ /saldo
bot.command("saldo", async (ctx) => {
  try {
    const telegram_id = String(ctx.from?.id || "").trim();
    const data = await getSaldoByTelegram(telegram_id);

    const s = data?.summary || {};
    const by = data?.by_book || [];

    const lines = by.length
      ? by.map(x => `• ${x.book}: ${moneyBR(x.balance)}`).join("\n")
      : "• (sem movimentações)";

    await ctx.reply(
`📊 Saldos por casa:
${lines}

🏦 Banca total: ${moneyBR(s.bankroll || 0)}`
    );
  } catch (e) {
    await ctx.reply(`❌ Erro: ${e.message}`);
  }
});

// ✅ +30 betano  /  -50 bet365
bot.on("text", async (ctx) => {
  const text = String(ctx.message.text || "").trim();
  if (text.startsWith("/")) return;

  const m = text.match(/^([+-])\s*([\d.,]+)\s+([a-zA-Z0-9._-]{2,})$/);
  if (!m) return;

  const sign = m[1];
  const amount = parseMoney(m[2]);
  const book = normalizeBook(m[3]);

  if (!amount || amount <= 0) {
    await ctx.reply("❌ Valor inválido.");
    return;
  }

  const type = sign === "+" ? "deposit" : "withdraw";
  const telegram_id = String(ctx.from?.id || "").trim();
  const telegram_username = String(ctx.from?.username || "").trim();

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

bot.launch();
console.log("🤖 Bot rodando...");


