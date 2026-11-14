"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG = {
	storeApi: (process.env.GOATSTORE_API_URL || "https://cmdstore.neokex.xyz").replace(/\/+$/, ""),
	storeKey: process.env.GOATSTORE_INGEST_TOKEN || "",
	pasteApi: process.env.NEOKEX_PASTE_URL || "https://paste.neokex.xyz/api/pastes",
	pasteKey: process.env.NEOKEX_PASTE_KEY || "neokex-paste-6t9",
	pasteTtlDays: 30,
	uploadDelayMs: 1200,
	pageSize: 6,
	timeoutMs: 20000,
	selfNames: ["commandstore", "cmdstore", "goatstore"],
	autoPublish: process.env.GOATSTORE_AUTO_PUBLISH !== "false"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const log = (m) => console.log(`[commandstore] ${m}`);
const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});
const trunc = (v, max) => {
	const t = String(v ?? "").replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

function bold(text) {
	return [...String(text).toUpperCase()].map((c) => {
		if (c >= "A" && c <= "Z") return String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65);
		if (c >= "0" && c <= "9") return String.fromCodePoint(0x1d7ec + c.charCodeAt(0) - 48);
		return c;
	}).join("");
}

function card(title, body = [], footer) {
	const end = footer ? `└─ ${footer}` : "└────────────────⭔";
	return [`┌─ [ ${bold(title)} ]`, ...body.map((l) => (l ? `│ ${l}` : "│")), end].join("\n");
}

const notice = (title, msg) => card(title, [msg]);

function kv(rows) {
	return rows.map(([k, v]) => `${k.padEnd(10)} : ${v}`);
}

function stamp(v) {
	if (!v) return "";
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return String(v);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

async function http(url, opts = {}) {
	const res = await fetch(url, { ...opts, redirect: "follow", signal: AbortSignal.timeout(CONFIG.timeoutMs) });
	const text = await res.text();
	let data = {};
	try { data = JSON.parse(text); } catch {}
	return { ok: res.ok, status: res.status, data, text };
}

async function storeGet(endpoint, query = {}) {
	const url = new URL(CONFIG.storeApi + endpoint);
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
	}
	const res = await http(url, { headers: { Accept: "application/json", ...auth(CONFIG.storeKey) } });
	if (!res.ok) throw new Error(res.data?.error?.message || `store responded ${res.status}`);
	return res.data;
}

function detectRepo() {
	if (process.env.GOATSTORE_REPO) return process.env.GOATSTORE_REPO;
	try {
		const url = fs.readFileSync(path.join(process.cwd(), ".git", "config"), "utf8").match(/url\s*=\s*(.+)/)?.[1] || "";
		const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/);
		if (m) return m[1];
	} catch {}
	return "unknown/unknown";
}

function parseMeta(src) {
	const str = (k) => src.match(new RegExp(`${k}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`))?.[1];
	const aliasBlock = src.match(/aliases\s*:\s*\[([^\]]*)\]/)?.[1] || "";
	return {
		name: str("name"),
		author: str("author") || "unknown",
		version: str("version") || "1.0.0",
		category: str("category") || "uncategorized",
		aliases: [...aliasBlock.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1])
	};
}

function listFiles(filter) {
	const want = filter?.toLowerCase().replace(/\.js$/, "");
	return fs.readdirSync(__dirname)
		.filter((f) => f.endsWith(".js"))
		.filter((f) => {
			const n = f.slice(0, -3).toLowerCase();
			return !CONFIG.selfNames.includes(n) && (!want || n === want);
		});
}

async function uploadPaste(source) {
	const ttl = CONFIG.pasteTtlDays;
	const res = await http(`${CONFIG.pasteApi}?duration=${ttl}d&ttl=${ttl * 86400}`, {
		method: "POST",
		headers: { "Content-Type": "text/plain; charset=utf-8", ...auth(CONFIG.pasteKey) },
		body: source
	});
	if (!res.ok) throw new Error(res.data?.error?.message || `paste host ${res.status}`);
	return res.data.rawUrl || res.data.shortRawUrl || res.data.url;
}

