import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WORKER_BASE = (process.env.WORKER_BASE || "").replace(/\/+$/, "");
const INGEST_KEY = String(process.env.INGEST_KEY || "")
  .replace(/[\r\n\t]/g, "")
  .trim();
const BOT_EMAIL = (process.env.BOT_EMAIL || "").trim().toLowerCase();

if (!BOT_TOKEN) throw new Error("Faltou BOT_TOKEN.");
if (!WORKER_BASE) throw new Error("Faltou WORKER_BASE.");
if (!INGEST_KEY) throw new Error("Faltou INGEST_KEY.");
if (!BOT_EMAIL) throw new Error("Faltou BOT_EMAIL.");

const bot = new Telegraf(BOT_TOKEN);

function parseMoney(s) {
  const n = Number(String(s || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normalizeBook(s) {
  return String(s || "").trim().toLowerCase();
}

async function ingestWallet({ type, amount, book, note }) {
  const res = await fetch(`${WORKER_BASE}/api/ingest/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-INGEST-KEY": INGEST_KEY
    },
    body: JSON.stringify({
      kind: "wallet",
      email: BOT_EMAIL,
      type,
      amount,
      book,
      note: note || "telegram",
      source: "telegram"
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

async function getWalletSummary() {
  const res = await fetch(
    `${WORKER_BASE}/api/ingest/wallet/summary?email=${encodeURIComponent(BOT_EMAIL)}`,
    {
      method: "GET",
      headers: {
        "X-INGEST-KEY": INGEST_KEY
      }
    }
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

function moneyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

bot.start(async (ctx) => {
  await ctx.reply(
`✅ BagresPlanilhador conectado!

Comandos:
• +30 betano
• -50 bet365
• /saldo`
  );
});

bot.command("saldo", async (ctx) => {
  try {
    const data = await getWalletSummary();
    const s = data?.summary || {};
    const by = data?.by_book_current || [];

    const lines = by.length
      ? by.map(x => `• ${x.book}: ${moneyBR(x.bankroll)}`).join("\n")
      : "• (sem movimentações)";

    await ctx.reply(
`📊 Saldos por casa:
${lines}

🏦 Banca total: ${moneyBR(s.bankroll_current || 0)}`
    );
  } catch (e) {
    await ctx.reply(`❌ Erro: ${e.message}`);
  }
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
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

  try {
    await ingestWallet({
      type,
      amount,
      book,
      note: `telegram:${ctx.from?.id || "user"}`
    });

    const action = type === "deposit" ? "DEPÓSITO" : "SAQUE";
    await ctx.reply(`💰 ${action} ${moneyBR(amount)} em ${book}`);
  } catch (e) {
    await ctx.reply(`❌ Erro ao registrar: ${e.message}`);
  }
});

bot.launch();
console.log("🤖 Bot rodando...");
