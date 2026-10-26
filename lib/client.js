window.__ModuleLoader__.load({
	id: "dsh-diff-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const NS = "diff-review";
		const TAB_ID = "dsh-diff-review:review";
		const API_PREFIX = "diff-review/api";
		const POLL_MS = 1200;

		const inject = ["slots", "locale", "sessions", "sidebarRight", "sidebarRightTabs"];

		/* ------------------------------------------------------------ locale -- */

		const zh = {
			"title": "改动审查",
			"empty": "暂无待审查的文件改动",
			"emptyHint": "当模型准备写入或修改文件时，会先在这里请你确认。",
			"accept": "接受",
			"reject": "拒绝",
			"allowTurn": "本轮全允许",
			"allowTurnHint": "接受这一项，并且本轮提问里后续的写入都不再询问（下一次提问会恢复确认）",
			"turnAllowed": "本轮已放行后续写入",
			"create": "新增",
			"update": "修改",
			"delete": "删除",
			"unified": "改动视图",
			"full": "全文视图",
			"truncated": "文件过大，内容已截断",
			"notReviewable": "改动过大，仅显示统计",
			"commandOnly": "命令操作，无法预知最终内容",
			"waiting": "等待模型继续…",
			"gapLine": "⋯ 未改动的 {n} 行",
			"before": "原文",
			"after": "新文",
			"shell": "命令",
			"emptyFile": "（空文件）",
			"deletedFile": "（文件将被删除）",
			"error": "请求失败：{msg}",
			"diag": "闸门已检查 {calls} 次 · 最近工具 {tool} · 结果 {reason}",
			"diagHead": "闸门自检",
			"diagArm": "布防 {armed} · 心跳龄 {age}ms · 待审 {pending} · 会话 {session}",
			"diagTools": "闸门见过的工具：{tools}",
			"diagShape": "调用形态：{shape}",
			"diagRecent": "最近调用：{recent}",
		};

		const en = {
			"title": "Diff review",
			"empty": "No changes waiting for review",
			"emptyHint": "When the model is about to write or edit a file, it asks here first.",
			"accept": "Accept",
			"reject": "Reject",
			"allowTurn": "Allow rest of this request",
			"allowTurnHint": "Accept this one and stop asking for later writes in this same request; the next message asks again",
			"turnAllowed": "Later writes in this request are allowed",
			"create": "New",
			"update": "Edit",
			"delete": "Delete",
			"unified": "Changes",
			"full": "Full file",
			"truncated": "File too large, content truncated",
			"notReviewable": "Change too large, statistics only",
			"commandOnly": "Command writes; the result is not knowable up front",
			"waiting": "Waiting for the model…",
			"gapLine": "⋯ {n} unchanged lines",
			"before": "Before",
			"after": "After",
			"shell": "Command",
			"emptyFile": "(empty file)",
			"deletedFile": "(file will be removed)",
			"error": "Request failed: {msg}",
			"diag": "Gate checked {calls} times · last tool {tool} · outcome {reason}",
			"diagHead": "Gate self-check",
			"diagArm": "Armed {armed} · heartbeat age {age}ms · pending {pending} · session {session}",
			"diagTools": "Tools seen by the gate: {tools}",
			"diagShape": "Call shape: {shape}",
			"diagRecent": "Recent calls: {recent}",
		};

		/* --------------------------------------------------------------- url -- */

		function directoryBase(raw) {
			try {
				const url = new URL(raw);
				url.search = "";
				url.hash = "";
				if (!url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/[^/]*$/, "");
				return url.toString();
			} catch {
				return "/";
			}
		}

		function hostHttpBase() {
			const base = typeof document !== "undefined" && typeof document.baseURI === "string"
				? document.baseURI
				: "/";
			return directoryBase(base);
		}

		async function apiCall(method, payload) {
			const url = new URL(API_PREFIX + "/" + method, hostHttpBase());
			const response = await fetch(url.toString(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload ?? {}),
				credentials: "same-origin",
			});
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error("diff-review: bad response (" + response.status + ")");
			}
			if (body === null || typeof body !== "object" || body.ok !== true) {
				const message = body && body.error && body.error.message ? body.error.message : "request failed";
				throw new Error("diff-review: " + message);
			}
			return body.value;
		}

		/* ------------------------------------------------------------- store -- */

		function createStore() {
			let state = {
				changes: [],
				detail: null,
				detailId: null,
				error: null,
				ready: false,
				diag: null,
				// The poller asks once for every open tab, so it cannot name a
				// session: the host ships the whole `turn` table and each tab looks
				// up its own id here.
				turns: {},
				wavedThrough: {},
			};
			const listeners = new Set();
			const emit = () => {
				for (const listener of listeners) listener();
			};
			return {
				get: () => state,
				set: (patch) => {
					state = Object.assign({}, state, patch);
					emit();
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
		}

		function useStore(store) {
			return React.useSyncExternalStore(store.subscribe, store.get, store.get);
		}

		/* --------------------------------------------------------------- css -- */

		const CSS = `
/*
 * Font stack: the host exposes --dsw-font-mono nowhere (grep of the shipping
 * bundle finds the *name* only inside plugin strings, never a definition), so
 * the old declaration fell through to the generic "monospace" keyword, which
 * Chromium on Windows resolves to Courier New — the flat, wide face the user
 * called uncomfortable. Naming the faces directly keeps the panel on a coding
 * font that is actually installed, and the CJK tail stops Chinese text from
 * falling back to a different family per glyph.
 *
 * Order is preference, not availability: a face that is missing is skipped by
 * the browser at no cost, so JetBrains Mono and Fira Code lead the list and take
 * over the moment either one is installed. Cascadia Code follows because it
 * ships with Windows Terminal and is what the host renders code in.
 */
.dshr-root{--dshr-mono:"JetBrains Mono","Fira Code","Cascadia Code","Cascadia Mono",Consolas,"Microsoft YaHei UI","Microsoft YaHei",ui-monospace,monospace;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);-webkit-font-smoothing:antialiased}
.dshr-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap;min-height:46px}
.dshr-file{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dshr-mono);font-size:12px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary)}
.dshr-dir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dshr-mono);font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dshr-badge{flex:none;border-radius:5px;padding:1px 7px;font-size:11px;line-height:18px;font-weight:600;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.dshr-badge[data-op="create"]{background:var(--dsw-alias-file-diff-added-gutter);color:var(--dsw-alias-code-diff-added)}
.dshr-badge[data-op="delete"]{background:var(--dsw-alias-file-diff-deleted-gutter);color:var(--dsw-alias-code-diff-deleted)}
.dshr-stat{flex:none;font-family:var(--dshr-mono);font-size:12px;font-variant-numeric:tabular-nums}
.dshr-add{color:var(--dsw-alias-code-diff-added)}
.dshr-del{color:var(--dsw-alias-code-diff-deleted)}
.dshr-btn{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 12px;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)),border-color .12s}
.dshr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}
.dshr-btn:disabled{opacity:.55;cursor:default}
.dshr-btn[data-primary="true"]{background:var(--dsw-alias-state-success-primary,#2f9e44);border-color:transparent;color:#fff;font-weight:600}
.dshr-btn[data-primary="true"]:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-state-success-primary,#2f9e44)}
.dshr-btn[data-danger="true"]{background:transparent;border-color:var(--dsw-alias-state-error-primary,#e03131);color:var(--dsw-alias-state-error-primary,#e03131)}
.dshr-btn[data-ghost="true"]{background:transparent;color:var(--dsw-alias-label-secondary)}
.dshr-btn[data-ghost="true"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshr-layout{display:flex;flex:1 1 auto;min-height:0}
.dshr-list{flex:none;width:200px;min-width:130px;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:6px}
.dshr-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;cursor:pointer;border-left:2px solid transparent}
.dshr-item[data-active="true"]{background:var(--dsw-alias-bg-layer-3);border-left-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-code-diff-added))}
.dshr-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dshr-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dshr-mono);font-size:12px;line-height:17px}
.dshr-item-meta{font-family:var(--dshr-mono);font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dshr-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dshr-code{flex:1 1 auto;overflow:auto;font-family:var(--dshr-mono);font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;font-size:13px;line-height:20px;padding-bottom:20px}
.dshr-row{display:flex;min-width:max-content}
.dshr-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dshr-paint{flex:none;width:3px;user-select:none}
.dshr-row[data-t="add"] .dshr-paint{background:var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-code-diff-added))}
.dshr-row[data-t="del"] .dshr-paint{background:var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-code-diff-deleted))}
.dshr-gutter{flex:none;width:46px;text-align:right;padding-right:10px;color:var(--dsw-alias-label-tertiary);user-select:none;font-size:12px;font-variant-numeric:tabular-nums}
.dshr-marker{flex:none;width:16px;text-align:center;user-select:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshr-text{flex:1 1 auto;white-space:pre;padding-right:28px;tab-size:4}
.dshr-row[data-t="add"] .dshr-text,.dshr-row[data-t="add"] .dshr-gutter,.dshr-row[data-t="add"] .dshr-marker{background:var(--dsw-alias-file-diff-added-bg)}
.dshr-row[data-t="add"] .dshr-marker{color:var(--dsw-alias-file-diff-added-marker)}
.dshr-row[data-t="del"] .dshr-text,.dshr-row[data-t="del"] .dshr-gutter,.dshr-row[data-t="del"] .dshr-marker{background:var(--dsw-alias-file-diff-deleted-bg)}
.dshr-row[data-t="del"] .dshr-marker{color:var(--dsw-alias-file-diff-deleted-marker)}
/*
 * The changed span inside a rewritten line. Multiplied over the row tint rather
 * than replacing it, so a line keeps its add/delete colour while the exact
 * characters that differ stand out — the marking an IDE editor gives a modified
 * line. Fixed rgba instead of a token because the host has no inline-diff shade;
 * the alphas are low enough to read correctly on both the light and the dark
 * theme background.
 */
.dshr-inline{border-radius:2px}
.dshr-row[data-t="add"] .dshr-inline{background:rgba(1,162,65,.26)}
.dshr-row[data-t="del"] .dshr-inline{background:rgba(186,39,35,.26)}
.dshr-gap{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);font-family:var(--dshr-mono);font-size:11px;line-height:18px;padding:2px 12px;font-style:italic}
.dshr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:0;padding:28px 20px;overflow:auto;color:var(--dsw-alias-label-secondary)}
.dshr-empty-inner{display:flex;flex-direction:column;align-items:stretch;gap:10px;width:100%;max-width:520px;text-align:left}
.dshr-empty-title{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);text-align:center}
.dshr-empty-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dshr-diagcard{margin-top:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;display:flex;flex-direction:column;gap:4px;overflow:hidden}
.dshr-diaghead{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dshr-diagline{font-family:var(--dshr-mono);font-variant-ligatures:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dshr-note{padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-error{color:var(--dsw-alias-state-error-primary,#e03131)}
.dshr-split{display:flex;flex:1 1 auto;min-height:0}
.dshr-pane{display:flex;flex-direction:column;flex:1 1 50%;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}
.dshr-pane:last-child{border-right:none}
.dshr-pane-head{flex:none;padding:3px 12px;font-size:10px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-split .dshr-code{flex:1 1 auto;min-width:0;border-right:none}
.dshr-cmd{display:flex;gap:8px;align-items:flex-start;padding:7px 12px;font-family:var(--dshr-mono);font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);word-break:break-all}
.dshr-cmd-label{flex:none;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.06em;font-size:10px;padding-top:2px}
.dshr-cmd-text{flex:1 1 auto;white-space:pre-wrap;color:var(--dsw-alias-label-primary)}
`;

		function ensureCss() {
			if (typeof document === "undefined") return;
			const selector = 'style[data-plugin-css="' + NS + '"]';
			if (document.querySelector(selector) !== null) return;
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-diff-review";
			style.dataset.pluginCss = NS;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/* --------------------------------------------------------- component -- */

		function fmt(n) {
			return String(n);
		}

		/**
		 * Word-level emphasis, the way an IDE marks a rewritten line: the whole line
		 * gets the diff background, and the part that actually changed gets a
		 * stronger one. Without it a one-character edit looks identical to a full
		 * line rewrite at a glance.
		 *
		 * Rows inside one changed hunk are paired by best similarity, not by index:
		 * a pure insertion shifts every following row, so index pairing would compare
		 * unrelated lines and then paint whatever prefix they happened to share. Each
		 * removed row claims the most similar added row still free, above a threshold;
		 * below it nothing is emphasised, which is what an IDE does for a wholesale
		 * rewrite. The shared prefix and suffix are trimmed, so only the differing
		 * span keeps the stronger shade.
		 */
		const INLINE_SIMILARITY = 0.4;

		function sharedSpan(before, after) {
			let head = 0;
			const limit = Math.min(before.length, after.length);
			while (head < limit && before[head] === after[head]) head += 1;
			let tail = 0;
			while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
			const longest = Math.max(before.length, after.length);
			return { head: head, tail: tail, score: head + tail === 0 || longest === 0 ? 0 : (head + tail) / longest };
		}

		function inlineRanges(rows) {
			const spans = new Map();
			let index = 0;
			while (index < rows.length) {
				if (rows[index].t !== "del") {
					index += 1;
					continue;
				}
				const delStart = index;
				while (index < rows.length && rows[index].t === "del") index += 1;
				const addStart = index;
				while (index < rows.length && rows[index].t === "add") index += 1;
				const delCount = addStart - delStart;
				const addCount = index - addStart;
				if (delCount === 0 || addCount === 0) continue;
				const claimed = new Set();
				for (let left = 0; left < delCount; left += 1) {
					const before = String(rows[delStart + left].text);
					let best = -1;
					let bestSpan = null;
					for (let right = 0; right < addCount; right += 1) {
						if (claimed.has(right)) continue;
						const after = String(rows[addStart + right].text);
						const span = sharedSpan(before, after);
						if (span.score < INLINE_SIMILARITY) continue;
						if (bestSpan === null || span.score > bestSpan.score) {
							best = right;
							bestSpan = span;
						}
					}
					if (best < 0 || bestSpan === null) continue;
					claimed.add(best);
					const after = String(rows[addStart + best].text);
					spans.set(delStart + left, { start: bestSpan.head, end: before.length - bestSpan.tail });
					spans.set(addStart + best, { start: bestSpan.head, end: after.length - bestSpan.tail });
				}
			}
			return spans;
		}

		function rowText(text, span) {
			if (!span || span.end <= span.start) return text === "" ? "\u00a0" : text;
			return [
				h("span", { key: "p" }, text.slice(0, span.start)),
				h("span", { key: "m", className: "dshr-inline" }, text.slice(span.start, span.end)),
				h("span", { key: "s" }, text.slice(span.end)),
			];
		}

		function DiffRow(row, index, t, span) {
			if (row.t === "gap") {
				return h(
					"div",
					{ key: "gap" + index, className: "dshr-gap" },
					t("gapLine").replace("{n}", fmt(row.count)),
				);
			}
			const marker = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
			return h(
				"div",
				{ key: "r" + index, className: "dshr-row", "data-t": row.t },
				h("span", { className: "dshr-gutter" }, row.a === null ? "" : fmt(row.a)),
				h("span", { className: "dshr-gutter" }, row.b === null ? "" : fmt(row.b)),
				h("span", { className: "dshr-marker" }, marker),
				h("span", { className: "dshr-text" }, rowText(row.text, span)),
			);
		}

		/**
		 * One full-text pane. Line numbers follow the file itself; the change marks
		 * come from the hunk rows so the pane shows exactly which lines the pending
		 * write adds or removes, the way an editor paints its gutter.
		 *
		 * Takes an options object rather than positional arguments because the two
		 * panes now have to share one scroll position: the caller hands each pane its
		 * own scroller ref and an onScroll handler that mirrors the other side.
		 */
		function FullFilePane(options) {
			const text = options.text;
			const side = options.side;
			const marked = options.marked;
			const t = options.t;
			const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			return h(
				"div",
				{ className: "dshr-pane", key: side },
				h("div", { className: "dshr-pane-head" }, t(side === "a" ? "before" : "after")),
				h(
					"div",
					{ className: "dshr-code dshr-full", ref: options.scrollerRef, onScroll: options.onScroll },
					lines.length === 0
						? h("div", { className: "dshr-gap" }, t("emptyFile"))
						: lines.map((line, index) => {
								const kind = marked.has(index + 1) ? (side === "a" ? "del" : "add") : "equal";
								return h(
									"div",
									{ key: side + index, className: "dshr-row", "data-t": kind },
									h("span", { className: "dshr-paint" }),
									h("span", { className: "dshr-gutter" }, fmt(index + 1)),
									h("span", { className: "dshr-text" }, line === "" ? "\u00a0" : line),
								);
							}),
				),
			);
		}

		/**
		 * The side-by-side full-file view. Both panes are independent scrollers, so a
		 * reader who drags one wheel expects the other to follow — two panes drifting
		 * apart makes it impossible to tell which line was actually rewritten. The
		 * lock flag stops the mirrored write from bouncing back as a second scroll
		 * event and fighting the pane the reader is holding.
		 */
		function SplitView(props) {
			const leftRef = React.useRef(null);
			const rightRef = React.useRef(null);
			const lock = React.useRef(false);

			const mirror = React.useCallback((from, to) => {
				if (lock.current) return;
				const source = from.current;
				const target = to.current;
				if (source === null || target === null) return;
				lock.current = true;
				target.scrollTop = source.scrollTop;
				target.scrollLeft = source.scrollLeft;
				// Release on the next frame: the mirrored assignment fires its own scroll
				// event after this handler returns, and releasing synchronously would let
				// that event start a second mirror pass.
				if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
					window.requestAnimationFrame(() => { lock.current = false; });
				} else {
					lock.current = false;
				}
			}, []);

			return h(
				"div",
				{ className: "dshr-split" },
				FullFilePane({
					text: props.before,
					side: "a",
					marked: props.markedA,
					t: props.t,
					scrollerRef: leftRef,
					onScroll: () => mirror(leftRef, rightRef),
				}),
				props.deleted
					? h(
							"div",
							{ className: "dshr-pane", key: "b" },
							h("div", { className: "dshr-pane-head" }, props.t("after")),
							h("div", { className: "dshr-code dshr-full" }, h("div", { className: "dshr-gap" }, props.t("deletedFile"))),
						)
					: FullFilePane({
							text: props.after,
							side: "b",
							marked: props.markedB,
							t: props.t,
							scrollerRef: rightRef,
							onScroll: () => mirror(rightRef, leftRef),
						}),
			);
		}

		/**
		 * A render crash inside the panel must never leave a blank pane: the agent is
		 * parked until someone decides, so a silent failure reads as "stuck" and
		 * hides the very error that would explain it.
		 */
		class TabBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error: error };
			}

			render() {
				if (this.state.error !== null) {
					const message = this.state.error instanceof Error
						? this.state.error.message
						: String(this.state.error);
					return h(
						"div",
						{ className: "dshr-root" },
						h(
							"div",
							{ className: "dshr-empty" },
							h("div", { className: "dshr-empty-title" }, this.props.t("error").replace("{msg}", message)),
							h("div", { className: "dshr-empty-hint" }, this.props.t("emptyHint")),
						),
					);
				}
				return this.props.children;
			}
		}

		function TabTitle(props) {
			const t = props.t;
			const snapshot = useStore(props.store);
			const changes = snapshot.changes;
			const text = t("title");
			return h("span", null, changes.length > 0 ? text + " (" + changes.length + ")" : text);
		}

		function DiffReviewTab(props) {
			const store = props.store;
			const t = props.t;
			const sessionId = props.sessionId;
			const snapshot = useStore(store);
			const [view, setView] = React.useState("unified");
			const [selectedId, setSelectedId] = React.useState(null);
			const [busy, setBusy] = React.useState(null);

			const changes = React.useMemo(
				() => snapshot.changes.filter((item) => sessionId === undefined || item.sessionId === sessionId),
				[snapshot.changes, sessionId],
			);

			const active = React.useMemo(() => {
				if (changes.length === 0) return null;
				const match = changes.find((item) => item.id === selectedId);
				return match ?? changes[0];
			}, [changes, selectedId]);

			React.useEffect(() => {
				if (active === null) return;
				if (snapshot.detailId === active.id && snapshot.detail !== null) return;
				store.load(active.id);
			}, [active === null ? null : active.id, snapshot.detailId, snapshot.detail, store]);

			const detail = snapshot.detailId !== null && active !== null && snapshot.detailId === active.id
				? snapshot.detail
				: null;
			// A command-level review has no rows to draw, so the view toggle would be a
			// button that changes nothing: hide it there rather than lie about it.
			const hasRows = detail !== null && Array.isArray(detail.rows) && detail.rows.length > 0;

			// Which session this pane is reviewing for: the change itself knows, and
			// the tab falls back to its own id. The poller cannot name a session in
			// its request, so the host ships whole tables and the lookup happens here.
			const reviewSession = active !== null && typeof active.sessionId === "string" && active.sessionId !== ""
				? active.sessionId
				: sessionId;
			const turnForSession = (snapshotValue, sid) => {
				if (sid === undefined) return null;
				const table = snapshotValue.turns;
				if (table === null || typeof table !== "object") return null;
				const value = table[sid];
				return typeof value === "number" ? value : null;
			};
			const isWavedThrough = (snapshotValue, sid) => {
				if (sid === undefined) return false;
				const seen = turnForSession(snapshotValue, sid);
				if (seen === null) return false;
				const table = snapshotValue.wavedThrough;
				if (table === null || typeof table !== "object") return false;
				return table[sid] === seen;
			};

			const decide = async (item, action) => {
				if (item === undefined || item === null) return;
				setBusy(item.id);
				try {
					await apiCall("decide", { id: item.id, action: action });
				} catch (error) {
					store.set({ error: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(null);
					store.refresh();
				}
			};

			if (changes.length === 0) {
				const diag = snapshot.diag;
				const diagLines = diag !== null && typeof diag === "object"
					? [
							h(
								"div",
								{ className: "dshr-diagline", key: "d1" },
								t("diag")
									.replace("{calls}", String(diag.calls ?? 0))
									.replace("{tool}", String(diag.tool ?? "-"))
									.replace("{reason}", String(diag.reason ?? "-")),
							),
							h(
								"div",
								{ className: "dshr-diagline", key: "d2" },
								t("diagArm")
									.replace("{armed}", diag.armed === true ? "yes" : "no")
									.replace("{age}", String(diag.heartbeatAgeMs ?? -1))
									.replace("{pending}", String(diag.pending ?? 0))
									.replace("{session}", String(diag.session ?? "-")),
							),
							h(
								"div",
								{ className: "dshr-diagline", key: "d3" },
								t("diagTools").replace("{tools}", Array.isArray(diag.tools) ? diag.tools.join(", ") : "-"),
							),
							h(
								"div",
								{ className: "dshr-diagline", key: "d4" },
								t("diagShape").replace(
									"{shape}",
									diag.shape === null || typeof diag.shape !== "object"
										? "-"
										: "exec[" + String((diag.shape.exec ?? []).join(",")) + "] agent="
											+ (diag.shape.hasAgent === true ? "yes" : "no") + " session["
											+ String((diag.shape.sessionKeys ?? []).join(",")) + "]",
								),
							),
							h(
								"div",
								{ className: "dshr-diagline", key: "d5" },
								t("diagRecent").replace(
									"{recent}",
									Array.isArray(diag.recent) && diag.recent.length > 0
										? diag.recent
												.map((item) => String(item.tool ?? "?") + ":" + String(item.reason ?? "?"))
												.join(" → ")
										: "-",
								),
							),
						]
					: [];
				return h(
					"div",
					{ className: "dshr-root" },
					snapshot.error === null
						? null
						: h("div", { className: "dshr-note dshr-error" }, t("error").replace("{msg}", snapshot.error)),
					h(
						"div",
						{ className: "dshr-empty" },
						h(
							"div",
							{ className: "dshr-empty-inner" },
							h("div", { className: "dshr-empty-title" }, t("empty")),
							h("div", { className: "dshr-empty-hint" }, t("emptyHint")),
							diagLines.length === 0
								? null
								: h(
										"div",
										{ className: "dshr-diagcard" },
										h("div", { className: "dshr-diaghead" }, t("diagHead")),
										diagLines,
									),
						),
					),
				);
			}

			const header = h(
				"div",
				{ className: "dshr-bar" },
				active !== null
					? h(
							React.Fragment,
							null,
							h("span", { className: "dshr-badge", "data-op": active.op }, t(active.op)),
							// Split name from directory the way an editor shows a tab: the
							// file name is what a reader looks for, the path is context.
							// A fileless match (`iex $code`) has no file at all; naming it
							// after the verb made the panel read as if a file called `iex`
							// were about to be created, so the badge carries the whole
							// identity and the command block below says the rest.
							active.displayPath === ""
								? null
								: h(
										"span",
										{ className: "dshr-file", title: active.displayPath },
										h(
											"span",
											{ className: "dshr-name" },
											String(active.displayPath).split(/[\\/]/).pop(),
										),
										h(
											"span",
											{ className: "dshr-dir" },
											String(active.displayPath).replace(/[\\/][^\\/]*$/, "") || "/",
										),
									),
							// `+0 -0` is not a statistic, it is noise from a review that has no lines
							// to count: a command whose result only exists once the shell runs it.
							active.added === 0 && active.removed === 0
								? null
								: h(
										"span",
										{ className: "dshr-stat" },
										h("span", { className: "dshr-add" }, "+" + active.added),
										" ",
										h("span", { className: "dshr-del" }, "-" + active.removed),
									),
							hasRows
								? h(
										"button",
										{
											className: "dshr-btn",
											type: "button",
											"data-ghost": "true",
											onClick: () => setView(view === "unified" ? "full" : "unified"),
										},
										t(view === "unified" ? "full" : "unified"),
									)
								: null,
							// Offered only when the host knows which turn this is: the exemption
							// is keyed by turn and would never expire without one.
							turnForSession(snapshot, reviewSession) === null || isWavedThrough(snapshot, reviewSession)
								? null
								: h(
										"button",
										{
											className: "dshr-btn",
											type: "button",
											"data-ghost": "true",
											title: t("allowTurnHint"),
											disabled: busy === active.id,
											onClick: () => decide(active, "allowTurn"),
										},
										t("allowTurn"),
									),
							h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-danger": "true",
									disabled: busy === active.id,
									onClick: () => decide(active, "reject"),
								},
								t("reject"),
							),
							h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-primary": "true",
									disabled: busy === active.id,
									onClick: () => decide(active, "accept"),
								},
								t("accept"),
							),
						)
					: null,
			);

			const notes = [];
			if (snapshot.error !== null) notes.push(h("div", { className: "dshr-note dshr-error", key: "err" }, t("error").replace("{msg}", snapshot.error)));
			if (isWavedThrough(snapshot, reviewSession)) notes.push(h("div", { className: "dshr-note", key: "turn" }, t("turnAllowed")));
			if (active !== null && active.truncated) notes.push(h("div", { className: "dshr-note", key: "trunc" }, t("truncated")));
			// Two different statements, two different sentences: a shell command whose
			// result the shell decides later is not the same as a change too large to
			// draw, and saying the latter for the former is simply wrong.
			if (active !== null && active.reviewable === false) {
				notes.push(h("div", { className: "dshr-note", key: "big" }, t(active.reason === "shell-command" ? "commandOnly" : "notReviewable")));
			}
			// A shell change has no before/after text to compare: show the exact command
			// the user is approving, otherwise the panel would approve blindly.
			if (active !== null && typeof active.command === "string" && active.command !== "") {
				notes.push(
					h(
						"div",
						{ className: "dshr-cmd", key: "cmd" },
						h("span", { className: "dshr-cmd-label" }, t("shell")),
						h("code", { className: "dshr-cmd-text" }, active.command),
					),
				);
			}

			let body;
			if (active === null || detail === null) {
				body = h("div", { className: "dshr-empty" }, h("div", { className: "dshr-empty-hint" }, t("waiting")));
			} else if (!hasRows) {
				// Nothing to draw: a command-level review is fully described by the command
				// block above, and an empty code pane would read as a failed render.
				body = null;
			} else if (view === "full") {
				// Paint the changed lines inside each full file, so both panes keep the real
				// line numbers of the file instead of a renumbered diff side.
				const markedA = new Set();
				const markedB = new Set();
				for (const row of detail.rows) {
					if (row.t === "del" && row.a !== null) markedA.add(row.a);
					if (row.t === "add" && row.b !== null) markedB.add(row.b);
				}
				body = h(SplitView, {
					before: detail.before === null ? "" : detail.before,
					after: detail.after === null ? "" : detail.after,
					markedA,
					markedB,
					deleted: active.op === "delete" && (detail.after === null || detail.after === ""),
					t,
				});
			} else {
				const spans = inlineRanges(detail.rows);
				body = h(
					"div",
					{ className: "dshr-code" },
					detail.rows.map((row, index) => DiffRow(row, index, t, spans.get(index))),
				);
			}

			const list = changes.length > 1
				? h(
						"div",
						{ className: "dshr-list" },
						changes.map((item) =>
							h(
								"div",
								{
									key: item.id,
									className: "dshr-item",
									"data-active": String(active !== null && item.id === active.id),
									onClick: () => setSelectedId(item.id),
								},
								h(
									"span",
									{ className: "dshr-item-name", title: item.displayPath || item.command || "" },
									item.displayPath === "" || item.displayPath === undefined
										? t("shell")
										: item.displayPath.split(/[\\/]/).pop(),
								),
								h(
									"span",
									{ className: "dshr-item-meta" },
									// `+0 -0` is not a statistic: a command-level review has no
									// lines to count, so the meta line names the shape only.
									item.added === 0 && item.removed === 0
										? t(item.op)
										: t(item.op) + "  +" + item.added + " -" + item.removed,
								),
							),
						),
					)
				: null;

			return h(
				"div",
				{ className: "dshr-root" },
				header,
				notes,
				h("div", { className: "dshr-layout" }, list, h("div", { className: "dshr-main" }, body)),
			);
		}

		/* -------------------------------------------------------------- apply -- */

		function apply(ctx) {
			ensureCss();

			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "dsh-diff-review: dictionaries");

			const store = createStore();
			store.load = async (id) => {
				store.set({ detailId: id });
				try {
					const value = await apiCall("detail", { id: id });
					if (value && value.missing === true) {
						store.set({ detail: null });
						return;
					}
					store.set({ detail: value, error: null });
				} catch (error) {
					store.set({ detail: null, error: error instanceof Error ? error.message : String(error) });
				}
			};
			store.refresh = async () => {
				try {
					const value = await apiCall("list", {});
					const next = Array.isArray(value && value.changes) ? value.changes : [];
					const previousId = store.get().detailId;
					const stillThere = next.some((item) => item.id === previousId);
					store.set({
						changes: next,
						ready: true,
						error: null,
						detailId: stillThere ? previousId : null,
						detail: stillThere ? store.get().detail : null,
						// Whether the rest of this request is already waved through, so the
						// panel can say so instead of offering the button again.
						turns: value && typeof value.turns === "object" && value.turns !== null ? value.turns : {},
						wavedThrough: value && typeof value.wavedThrough === "object" && value.wavedThrough !== null ? value.wavedThrough : {},
					});
					if (!stillThere && next.length > 0) store.load(next[0].id);
				} catch (error) {
					store.set({ ready: true, error: error instanceof Error ? error.message : String(error) });
				}
			};

			/* ---------------------------------------------------- tab open -- */

			/**
			 * Put the review tab in front of the user.
			 *
			 * Two entry points, because they cover different states of the
			 * sidebar. `openTabIn(sessionId, …)` targets the session the change
			 * belongs to but silently does nothing when that session's store was
			 * never adopted — which is the state right after a restart, so relying
			 * on it alone left the panel hidden and the review looked broken.
			 * `openTab(kind, …)` targets whatever surface is mounted and throws
			 * when nothing is mounted, so it reports the failure we can retry.
			 * Both dedupe a page tab on (kind, contentId), so calling the pair
			 * focuses one tab instead of spawning two.
			 */
			const openReviewTab = (sid) => {
				try {
					if (typeof ctx.sidebarRight !== "undefined" && typeof ctx.sidebarRight.openTabIn === "function" && typeof sid === "string" && sid !== "") {
						ctx.sidebarRight.openTabIn(sid, TAB_ID, { params: {} });
					}
				} catch {
					/* the session may not be adopted yet: openTab below decides */
				}
				try {
					if (typeof ctx.sidebarRight !== "undefined" && typeof ctx.sidebarRight.openTab === "function") {
						ctx.sidebarRight.openTab(TAB_ID, { params: {} });
						return true;
					}
				} catch {
					/* no session surface is mounted: retry on the next beat */
				}
				return false;
			};

			let openTimer = null;
			/**
			 * Retry a few times, then stop. Three attempts cover the window in
			 * which the session surface is still adopting; retrying forever would
			 * fight a user who closed the tab on purpose.
			 */
			const OPEN_RETRY_MS = [120, 900, 2500];
			const scheduleOpen = (sid, attempt = 0) => {
				if (openTimer !== null) return;
				openTimer = window.setTimeout(() => {
					openTimer = null;
					if (openReviewTab(sid)) return;
					if (attempt + 1 < OPEN_RETRY_MS.length) scheduleOpen(sid, attempt + 1);
				}, OPEN_RETRY_MS[Math.min(attempt, OPEN_RETRY_MS.length - 1)]);
			};

			ctx.effect(() => {
				const known = new Set();
				let disposed = false;
				const tick = async () => {
					if (disposed) return;
					try {
						const value = await apiCall("list", {});
						const next = Array.isArray(value && value.changes) ? value.changes : [];
						store.set({
							changes: next,
							ready: true,
							error: null,
							diag: value && typeof value.diag === "object" ? value.diag : null,
							// The poller is the live path — `refresh` only runs after a
							// decision — so the turn state has to be carried here too, or the
							// panel would never learn that a turn exists at all.
							turns: value && typeof value.turns === "object" && value.turns !== null ? value.turns : {},
							wavedThrough: value && typeof value.wavedThrough === "object" && value.wavedThrough !== null ? value.wavedThrough : {},
						});
						for (const item of next) {
							if (known.has(item.id)) continue;
							known.add(item.id);
							scheduleOpen(item.sessionId);
						}
						for (const id of Array.from(known)) {
							if (!next.some((item) => item.id === id)) known.delete(id);
						}
						const current = store.get();
						if (next.length > 0 && !next.some((item) => item.id === current.detailId)) {
							store.load(next[0].id);
						}
					} catch (error) {
						store.set({ ready: true, error: error instanceof Error ? error.message : String(error) });
					}
				};
				void tick();
				const handle = window.setInterval(tick, POLL_MS);
				return () => {
					disposed = true;
					window.clearInterval(handle);
					if (openTimer !== null) {
						window.clearTimeout(openTimer);
						openTimer = null;
					}
				};
			}, "dsh-diff-review: pending poller");

			/* --------------------------------------------------- tab types -- */

			const TabTitleBound = (props) => TabTitle(Object.assign({}, props, { t: t, store: store }));
			const TabBodyBound = (props) => {
				const merged = Object.assign({}, props, { t: t, store: store });
				return h(TabBoundary, { t: t }, h(DiffReviewTab, merged));
			};

			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_ID,
						title: () => t("title"),
						// Without a guide entry the type exists but nothing in the
						// sidebar offers it: the panel could only ever appear by
						// itself when a change arrived, and a user who dismissed it
						// had no way back. The entry pins it to the "start" page.
						guide: [
							{
								id: "review",
								order: 30,
								title: () => t("title"),
								description: () => t("emptyHint"),
							},
						],
					}),
				"dsh-diff-review: tab type",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () => {
						ensureCss();
						return ctx.slots.register(
							{ name: "sidebar.right.pane.tab", key: TAB_ID, locale: NS },
							TabBodyBound,
						);
					}),
				"dsh-diff-review: tab body",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab.title", () =>
						ctx.slots.register(
							{ name: "sidebar.right.pane.tab.title", key: TAB_ID, locale: NS },
							TabTitleBound,
						),
					),
				"dsh-diff-review: tab title",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