async function publish(files) {
	const repo = detectRepo();
	const commands = [];
	const skipped = [];

	for (const file of files) {
		const source = fs.readFileSync(path.join(__dirname, file), "utf8");
		const meta = parseMeta(source);

		if (!source.includes("module.exports") || !meta.name) {
			skipped.push(`${file}: not a GoatBot command`);
			continue;
		}

		try {
			const rawUrl = await uploadPaste(source);
			commands.push({
				filename: file,
				path: `scripts/cmds/${file}`,
				source,
				rawUrl,
				name: meta.name,
				author: meta.author,
				version: meta.version,
				category: meta.category
			});
		} catch (e) {
			skipped.push(`${file}: paste failed (${e.message})`);
		}
		await sleep(CONFIG.uploadDelayMs);
	}

	if (!commands.length) return { status: "empty", skipped };

	const res = await http(`${CONFIG.storeApi}/api/commands/bulk`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...auth(CONFIG.storeKey) },
		body: JSON.stringify({ repo, commands, client: "goatbot-commandstore" })
	});

	if (!res.ok) return { status: "error", error: res.data?.error?.message || `store ${res.status}`, skipped };

	const summary = res.data?.data?.summary || {};
	log(`published ${summary.total ?? commands.length} from ${repo}, skipped ${skipped.length}`);
	return { status: "ok", repo, summary, skipped };
}

async function reply({ message }, text) {
	try {
		return await message.reply(text);
	} catch (e) {
		log(`reply failed: ${e.message}`);
		return null;
	}
}

const msgId = (info) => (typeof info === "string" ? info : info?.messageID || null);

async function edit(ctx, mid, text) {
	if (mid && typeof ctx.api?.editMessage === "function") {
		try {
			await ctx.api.editMessage(text, mid);
			return { messageID: mid };
		} catch {}
	}
	return reply(ctx, text);
}

function remember(info, event, data) {
	const mid = msgId(info);
	if (!mid) return;
	global.GoatBot?.onReply?.set(mid, { commandName: "commandstore", messageID: mid, author: event.senderID, data });
}

function listText(title, items, p) {
	const lines = [`┌─ [ ${bold(title)} ]`, `│ ${p.total ?? items.length} results found`, "│"];

	if (!items.length) lines.push("│ No commands matched your search.");

	items.forEach((it, i) => {
		lines.push(`│ ${pad(i + 1)} [ ${bold(trunc(it.name, 30))} ]`);
		lines.push(...kv([
			["ID", `#${it.id}`],
			["Author", trunc(it.author || "Unknown", 24)],
			["Version", `v${it.latestVersion || "Unknown"}`],
			["Category", trunc(it.category || "Uncategorized", 20)]
		]).map((r) => `│   ${r}`));
		if (i < items.length - 1) lines.push("│");
	});

	lines.push("│", `│ PAGE ${p.page || 1} / ${p.pages || 1}`, "└─⭔ Reply NEXT / PREV · ID · INSTALL ID");
	return lines.join("\n");
}

function detail(c) {
	const rows = [
		["ID", `#${c.id}`],
		["Name", c.name],
		["Author", c.author || "Unknown"],
		["Version", `v${c.latestVersion || "Unknown"}`],
		["Category", c.category || "Uncategorized"],
		["Source", c.sourceRepo || "Unknown"]
	];
	if (c.sourcePath) rows.push(["Path", c.sourcePath]);
	if (c.aliases?.length) rows.push(["Aliases", c.aliases.join(", ")]);
	rows.push(["Raw URL", c.rawUrl || "Unknown"]);
	return card("COMMAND DETAILS", kv(rows), `Reply INSTALL ${c.id} to install this command.`);
}

async function search(ctx, { term, author, page = 1 }) {
	const pending = await reply(ctx, card("COMMAND DISCOVERY", [author ? `Searching commands by ${author}...` : "Searching the command store..."]));
	const mid = msgId(pending);

	try {
		const body = await storeGet("/api/commands", {
			...(author ? { author } : { name: term }),
			limit: CONFIG.pageSize,
			offset: (page - 1) * CONFIG.pageSize
		});
		const items = body.data || [];
		const p = body.pagination || {};
		const title = author ? `COMMANDS BY ${author}` : "COMMAND DISCOVERY";

		const info = await edit(ctx, mid, listText(title, items, p));
		remember(info, ctx.event, {
			kind: author ? "author" : "search",
			term,
			author: author || null,
			page: p.page || page,
			pages: p.pages || 1
		});
	} catch (e) {
		await edit(ctx, mid, notice("SEARCH ERROR", `Search failed: ${e.message}`));
	}
}

