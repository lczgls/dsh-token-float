window.__ModuleLoader__.load({
	id: "dsh-token-float",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const useSyncExternalStore = React.useSyncExternalStore;
		const useCallback = React.useCallback;

		/** Browser-local settings key. */
		const SETTINGS_KEY = "dsh.token-float.settings.v3";
		/** Browser-local per-day spend key. */
		const DAY_KEY = "dsh.token-float.day.v1";
		/** Host route that keeps the same per-day figure on disk (404 on older Hosts). */
		const LEDGER_ROUTE = "/dsh-token-float-api/ledger";
		/** Silence after which a running turn is reported as local work, not model billing. */
		const BURN_WINDOW_MS = 120000;

		const zh = {
			title: "本会话实时消耗",
			session: "本会话",
			running: "消耗中",
			idle: "不消耗",
			local: "本机执行",
			context: "上下文",
			rowInput: "输入·未命中",
			rowCacheRead: "输入·缓存命中",
			rowCacheWrite: "缓存写入",
			rowOutput: "输出",
			total: "合计",
			today: "今日已用",
			balance: "余额",
			lowBalance: "余额不足",
			bonus: "含赠金",
			lastTurn: "上一轮",
			peak: "峰谷",
			peakLabel: "高峰价",
			offLabel: "谷价",
			toOff: "距谷价",
			toPeak: "距峰价",
			pricing: "价目表",
			auto: "内置价目表",
			manual: "手动单价",
			useAuto: "跟随内置",
			useManual: "改手动",
			pricingHint: "内置价目表按 DeepSeek 峰谷价（元/百万 token）",
			manualHint: "手动单价（每百万 token）",
			priceInput: "未命中",
			priceCacheRead: "命中",
			priceCacheWrite: "缓存写",
			priceOutput: "输出",
			reset: "恢复默认",
			note: "估算，非账单",
			collapse: "收起",
			configSummary: "侧边栏底部的本会话 token 与金额读数：峰谷计价、真实余额、每日账本。",
			configPricing: "计价方式",
			configCurrency: "币种",
			configExpanded: "默认展开明细",
			configNote: "金额按 DeepSeek 官方峰谷价本地估算，不是账单；余额来自账号服务。",
			configReset: "恢复默认"
		};

		const en = {
			title: "Live session usage",
			session: "Session",
			running: "billing",
			idle: "idle",
			local: "local run",
			context: "context",
			rowInput: "In · miss",
			rowCacheRead: "In · hit",
			rowCacheWrite: "Cache write",
			rowOutput: "Out",
			total: "Total",
			today: "Today",
			balance: "Balance",
			lowBalance: "Low balance",
			bonus: "incl. bonus",
			lastTurn: "Last turn",
			peak: "Pricing",
			peakLabel: "peak",
			offLabel: "off-peak",
			toOff: "to off-peak",
			toPeak: "to peak",
			pricing: "Prices",
			auto: "Built-in table",
			manual: "Manual prices",
			useAuto: "Use built-in",
			useManual: "Custom",
			pricingHint: "Built-in DeepSeek peak/off-peak table (CNY per 1M tokens)",
			manualHint: "Manual prices per 1M tokens",
			priceInput: "Miss",
			priceCacheRead: "Hit",
			priceCacheWrite: "Cache write",
			priceOutput: "Output",
			reset: "Reset",
			note: "estimate, not a bill",
			collapse: "Collapse",
			configSummary: "Token and cost readout in the sidebar foot: peak/off-peak pricing, the real account balance and a durable daily ledger.",
			configPricing: "Pricing",
			configCurrency: "Currency",
			configExpanded: "Expand details by default",
			configNote: "Cost is estimated locally from DeepSeek's official peak/off-peak table — not a bill. Balance comes from the account service.",
			configReset: "Reset to defaults"
		};

		/** Locale namespace of the widget copy. */
		const NS = "token-float";
		/** Package name; the keyed `plugins.bundle.config` slot keys its page by this. */
		const PKG_NAME = "dsh-token-float";
		/** Active locale id, refreshed from the app's locale service on every publish. */
		let localeId = "";

		function dictFor(lang) {
			return String(lang || "").toLowerCase().startsWith("en") ? en : zh;
		}

		function t_row(key) {
			const lang = String(localeId || document.documentElement.lang || navigator.language || "zh");
			return dictFor(lang)[key] ?? key;
		}

		/**
		 * DeepSeek's published pay-as-you-go sheet, CNY per million tokens.
		 * Peak = weekdays 09:00-12:00 and 14:00-18:00 (Asia/Shanghai); everything else
		 * including the whole weekend bills at half the peak rate.
		 */
		const PRICING = {
			flash: { id: "flash", name: "V4.1 Flash", peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
			pro: { id: "pro", name: "V4 Pro", peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } }
		};

		function modelKind(modelId) {
			const id = String(modelId ?? "").toLowerCase();
			if (id.includes("pro")) return "pro";
			return "flash";
		}

		/** Beijing wall clock as (day index since epoch, minute of day, weekday Mon=0). */
		function beijingClock(nowMs) {
			const total = Math.floor((nowMs + 8 * 3600 * 1000) / 60000);
			const day = Math.floor(total / 1440);
			const minute = total - day * 1440;
			return { day, minute, weekday: (day + 3) % 7 };
		}

		/** Peak-ness of a Beijing local day/minute; weekends are entirely off-peak. */
		function isPeakAt(day, minute) {
			const weekday = (day + 3) % 7;
			if (weekday >= 5) return false;
			return (minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080);
		}

		const BOUNDARIES = [0, 540, 720, 840, 1080];

		/** Current tier plus the next instant the tier actually changes. */
		function tierInfo(nowMs) {
			const clock = beijingClock(nowMs);
			const peak = isPeakAt(clock.day, clock.minute);
			let switchAt = null;
			let switchPeak = peak;
			for (let d = clock.day; d <= clock.day + 2 && switchAt === null; d += 1) {
				for (const boundary of BOUNDARIES) {
					if (d === clock.day && boundary <= clock.minute) continue;
					const candidate = isPeakAt(d, boundary);
					if (candidate !== peak) {
						switchAt = (d * 1440 + boundary - (clock.day * 1440 + clock.minute)) * 60000;
						switchPeak = candidate;
						break;
					}
				}
			}
			return { peak, switchAt, switchPeak };
		}

		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "";
			const minutes = Math.round(ms / 60000);
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			if (hours <= 0) return rest + "m";
			return hours + "h" + (rest > 0 ? String(rest).padStart(2, "0") + "m" : "");
		}

		function todayKey(nowMs) {
			const offset = new Date(nowMs + 8 * 3600 * 1000);
			return offset.toISOString().slice(0, 10);
		}

		function readJSON(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				if (!raw) return fallback;
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : fallback;
			} catch {
				return fallback;
			}
		}

		function writeJSON(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch {}
		}

		const DEFAULT_SETTINGS = {
			pricingMode: "auto",
			currency: "\u00a5",
			priceInput: 2,
			priceCacheRead: 0.04,
			priceCacheWrite: 2,
			priceOutput: 8,
			expanded: false,
			pricingOpen: false
		};

		function loadSettings() {
			const stored = readJSON(SETTINGS_KEY, {});
			const merged = { ...DEFAULT_SETTINGS };
			for (const key of Object.keys(DEFAULT_SETTINGS)) {
				if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) merged[key] = stored[key];
			}
			return merged;
		}

		/**
		 * One settings document, shared by the sidebar row and the plugin config page.
		 *
		 * They live in different slots and either can mount alone (the config page is
		 * reachable without the row, the row without ever opening settings), so the
		 * state cannot hang off a single component — it lives here and both subscribe.
		 */
		const settingsListeners = new Set();
		let settingsValue = loadSettings();

		function readSettings() {
			return settingsValue;
		}

		function writeSettings(patch) {
			settingsValue = { ...settingsValue, ...patch };
			writeJSON(SETTINGS_KEY, settingsValue);
			for (const listener of settingsListeners) {
				try {
					listener();
				} catch {}
			}
		}

		function subscribeSettings(listener) {
			settingsListeners.add(listener);
			return () => settingsListeners.delete(listener);
		}

		function loadDay() {
			const key = todayKey(Date.now());
			const stored = readJSON(DAY_KEY, null);
			if (stored && stored.date === key && Number.isFinite(stored.cost)) {
				return {
					date: key,
					cost: stored.cost,
					seeded: stored.seeded && typeof stored.seeded === "object" ? stored.seeded : {}
				};
			}
			return { date: key, cost: 0, seeded: {} };
		}

		function faceSnapshot(face) {
			if (!face || typeof face.getSnapshot !== "function") return void 0;
			try {
				return face.getSnapshot();
			} catch {
				return void 0;
			}
		}

		function formatTokens(value) {
			const n = Number.isFinite(value) ? value : 0;
			if (n < 1000) return String(n);
			if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 2 : 1).replace(/\.0+$/, "") + "k";
			return (n / 1e6).toFixed(2) + "M";
		}

		function formatMoney(value, currency) {
			const n = Number.isFinite(value) ? value : 0;
			const digits = n === 0 ? 2 : n < 0.001 ? 5 : n < 0.01 ? 4 : n < 1 ? 3 : 2;
			return currency + n.toFixed(digits);
		}

		function formatPercent(part, whole) {
			if (!whole || whole <= 0) return null;
			const pct = (part / whole) * 100;
			if (!Number.isFinite(pct)) return null;
			return pct >= 10 ? pct.toFixed(0) + "%" : pct.toFixed(1) + "%";
		}

		/**
		 * Live meter source.
		 *
		 * Token totals come from the Session's published projections; the money is
		 * accumulated as the totals grow, each increment priced at the tier in force
		 * when it was observed. That keeps peak/off-peak honest for a long session
		 * instead of repricing all history at the rate of the current minute.
		 */
		function createMeter(ctx) {
			const uiSession = ctx.uiSession;
			const listeners = new Set();
			let subscriptions = [];
			let disposed = false;
			let settings = readSettings();
			let day = loadDay();
			// The config page can change prices while the row is mounted; mirror it live.
			const offSettings = subscribeSettings(() => {
				settings = readSettings();
				publish();
			});

			/** Accounting state, independent of rendering. */
			const state = {
				sessionId: void 0,
				prev: null,
				baselineUsage: null,
				baselinePeak: false,
				increment: 0,
				turnMark: 0,
				lastTurn: null,
				wasRunning: false,
				lastPressure: void 0,
				lastActivityAt: 0,
				/** Real account balance from the Host, or null when unavailable. */
				balance: null
			};

			let value = {
				active: false,
				sessionId: void 0,
				running: false,
				burning: false,
				usage: { miss: 0, hit: 0, write: 0, out: 0 },
				total: 0,
				cost: 0,
				today: 0,
				lastTurn: null,
				context: null,
				tier: { peak: false, switchAt: null, switchPeak: false },
				model: { kind: "flash", name: "V4.1 Flash" },
				balance: null,
				locale: "",
				settings
			};

			const bindingOf = () => {
				try {
					return uiSession.current.getSnapshot();
				} catch {
					return void 0;
				}
			};

			const statusOf = (sessionId) => {
				if (!sessionId) return void 0;
				try {
					return uiSession.sessionStatus.getSnapshot().get(sessionId);
				} catch {
					return void 0;
				}
			};

			const modelOf = (projection) => {
				const raw = typeof projection === "function" ? faceSnapshot(projection("modelSelection")) : void 0;
				const selection = raw ? (raw.next ?? raw.lastUsed) : void 0;
				const id = selection && selection.model ? String(selection.model) : "";
				return { id, kind: modelKind(id), name: PRICING[modelKind(id)].name };
			};

			/** Effective price per million tokens for one tier of one model. */
			const priceAt = (peak, kind) => {
				if (settings.pricingMode === "manual") {
					return {
						hit: settings.priceCacheRead,
						miss: settings.priceInput,
						write: settings.priceCacheWrite,
						out: settings.priceOutput
					};
				}
				const table = PRICING[kind] ?? PRICING.flash;
				const tier = peak ? table.peak : table.off;
				return { hit: tier.hit, miss: tier.miss, write: tier.miss, out: tier.out };
			};

			const costOf = (usage, price) =>
				(usage.miss * price.miss + usage.write * price.write + usage.hit * price.hit + usage.out * price.out) / 1e6;

			const account = (raw, kind) => {
				const now = Date.now();
				const tier = tierInfo(now);
				const price = priceAt(tier.peak, kind);

				if (raw.sessionId !== state.sessionId) {
					state.sessionId = raw.sessionId;
					state.prev = { ...raw.usage };
					state.baselineUsage = { ...raw.usage };
					state.baselinePeak = tier.peak;
					state.increment = 0;
					state.turnMark = 0;
					state.lastTurn = null;
					state.wasRunning = raw.running;
					state.lastPressure = void 0;
					state.lastActivityAt = raw.running ? now : 0;

					// Count the Session's existing total into "today" once per page-day, so the
					// day figure never reads lower than the session figure and a reload does
					// not book the same tokens twice.
					const key = todayKey(now);
					if (day.date !== key) day = { date: key, cost: 0, seeded: {} };
					if (!day.seeded) day.seeded = {};
					if (raw.sessionId && day.seeded[raw.sessionId] === void 0) {
						const seed = costOf(raw.usage, price);
						day.seeded[raw.sessionId] = seed;
						day.cost += seed;
						writeJSON(DAY_KEY, day);
						ledgerPush();
					}
					return;
				}

				const previous = state.prev ?? raw.usage;
				const delta = {
					miss: Math.max(0, raw.usage.miss - previous.miss),
					hit: Math.max(0, raw.usage.hit - previous.hit),
					write: Math.max(0, raw.usage.write - previous.write),
					out: Math.max(0, raw.usage.out - previous.out)
				};
				state.prev = { ...raw.usage };

				const spent = costOf(delta, price);
				if (spent > 0) {
					state.increment += spent;
					state.lastActivityAt = now;
					const key = todayKey(now);
					if (day.date !== key) day = { date: key, cost: 0, seeded: {} };
					day.cost += spent;
					writeJSON(DAY_KEY, day);
				}

				if (raw.running && !state.wasRunning) {
					state.turnMark = state.increment;
					state.lastActivityAt = now;
				}
				if (!raw.running && state.wasRunning) state.lastTurn = Math.max(0, state.increment - state.turnMark);
				state.wasRunning = raw.running;
			};

			const build = () => {
				const now = Date.now();
				// The app's locale service is authoritative; `<html lang>` only mirrors it
				// once the locale plugin has booted, so it is a fallback, not the source.
				try {
					localeId = String(ctx.locale.getLocale().active || "");
				} catch {}
				const binding = bindingOf();
				const projection = binding && binding.keyedHooks ? binding.keyedHooks.projection : void 0;
				const sessionId = binding && binding.props ? binding.props.sessionId : void 0;
				const readable = typeof projection === "function";
				const rawUsage = readable ? faceSnapshot(projection("tokenUsage")) : void 0;
				const pressure = readable ? faceSnapshot(projection("contextPressure")) : void 0;
				const model = modelOf(projection);

				const usage = {
					miss: rawUsage?.uncachedInputTokens ?? 0,
					out: rawUsage?.outputTokens ?? 0,
					hit: rawUsage?.cacheReadTokens ?? 0,
					write: rawUsage?.cacheWriteTokens ?? 0
				};
				const total = usage.miss + usage.out + usage.hit + usage.write;
				const running = statusOf(sessionId)?.running === true;

				const resolved = {
					active: Boolean(sessionId),
					sessionId,
					running,
					usage,
					total,
					model
				};
				account({ ...resolved, usage }, model.kind);

				const tier = tierInfo(now);
				// History before this page mounted is priced at the tier it was first seen in;
				// every later increment was priced when it arrived.
				const baseline = state.baselineUsage ?? usage;
				const baselineCost = costOf(baseline, priceAt(state.baselinePeak, model.kind));
				const cost = baselineCost + state.increment;

				const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
				const contextWindow = pressure?.contextWindow;
				const context =
					Number.isFinite(used) && Number.isFinite(contextWindow) && contextWindow > 0
						? { used, window: contextWindow }
						: null;

				const key = todayKey(now);
				if (day.date !== key) day = { date: key, cost: 0, seeded: {} };

				// A model request bumps `contextPressure`; a completed answer bumps the usage
				// totals. Either is evidence the turn is really talking to the model, as opposed
				// to running local tools. Silence for BURN_WINDOW_MS means "本机执行".
				const pressureKey = context ? context.used + "/" + context.window : "";
				if (pressureKey !== state.lastPressure) {
					state.lastPressure = pressureKey;
					if (running) state.lastActivityAt = now;
				}
				const burning = running && state.lastActivityAt > 0 && now - state.lastActivityAt < BURN_WINDOW_MS;

				return {
					...resolved,
					burning,
					cost,
					today: day.cost,
					lastTurn: state.lastTurn,
					context,
					tier,
					balance: state.balance,
					locale: localeId,
					settings
				};
			};

			const publish = () => {
				if (disposed) return;
				const next = build();
				const previous = value;
				if (
					previous.active === next.active &&
					previous.sessionId === next.sessionId &&
					previous.running === next.running &&
					previous.burning === next.burning &&
					previous.settings === next.settings &&
					previous.locale === next.locale &&
					previous.total === next.total &&
					previous.cost === next.cost &&
					previous.today === next.today &&
					previous.balance === next.balance &&
					previous.lastTurn === next.lastTurn &&
					previous.model.kind === next.model.kind &&
					previous.usage.miss === next.usage.miss &&
					previous.usage.hit === next.usage.hit &&
					previous.usage.write === next.usage.write &&
					previous.usage.out === next.usage.out &&
					previous.tier.peak === next.tier.peak &&
					(previous.context === next.context ||
						(previous.context !== null &&
							next.context !== null &&
							previous.context.used === next.context.used &&
							previous.context.window === next.context.window))
				)
					return;
				value = next;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {}
				}
			};

			const resubscribe = () => {
				for (const off of subscriptions) {
					try {
						off();
					} catch {}
				}
				subscriptions = [];
				const binding = bindingOf();
				const projection = binding && binding.keyedHooks ? binding.keyedHooks.projection : void 0;
				if (typeof projection !== "function") return;
				for (const key of ["tokenUsage", "contextPressure", "modelSelection"]) {
					try {
						const face = projection(key);
						if (face && typeof face.subscribe === "function") subscriptions.push(face.subscribe(publish));
					} catch {}
				}
			};

			const offCurrent = uiSession.current.subscribe(() => {
				resubscribe();
				publish();
			});
			const offStatus = uiSession.sessionStatus.subscribe(publish);

			resubscribe();
			publish();

			// Nothing may arrive for minutes while a local tool runs, so re-evaluate the
			// burn window on a slow beat instead of waiting for the next projection frame.
			const tick = setInterval(() => {
				if (!disposed && value.running) publish();
			}, 15000);

			/**
			 * Real wallet balance, straight from the Host account service.
			 *
			 * The Host owns the login grant, so the browser never sees a key: it asks
			 * `remote.account.getBalance` and gets `{status:'ready', value:[…], bonusWallets:[…]}`,
			 * `null` when signed out, or `{status:'failed'}` when the upstream call failed.
			 */
			const BALANCE_TTL_MS = 60000;
			let balanceAt = 0;
			let balanceBusy = false;

			const balanceMeta = () => ({
				version: "1.0.0",
				locale: String(localeId || "zh-CN"),
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
			});

			const walletAmount = (list, currency) => {
				const hit = (Array.isArray(list) ? list : []).find((wallet) => wallet && wallet.currency === currency);
				const parsed = hit ? Number(hit.balance) : NaN;
				return Number.isFinite(parsed) ? parsed : 0;
			};

			const pullBalance = async (force) => {
				if (disposed || balanceBusy) return;
				if (!force && Date.now() - balanceAt < BALANCE_TTL_MS) return;
				const account = ctx.remote && ctx.remote.account;
				if (!account || typeof account.getBalance !== "function") return;
				balanceBusy = true;
				try {
					const result = await account.getBalance(balanceMeta());
					balanceAt = Date.now();
					const payload = result && result.ok ? result.value : null;
					if (payload && payload.status === "ready") {
						const wallets = Array.isArray(payload.value) ? payload.value : [];
						const currency = wallets.some((wallet) => wallet && wallet.currency === "CNY") ? "CNY" : "USD";
						state.balance = {
							currency,
							total: walletAmount(wallets, currency),
							granted: walletAmount(payload.bonusWallets, currency)
						};
					} else {
						// Signed out or upstream failure: drop the figure rather than film a stale one.
						state.balance = null;
					}
					publish();
				} catch {
					// Keep the previous figure; the next beat retries.
				} finally {
					balanceBusy = false;
				}
			};
			const balanceTimer = setInterval(() => pullBalance(false), BALANCE_TTL_MS);
			pullBalance(true);

			/**
			 * Durable daily ledger.
			 *
			 * `localStorage` is per-site and dies with the site data; the Host keeps the
			 * same number in `~/.dsh/dsh-token-float/ledger.json`. The client mirrors
			 * every change there when the route exists and reads it back on start-up
			 * (the larger of the two wins, so a day never regresses). A Host that has
			 * not been restarted yet answers 404 and the meter stays local-only.
			 */
			const LEDGER_PUSH_GAP_MS = 5000;
			let ledgerAt = 0;
			let ledgerPushPending = false;
			/** Set once the probe proves there is no Host route, so we stop posting 404s. */
			let ledgerOff = false;

			const ledgerPush = (force) => {
				if (disposed || ledgerOff) return;
				const now = Date.now();
				if (!force && now - ledgerAt < LEDGER_PUSH_GAP_MS) {
					ledgerPushPending = true;
					return;
				}
				ledgerAt = now;
				ledgerPushPending = false;
				try {
					fetch(LEDGER_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ day: day.date, cost: Math.round(day.cost * 1e6) / 1e6 }),
						keepalive: true
					}).catch(() => {});
				} catch {}
			};

			const ledgerPull = async () => {
				try {
					const response = await fetch(LEDGER_ROUTE, { headers: { accept: "application/json" } });
					if (!response.ok) {
						ledgerOff = true;
						return;
					}
					ledgerOff = false;
					const payload = await response.json();
					const remote = payload && payload.days ? Number(payload.days[day.date]) : NaN;
					if (Number.isFinite(remote) && remote > day.cost) {
						day.cost = remote;
						writeJSON(DAY_KEY, day);
						publish();
					}
				} catch {}
			};
			ledgerPull();
			const ledgerTimer = setInterval(() => {
				if (ledgerPushPending) ledgerPush(true);
			}, LEDGER_PUSH_GAP_MS);

			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				refresh: publish,
				updateSettings: (patch) => writeSettings(patch),
				dispose: () => {
					// Flush before flipping `disposed`, otherwise the guard swallows it.
					if (ledgerPushPending) ledgerPush(true);
					disposed = true;
					clearInterval(tick);
					clearInterval(balanceTimer);
					clearInterval(ledgerTimer);
					offSettings();
					offCurrent();
					offStatus();
					for (const off of subscriptions) {
						try {
							off();
						} catch {}
					}
					subscriptions = [];
					listeners.clear();
				}
			};
		}

		function useMeter(meter) {
			return useSyncExternalStore(
				useCallback((listener) => meter.subscribe(listener), [meter]),
				useCallback(() => meter.getSnapshot(), [meter])
			);
		}

		const dim = "var(--dsw-alias-label-secondary, rgba(110,110,120,0.9))";
		const strong = "var(--dsw-alias-label-primary, inherit)";
		const accent = "var(--dsw-alias-state-business-primary, #2563eb)";
		const hairline = "var(--dsw-alias-border-l3, rgba(0,0,0,0.08))";
		/** Shown in place of the usual accent when the account is nearly out of money. */
		const danger = "var(--dsw-alias-state-danger-primary, #e5484d)";
		/** Balance (in the wallet's own currency) at or below which the row warns. */
		const LOW_BALANCE = 1;

		function meterRow(label, value, money, bold, alert) {
			return h(
				"div",
				{
					key: label,
					style: {
						display: "flex",
						alignItems: "baseline",
						justifyContent: "space-between",
						gap: 8,
						fontSize: 10,
						lineHeight: "15px",
						color: dim,
						fontWeight: bold ? 600 : 400
					}
				},
				h("span", { style: { whiteSpace: "nowrap", flex: "0 0 auto", opacity: bold ? 1 : 0.86 } }, label),
				h(
					"span",
					{
						style: {
							color: alert ? danger : strong,
							fontWeight: alert ? 600 : undefined,
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							textAlign: "right",
							flex: "1 1 auto",
							minWidth: 0
						}
					},
					[value, money]
						.filter((part) => typeof part === "string" && part.length > 0)
						.join(" · ")
				)
			);
		}

		function numberField(meter, settings, key, label) {
			return h(
				"label",
				{
					key: key,
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 6,
						fontSize: 10,
						color: dim
					}
				},
				h("span", null, label),
				h("input", {
					type: "number",
					min: 0,
					step: "0.01",
					value: settings[key],
					onChange: (event) => {
						const next = Number(event.target.value);
						meter.updateSettings({ [key]: Number.isFinite(next) && next >= 0 ? next : 0 });
					},
					style: {
						width: 62,
						padding: "1px 4px",
						fontSize: 10,
						textAlign: "right",
						color: strong,
						background: "transparent",
						border: "1px solid " + hairline,
						borderRadius: 4
					}
				})
			);
		}

		/**
		 * The plugin's own page under Settings → Plugins → dsh-token-float.
		 *
		 * Same settings document as the sidebar row, so a price edited here shows up
		 * there immediately (and vice versa) without a reload.
		 */
		function PluginConfig(props) {
			const [, bump] = React.useState(0);
			React.useEffect(() => subscribeSettings(() => bump((n) => n + 1)), []);

			if (props && props.view === "summary") return h("span", null, t_row("configSummary"));

			const settings = readSettings();
			const manual = settings.pricingMode === "manual";
			const inputStyle = {
				width: 96,
				padding: "4px 8px",
				fontSize: 12,
				color: strong,
				background: "transparent",
				border: "1px solid " + hairline,
				borderRadius: 6,
				fontVariantNumeric: "tabular-nums"
			};

			const line = (key, label, control) =>
				h(
					"div",
					{ key: key, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "9px 0", borderBottom: "1px solid " + hairline } },
					h("div", { style: { fontSize: 13, color: strong } }, label),
					control
				);

			const priceField = (key) =>
				h("input", {
					type: "number",
					min: 0,
					step: "0.01",
					value: String(settings[key]),
					onChange: (event) => {
						const next = Number(event.target.value);
						writeSettings({ [key]: Number.isFinite(next) && next >= 0 ? next : 0 });
					},
					style: inputStyle
				});

			const modes = [
				{ id: "auto", label: t_row("auto") },
				{ id: "manual", label: t_row("manual") }
			];

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column" } },
				line(
					"pricing",
					t_row("configPricing"),
					h(
						"div",
						{ style: { display: "inline-flex", gap: 6 } },
						modes.map((mode) =>
							h(
								"button",
								{
									key: mode.id,
									type: "button",
									onClick: () => writeSettings({ pricingMode: mode.id }),
									style: {
										fontSize: 12,
										padding: "4px 12px",
										borderRadius: 6,
										cursor: "pointer",
										border: "1px solid " + (settings.pricingMode === mode.id ? accent : hairline),
										background: settings.pricingMode === mode.id ? accent : "transparent",
										color: settings.pricingMode === mode.id ? "#fff" : strong
									}
								},
								mode.label
							)
						)
					)
				),
				manual ? line("priceInput", t_row("priceInput"), priceField("priceInput")) : null,
				manual ? line("priceCacheRead", t_row("priceCacheRead"), priceField("priceCacheRead")) : null,
				manual ? line("priceCacheWrite", t_row("priceCacheWrite"), priceField("priceCacheWrite")) : null,
				manual ? line("priceOutput", t_row("priceOutput"), priceField("priceOutput")) : null,
				manual
					? line(
							"currency",
							t_row("configCurrency"),
							h(
								"select",
								{
									value: settings.currency,
									onChange: (event) => writeSettings({ currency: event.target.value }),
									style: inputStyle
								},
								h("option", { value: "\u00a5" }, "\u00a5 CNY"),
								h("option", { value: "$" }, "$ USD")
							)
						)
					: null,
				line(
					"expanded",
					t_row("configExpanded"),
					h("input", {
						type: "checkbox",
						checked: settings.expanded,
						onChange: (event) => writeSettings({ expanded: event.target.checked })
					})
				),
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 14 } },
					h("span", { style: { fontSize: 11, color: dim, lineHeight: 1.5 } }, t_row("configNote")),
					h(
						"button",
						{
							type: "button",
							onClick: () => writeSettings({ ...DEFAULT_SETTINGS }),
							style: {
								flex: "0 0 auto",
								fontSize: 12,
								padding: "4px 10px",
								borderRadius: 6,
								cursor: "pointer",
								border: "1px solid " + hairline,
								background: "transparent",
								color: accent
							}
						},
						t_row("configReset")
					)
				)
			);
		}

		/** The pinned readout in the sidebar foot, directly above the account row. */
		function TokenRow({ meter, wide }) {
			const snapshot = useMeter(meter);
			const settings = snapshot.settings;

			const toggle = useCallback(() => {
				meter.updateSettings({ expanded: !meter.getSnapshot().settings.expanded });
			}, [meter]);

			if (!snapshot.active) return null;

			const currency = settings.pricingMode === "manual" ? settings.currency : "\u00a5";
			const wallet = snapshot.balance && snapshot.balance.currency === "USD" ? "$" : "\u00a5";
			const money = formatMoney(snapshot.cost, currency);
			// Wallet balance is the one number the user cannot fix from inside the app,
			// so it gets a warning badge on the collapsed row instead of hiding in the detail.
			const balanceValue = snapshot.balance ? Number(snapshot.balance.total) : NaN;
			const lowBalance = Number.isFinite(balanceValue) && balanceValue < LOW_BALANCE;
			const balanceText = snapshot.balance ? formatMoney(balanceValue, wallet) : "";
			const expanded = settings.expanded;
			const showDetail = expanded && wide !== false;
			const price = snapshot.tier.peak ? t_row("peakLabel") : t_row("offLabel");
			const countdown = formatDuration(snapshot.tier.switchAt);
			const switchLabel = snapshot.tier.switchPeak ? t_row("toPeak") : t_row("toOff");

			const head = h(
				"div",
				{
					role: "button",
					tabIndex: 0,
					title: snapshot.balance
						? t_row("balance") + " " + balanceText + (lowBalance ? " · " + t_row("lowBalance") : "")
						: t_row("title"),
					onClick: toggle,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							toggle();
						}
					},
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						minWidth: 0,
						cursor: "pointer",
						userSelect: "none"
					}
				},
				h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, color: dim } },
					h("span", {
						className: snapshot.burning ? "dsh-tf-dot dsh-tf-dot-on" : "dsh-tf-dot",
						style: {
							width: 7,
							height: 7,
							borderRadius: "50%",
							flex: "0 0 auto",
							boxSizing: "border-box",
							background: snapshot.burning ? accent : snapshot.running ? dim : "transparent",
							border: snapshot.burning || snapshot.running ? "none" : "1px solid " + dim
						}
					}),
					h(
						"span",
						{
							style: {
								fontSize: 11,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
								color: snapshot.burning ? accent : dim,
								fontWeight: snapshot.burning ? 600 : 400
							}
						},
						snapshot.running
							? snapshot.burning
								? t_row("running")
								: t_row("local")
							: wide === false
								? ""
								: t_row("idle")
					)
				),
				h(
					"span",
					{
						style: {
							display: "flex",
							alignItems: "baseline",
							gap: 4,
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap"
						}
					},
					wide === false
						? null
						: h("span", { style: { fontSize: 10, color: dim } }, formatTokens(snapshot.total)),
					h("span", { style: { fontSize: 11, fontWeight: 600, color: accent } }, money),
					lowBalance
						? h(
								"span",
								{
									style: {
										fontSize: 9,
										fontWeight: 700,
										lineHeight: "13px",
										color: "#fff",
										background: danger,
										borderRadius: 3,
										padding: "0 3px",
										flex: "0 0 auto"
									}
								},
								"!"
							)
						: null
				)
			);

			const detail = showDetail
				? h(
						"div",
						{
							"data-dsh-token-float": "detail",
							style: { marginTop: 4, borderTop: "1px solid " + hairline, paddingTop: 4 }
						},
						h(
							"div",
							{
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									fontSize: 10,
									lineHeight: "15px",
									color: dim,
									marginBottom: 2
								}
							},
							h("span", null, t_row("session")),
							h(
								"span",
								{ style: { color: snapshot.burning ? accent : dim, fontWeight: snapshot.burning ? 600 : 400 } },
								snapshot.running ? (snapshot.burning ? t_row("running") : t_row("local")) : t_row("idle")
							)
						),
						meterRow(t_row("rowInput"), formatTokens(snapshot.usage.miss), formatMoney((snapshot.usage.miss * priceMiss(snapshot, settings)) / 1e6, currency)),
						meterRow(
							t_row("rowCacheRead"),
							formatTokens(snapshot.usage.hit),
							formatMoney((snapshot.usage.hit * priceHit(snapshot, settings)) / 1e6, currency)
						),
						meterRow(
							t_row("rowCacheWrite"),
							formatTokens(snapshot.usage.write),
							formatMoney((snapshot.usage.write * priceMiss(snapshot, settings)) / 1e6, currency)
						),
						meterRow(
							t_row("rowOutput"),
							formatTokens(snapshot.usage.out),
							formatMoney((snapshot.usage.out * priceOut(snapshot, settings)) / 1e6, currency)
						),
						meterRow(t_row("total"), formatTokens(snapshot.total), money, true),
						meterRow(t_row("today"), "", formatMoney(snapshot.today, currency)),
						snapshot.balance
							? meterRow(
									t_row("balance"),
									snapshot.balance.granted > 0
										? t_row("bonus") + " " + formatMoney(snapshot.balance.granted, wallet)
										: "",
									formatMoney(snapshot.balance.total, wallet),
									true,
									lowBalance
								)
							: null,
						snapshot.lastTurn === null
							? null
							: meterRow(t_row("lastTurn"), "", formatMoney(snapshot.lastTurn, currency)),
						snapshot.context ? contextLine(snapshot) : null,
						h(
							"div",
							{
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "baseline",
									gap: 10,
									fontSize: 10,
									lineHeight: "15px",
									color: dim
								}
							},
							h("span", { style: { whiteSpace: "nowrap", flex: "0 0 auto", opacity: 0.86 } }, t_row("peak")),
							h(
								"span",
								{
									style: {
										fontVariantNumeric: "tabular-nums",
										whiteSpace: "normal",
										wordBreak: "break-word",
										textAlign: "right",
										flex: "1 1 auto",
										minWidth: 0,
										lineHeight: "16px"
									}
								},
								(countdown ? price + " · " + switchLabel + " " + countdown : price) +
									" · " +
									snapshot.model.name
							)
						),
						settings.pricingOpen ? pricingBlock(meter, snapshot, settings, currency) : null,
						h(
							"div",
							{
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginTop: 4
								}
							},
							h(
								"button",
								{
									type: "button",
									onClick: (event) => {
										event.stopPropagation();
										meter.updateSettings({ pricingOpen: !meter.getSnapshot().settings.pricingOpen });
									},
									style: {
										border: "none",
										background: "transparent",
										color: accent,
										fontSize: 11,
										cursor: "pointer",
										padding: 0
									}
								},
								t_row("pricing")
							),
							h("span", { style: { fontSize: 10, color: dim, opacity: 0.8 } }, t_row("note"))
						)
					)
				: null;

			return h(
				"div",
				{
					style: {
						width: "100%",
						minWidth: 0,
						boxSizing: "border-box",
						padding: wide === false ? "4px 2px" : "6px 8px",
						borderRadius: "var(--dsw-radius-md, 8px)",
						color: strong,
						lineHeight: "16px"
					}
				},
				head,
				detail
			);
		}

		/** Effective unit prices, mirroring the meter's own resolution (display only). */
		function table(snapshot) {
			const entry = PRICING[snapshot.model.kind] ?? PRICING.flash;
			const tier = snapshot.tier.peak ? entry.peak : entry.off;
			return { hit: tier.hit, miss: tier.miss, out: tier.out };
		}

		function priceMiss(snapshot, settings) {
			return settings.pricingMode === "manual" ? settings.priceInput : table(snapshot).miss;
		}

		function priceHit(snapshot, settings) {
			return settings.pricingMode === "manual" ? settings.priceCacheRead : table(snapshot).hit;
		}

		function priceOut(snapshot, settings) {
			return settings.pricingMode === "manual" ? settings.priceOutput : table(snapshot).out;
		}

		function pricingBlock(meter, snapshot, settings, currency) {
			const manual = settings.pricingMode === "manual";
			const unit = table(snapshot);
			return h(
				"div",
				{
					style: {
						marginTop: 6,
						padding: "6px 8px",
						borderRadius: 6,
						background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03))"
					}
				},
				h(
					"div",
					{ style: { fontSize: 9, color: dim, marginBottom: 4 } },
					manual ? t_row("manualHint") : t_row("pricingHint")
				),
				manual
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 2 } },
							numberField(meter, settings, "priceInput", t_row("priceInput")),
							numberField(meter, settings, "priceCacheRead", t_row("priceCacheRead")),
							numberField(meter, settings, "priceCacheWrite", t_row("priceCacheWrite")),
							numberField(meter, settings, "priceOutput", t_row("priceOutput")),
							h(
								"div",
								{ style: { display: "flex", justifyContent: "space-between", marginTop: 2 } },
								h(
									"select",
									{
										value: settings.currency,
										onChange: (event) => meter.updateSettings({ currency: event.target.value }),
										style: {
											fontSize: 10,
											color: strong,
											background: "transparent",
											border: "1px solid " + hairline,
											borderRadius: 4
										}
									},
									h("option", { value: "\u00a5" }, "\u00a5 CNY"),
									h("option", { value: "$" }, "$ USD")
								),
								h(
									"button",
									{
										type: "button",
										onClick: (event) => {
											event.stopPropagation();
											meter.updateSettings({ pricingMode: "auto", pricingOpen: false });
										},
										style: {
											border: "none",
											background: "transparent",
											color: accent,
											fontSize: 10,
											cursor: "pointer",
											padding: 0
										}
									},
									t_row("useAuto")
								)
							)
						)
					: h(
							"div",
							null,
							h(
								"div",
								{ style: { fontSize: 10, color: strong, fontVariantNumeric: "tabular-nums" } },
								snapshot.model.name +
									" · " +
									(snapshot.tier.peak ? t_row("peakLabel") : t_row("offLabel")) +
									" · " +
									t_row("priceInput") +
									" " +
									currency +
									unit.miss +
									" / " +
									t_row("priceCacheRead") +
									" " +
									currency +
									unit.hit +
									" / " +
									t_row("priceOutput") +
									" " +
									currency +
									unit.out
							),
							h(
								"button",
								{
									type: "button",
									onClick: (event) => {
										event.stopPropagation();
										meter.updateSettings({ pricingMode: "manual" });
									},
									style: {
										marginTop: 4,
										border: "none",
										background: "transparent",
										color: accent,
										fontSize: 10,
										cursor: "pointer",
										padding: 0
									}
								},
								t_row("useManual")
							)
						)
			);
		}

		function contextLine(snapshot) {
			const percent = formatPercent(snapshot.context.used, snapshot.context.window);
			return h(
				"div",
				{
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "baseline",
						gap: 10,
						fontSize: 11,
						lineHeight: "18px",
						color: dim
					}
				},
				h("span", { style: { whiteSpace: "nowrap", flex: "0 0 auto", opacity: 0.86 } }, t_row("context")),
				h(
					"span",
					{
						style: {
							color: strong,
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap",
							textAlign: "right",
							flex: "1 1 auto",
							minWidth: 0
						}
					},
					(percent ? percent + " · " : "") +
						formatTokens(snapshot.context.used) +
						"/" +
						formatTokens(snapshot.context.window)
				)
			);
		}

		const inject = ["slots", "locale", "uiSession", "remote", "remote.account"];

		function apply(ctx) {
			try {
				// Sweep the leftovers an earlier diagnostic build appended to <body>.
				document.getElementById("tf-diag")?.remove();
				for (const node of document.querySelectorAll("body > pre, body > div")) {
					if (node.hasAttribute("data-dsh-token-float")) continue;
					const text = typeof node.textContent === "string" ? node.textContent : "";
					if (text.startsWith("[token-float]") || text === "TF-loaded") node.remove();
				}
			} catch {}
			try {
				// One shared sheet: the "consuming tokens" dot breathes while a turn runs.
				if (!document.getElementById("dsh-token-float-style")) {
					const style = document.createElement("style");
					style.id = "dsh-token-float-style";
					style.textContent =
						"@keyframes dsh-tf-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.55);opacity:.35}}" +
						".dsh-tf-dot{display:inline-block}.dsh-tf-dot-on{animation:dsh-tf-pulse 1.3s ease-in-out infinite}";
					document.head.appendChild(style);
				}
			} catch {}
			try {
				ctx.effect(
					() =>
						ctx.locale.register(NS, {
							zh,
							en
						}),
					"token-float: dictionaries"
				);
				const meter = createMeter(ctx);
				ctx.effect(
					() => {
						const offLocale = ctx.locale.subscribe(() => meter.refresh());
						return () => {
							offLocale();
							meter.dispose();
						};
					},
					"token-float: meter lifetime"
				);
				ctx.slots.inject("sidebar.footer.action", () =>
					ctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: "token-float",
							inject: () => ({ meter })
						},
						TokenRow
					)
				);
				// Settings → Plugins → this package. `plugins.bundle.config` is a KEYED slot:
				// the key is the bundle's package name and the `id` field must stay unset —
				// giving it an `id` makes the whole web entry fail to boot.
				ctx.slots.inject("plugins.bundle.config", () =>
					ctx.slots.register(
						{
							name: "plugins.bundle.config",
							key: PKG_NAME,
							locale: NS,
							label: () => t_row("title")
						},
						PluginConfig
					)
				);
			} catch (error) {
				// A broken meter must never take the sidebar down with it.
				try {
					console.error("[token-float]", error);
				} catch {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "token-float";
		return module.exports;
	}
});