async function showCommand(ctx, endpoint, id) {
	try {
		const c = (await storeGet(endpoint)).data;
		c.rawUrl = c.raw?.shortUrl || c.raw?.url || (await storeGet(`/api/commands/id/${c.id}/rawurl`).then((b) => b.data?.rawUrl).catch(() => null));
		const info = await reply(ctx, detail(c));
		remember(info, ctx.event, { kind: "detail", commandId: c.id });
	} catch (e) {
		await reply(ctx, notice("COMMAND ERROR", `Could not load command${id ? ` #${id}` : ""}: ${e.message}`));
	}
}

const showById = (ctx, id) => showCommand(ctx, `/api/commands/id/${id}`, id);

async function stats(ctx) {
	try {
		const s = (await storeGet("/api/stats")).data || {};
		const r = s.lastRun || {};
		const rows = [
			["Commands", s.commands ?? 0],
			["Versions", s.versions ?? 0],
			["Authors", s.authors ?? 0],
			["Categories", s.categories ?? 0],
			["Repositories", s.repositories ?? 0],
			["Crawled", s.repositoriesCrawled ?? 0],
			["Retention", `${s.retentionDays ?? CONFIG.pasteTtlDays} days`],
			["Schedule", `${s.schedule?.cron || "0 0 * * *"} (${s.schedule?.timezone || "UTC"})`]
		];
		if (r.status || r.finishedAt) rows.push(["Last run", [r.status || "Unknown", stamp(r.finishedAt)].filter(Boolean).join(" · ")]);
		if (s.lastUpdatedAt) rows.push(["Updated", stamp(s.lastUpdatedAt)]);
		await reply(ctx, card("STORE STATISTICS", kv(rows)));
	} catch (e) {
		await reply(ctx, notice("STORE ERROR", `Could not connect to the command store: ${e.message}`));
	}
}

async function install(ctx, id, override = false) {
	const { api, event } = ctx;

	try {
		const cmd = (await storeGet(`/api/commands/id/${id}`)).data;
		const loader = global.utils?.loadScripts;

		if (!loader) {
			return reply(ctx, notice("INSTALLATION ERROR", "GoatBot loadScripts is unavailable on this host."));
		}

		const cmdsDir = fs.existsSync(path.join(process.cwd(), "scripts", "cmds"))
			? path.join(process.cwd(), "scripts", "cmds")
			: __dirname;

		const names = [cmd.name, ...(cmd.aliases || [])];
		const existing = names.map((n) => `${n}.js`).find((f) => fs.existsSync(path.join(cmdsDir, f)));

		if (existing && !override) {
			const info = await reply(ctx, card("OVERWRITE CONFIRMATION", [
				`${existing} already exists on your bot.`,
				"",
				"React to this message to confirm overwriting the existing file."
			]));
			const mid = msgId(info);
			if (mid) {
				global.GoatBot?.onReaction?.set(mid, {
					commandName: "commandstore",
					messageID: mid,
					author: event.senderID,
					data: { action: "install", id }
				});
			}
			return;
		}

		const raw = await http(`${CONFIG.storeApi}/api/commands/id/${id}/raw?redirect=0`, {
			headers: { Accept: "text/plain" }
		});
		if (!raw.ok) {
			return reply(ctx, notice("SOURCE ERROR", `Could not fetch the command source: store responded ${raw.status}`));
		}

		const info = loader(
			"cmds",
			`${cmd.name}.js`,
			global.utils?.log,
			global.GoatBot?.configCommands,
			api,
			event.threadModel,
			event.userModel,
			event.dashBoardModel,
			event.globalModel,
			event.threadsData,
			event.usersData,
			event.dashBoardData,
			event.globalData,
			event.getLang,
			raw.text
		);

		if (info?.status === "success") {
			return reply(ctx, card("INSTALLATION COMPLETE", kv([
				["Name", cmd.name],
				["Version", `v${cmd.latestVersion}`],
				["Author", cmd.author],
				["File", `scripts/cmds/${cmd.name}.js`],
				["Triggers", names.join(", ")]
			]), "Command is ready to use."));
		}

		const err = info?.error;
		return reply(ctx, notice("INSTALLATION ERROR", `Installation failed: ${err ? `${err.name}: ${err.message}` : "unknown error"}`));
	} catch (e) {
		return reply(ctx, notice("INSTALLATION ERROR", `Installation failed: ${e.message}`));
	}
}

async function publishCmd(ctx, filter) {
	const files = listFiles(filter);

	if (!files.length) {
		return reply(ctx, notice("PUBLISHING", "No matching command file was found to publish."));
	}

	const r = await publish(files);

	if (r.status === "ok") {
		const s = r.summary;
		const body = kv([
			["Repository", r.repo],
			["Total", s.total ?? files.length],
			["Created", s.created ?? 0],
			["Updated", s.updated ?? 0],
			["Duplicate", s.duplicate ?? 0],
			["Skipped", r.skipped.length]
		]);
		if (r.skipped.length) {
			body.push("", `[ ${bold("SKIPPED FILES")} ]`, ...r.skipped.slice(0, 5).map((x) => `- ${trunc(x, 100)}`));
		}
		return reply(ctx, card("PUBLISHING COMPLETE", body));
	}

	if (r.status === "empty") {
		return reply(ctx, card("PUBLISHING RESULTS", ["No valid commands were found to publish.", "", `${r.skipped.length} files skipped.`]));
	}

	return reply(ctx, notice("PUBLISHING ERROR", r.error || "Unknown error"));
}

let autoPublished = false;

module.exports = {
	config: {
		name: "commandstore",
		aliases: ["cmdstore", "goatstore", "cs", "gs"],
		author: "Neoaz 🐊",
		version: "2.7.0",
		category: "owner",
		role: 2,
		countDown: 5,
		description: {
			en: "Browse, install and publish GoatBot commands from the command store"
		},
		guide: {
			en:
				"{pn} - show usage\n" +
				"{pn} <name> [page] - search commands by name\n" +
				"{pn} -a <author> [page] - list commands by an author\n" +
				"{pn} id <id> - show one command\n" +
				"{pn} random - show a random command\n" +
				"{pn} stats - show store statistics\n" +
				"{pn} publish [file] - publish this project's commands"
		}
	},

	onLoad: async function () {
		if (autoPublished || !CONFIG.autoPublish) return;
		autoPublished = true;
		try {
			const files = listFiles();
			if (files.length) await publish(files);
		} catch (e) {
			log(`auto publish failed: ${e.message}`);
		}
	},

	onStart: async function (ctx) {
		const { args } = ctx;
		const first = (args[0] || "").toLowerCase();

		if (!first) {
			return reply(ctx, card("COMMAND STORE", [
				`01. commandstore <name> [page] - Search commands`,
				`02. commandstore -a <author> [page] - Commands by author`,
				`03. commandstore id <id> - View command details`,
				`04. commandstore random - Discover a random command`,
				`05. commandstore stats - Store statistics`,
				`06. commandstore publish [file] - Publish project commands`
			], "Reply NEXT / PREV to navigate · ID to view · INSTALL ID to install"));
		}

		if (first === "stats") return stats(ctx);
		if (first === "random") return showCommand(ctx, "/api/commands/random");

		if (first === "id") {
			const id = Number.parseInt(args[1], 10);
			return Number.isFinite(id)
				? showById(ctx, id)
				: reply(ctx, notice("COMMAND ERROR", "Usage: id <id>"));
		}

		if (["publish", "all", "push"].includes(first)) {
			return publishCmd(ctx, args[1]);
		}

		if (["-a", "--author", "author"].includes(first)) {
			const rest = args.slice(1);
			let page = 1;
			if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1])) page = Number(rest.pop());
			const author = rest.join(" ").trim();
			if (!author) return reply(ctx, notice("COMMAND ERROR", "Usage: -a <author> [page]"));
			return search(ctx, { author, page });
		}

		return search(ctx, {
			term: args[0],
			page: Number.parseInt(args[1], 10) || 1
		});
	},

	onReply: async function (ctx) {
		const { event, args, Reply } = ctx;

		if (String(event.senderID) !== String(Reply?.author)) return;

		const cmd = (args[0] || "").toLowerCase();
		const s = Reply?.data || {};

		if (cmd === "install") {
			const id = Number.parseInt(args[1], 10);
			return Number.isFinite(id)
				? install(ctx, id)
				: reply(ctx, notice("COMMAND ERROR", "Usage: INSTALL <id>"));
		}

		if (cmd === "next" || cmd === "prev") {
			if (s.kind !== "search" && s.kind !== "author") {
				return reply(ctx, notice("NAVIGATION ERROR", "There is no active search page to navigate."));
			}
			const target = s.page + (cmd === "next" ? 1 : -1);
			if (target < 1 || target > s.pages) {
				return reply(ctx, notice("NAVIGATION ERROR", "There are no more pages in this direction."));
			}
			return search(ctx, { term: s.term, author: s.author, page: target });
		}

		const id = Number.parseInt(cmd, 10);
		if (Number.isFinite(id)) return showById(ctx, id);

		return reply(ctx, notice("REPLY HELP", "Reply with an ID, INSTALL <id>, NEXT or PREV."));
	},

	onReaction: async function (ctx) {
		const { event, Reaction } = ctx;

		if (String(event.userID || event.senderID) !== String(Reaction?.author)) return;
		if (Reaction?.data?.action === "install") {
			return install(ctx, Reaction.data.id, true);
		}
	}
};
