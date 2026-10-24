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
			"acceptAll": "全部接受",
			"reject": "拒绝",
			"create": "新增",
			"update": "修改",
			"delete": "删除",
			"unified": "改动视图",
			"full": "全文视图",
			"pending": "待审查",
			"noChange": "无改动",
			"truncated": "文件过大，内容已截断",
			"notReviewable": "改动过大，仅显示统计",
			"decided": "已处理",
			"waiting": "等待模型继续…",
			"gapLine": "⋯ 未改动的 {n} 行",
			"before": "原文",
			"after": "新文",
			"shell": "命令",
			"emptyFile": "（空文件）",
			"deletedFile": "（文件将被删除）",
			"error": "请求失败：{msg}",
			"diag": "闸门已检查 {calls} 次 · 最近工具 {tool} · 结果 {reason}",
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
			"acceptAll": "Accept all",
			"reject": "Reject",
			"create": "New",
			"update": "Edit",
			"delete": "Delete",
			"unified": "Changes",
			"full": "Full file",
			"pending": "Pending",
			"noChange": "No changes",
			"truncated": "File too large, content truncated",
			"notReviewable": "Change too large, statistics only",
			"decided": "Handled",
			"waiting": "Waiting for the model…",
			"gapLine": "⋯ {n} unchanged lines",
			"before": "Before",
			"after": "After",
			"shell": "Command",
			"emptyFile": "(empty file)",
			"deletedFile": "(file will be removed)",
			"error": "Request failed: {msg}",
			"diag": "Gate checked {calls} times · last tool {tool} · outcome {reason}",
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
.dshr-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dshr-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.dshr-path{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshr-badge{flex:none;border-radius:4px;padding:1px 6px;font-size:10px;line-height:16px;font-weight:600;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.dshr-badge[data-op="create"]{background:var(--dsw-alias-file-diff-added-gutter);color:var(--dsw-alias-code-diff-added)}
.dshr-badge[data-op="delete"]{background:var(--dsw-alias-file-diff-deleted-gutter);color:var(--dsw-alias-code-diff-deleted)}
.dshr-stat{flex:none;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}
.dshr-add{color:var(--dsw-alias-code-diff-added)}
.dshr-del{color:var(--dsw-alias-code-diff-deleted)}
.dshr-btn{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;line-height:18px}
.dshr-btn:hover{background:var(--dsw-alias-bg-layer-3)}
.dshr-btn[data-primary="true"]{background:var(--dsw-alias-state-success-primary,#2f9e44);border-color:transparent;color:#fff;font-weight:600}
.dshr-btn[data-danger="true"]{background:transparent;border-color:var(--dsw-alias-state-error-primary,#e03131);color:var(--dsw-alias-state-error-primary,#e03131)}
.dshr-btn[data-ghost="true"]{background:transparent}
.dshr-layout{display:flex;flex:1 1 auto;min-height:0}
.dshr-list{flex:none;width:180px;min-width:120px;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:4px}
.dshr-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;cursor:pointer}
.dshr-item[data-active="true"]{background:var(--dsw-alias-bg-layer-3)}
.dshr-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dshr-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}
.dshr-item-meta{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshr-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dshr-code{flex:1 1 auto;overflow:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;padding-bottom:16px}
.dshr-row{display:flex;min-width:max-content}
.dshr-paint{flex:none;width:3px;user-select:none}
.dshr-row[data-t="add"] .dshr-paint{background:var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-code-diff-added))}
.dshr-row[data-t="del"] .dshr-paint{background:var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-code-diff-deleted))}
.dshr-gutter{flex:none;width:44px;text-align:right;padding-right:8px;color:var(--dsw-alias-label-tertiary);user-select:none;font-size:11px}
.dshr-marker{flex:none;width:14px;text-align:center;user-select:none;color:var(--dsw-alias-label-tertiary)}
.dshr-text{flex:1 1 auto;white-space:pre;padding-right:24px;tab-size:4}
.dshr-row[data-t="add"] .dshr-text,.dshr-row[data-t="add"] .dshr-gutter,.dshr-row[data-t="add"] .dshr-marker{background:var(--dsw-alias-file-diff-added-bg)}
.dshr-row[data-t="add"] .dshr-marker{color:var(--dsw-alias-file-diff-added-marker)}
.dshr-row[data-t="del"] .dshr-text,.dshr-row[data-t="del"] .dshr-gutter,.dshr-row[data-t="del"] .dshr-marker{background:var(--dsw-alias-file-diff-deleted-bg)}
.dshr-row[data-t="del"] .dshr-marker{color:var(--dsw-alias-file-diff-deleted-marker)}
.dshr-gap{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);font-size:11px;padding:2px 10px;font-style:italic}
.dshr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dshr-empty-title{font-size:13px;color:var(--dsw-alias-label-primary)}
.dshr-empty-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:320px}
.dshr-note{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-error{color:var(--dsw-alias-state-error-primary,#e03131)}
.dshr-split{display:flex;flex:1 1 auto;min-height:0}
.dshr-pane{display:flex;flex-direction:column;flex:1 1 50%;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}
.dshr-pane:last-child{border-right:none}
.dshr-pane-head{flex:none;padding:3px 10px;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-split .dshr-code{flex:1 1 auto;min-width:0;border-right:none}
.dshr-cmd{display:flex;gap:8px;align-items:flex-start;padding:6px 10px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);word-break:break-all}
.dshr-cmd-label{flex:none;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;font-size:10px;padding-top:1px}
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

		function DiffRow(row, index, t) {
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
				h("span", { className: "dshr-text" }, row.text === "" ? "\u00a0" : row.text),
			);
		}

		/**
		 * One full-text pane. Line numbers follow the file itself; the change marks
		 * come from the hunk rows so the pane shows exactly which lines the pending
		 * write adds or removes, the way an editor paints its gutter.
		 */
		function FullFilePane(text, side, marked, t) {
			const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			return h(
				"div",
				{ className: "dshr-pane", key: side },
				h("div", { className: "dshr-pane-head" }, t(side === "a" ? "before" : "after")),
				h(
					"div",
					{ className: "dshr-code dshr-full" },
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
								{ className: "dshr-empty-hint" },
								t("diag")
									.replace("{calls}", String(diag.calls ?? 0))
									.replace("{tool}", String(diag.tool ?? "-"))
									.replace("{reason}", String(diag.reason ?? "-")),
							),
							h(
								"div",
								{ className: "dshr-empty-hint" },
								t("diagArm")
									.replace("{armed}", diag.armed === true ? "yes" : "no")
									.replace("{age}", String(diag.heartbeatAgeMs ?? -1))
									.replace("{pending}", String(diag.pending ?? 0))
									.replace("{session}", String(diag.session ?? "-")),
							),
							h(
								"div",
								{ className: "dshr-empty-hint" },
								t("diagTools").replace("{tools}", Array.isArray(diag.tools) ? diag.tools.join(", ") : "-"),
							),
							h(
								"div",
								{ className: "dshr-empty-hint" },
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
								{ className: "dshr-empty-hint" },
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
						h("div", { className: "dshr-empty-title" }, t("empty")),
						h("div", { className: "dshr-empty-hint" }, t("emptyHint")),
						diagLines,
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
							h("span", { className: "dshr-path", title: active.path }, active.displayPath),
							h(
								"span",
								{ className: "dshr-stat" },
								h("span", { className: "dshr-add" }, "+" + active.added),
								" ",
								h("span", { className: "dshr-del" }, "-" + active.removed),
							),
							h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-ghost": "true",
									onClick: () => setView(view === "unified" ? "full" : "unified"),
								},
								t(view === "unified" ? "full" : "unified"),
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
			if (active !== null && active.truncated) notes.push(h("div", { className: "dshr-note", key: "trunc" }, t("truncated")));
			if (active !== null && active.reviewable === false) notes.push(h("div", { className: "dshr-note", key: "big" }, t("notReviewable")));
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
			} else if (view === "full") {
				// Paint the changed lines inside each full file, so both panes keep the real
				// line numbers of the file instead of a renumbered diff side.
				const markedA = new Set();
				const markedB = new Set();
				for (const row of detail.rows) {
					if (row.t === "del" && row.a !== null) markedA.add(row.a);
					if (row.t === "add" && row.b !== null) markedB.add(row.b);
				}
				body = h(
					"div",
					{ className: "dshr-split" },
					FullFilePane(detail.before === null ? "" : detail.before, "a", markedA, t),
					active.op === "delete" && (detail.after === null || detail.after === "")
						? h(
								"div",
								{ className: "dshr-pane", key: "b" },
								h("div", { className: "dshr-pane-head" }, t("after")),
								h("div", { className: "dshr-code dshr-full" }, h("div", { className: "dshr-gap" }, t("deletedFile"))),
							)
						: FullFilePane(detail.after === null ? "" : detail.after, "b", markedB, t),
				);
			} else {
				body = h(
					"div",
					{ className: "dshr-code" },
					detail.rows.map((row, index) => DiffRow(row, index, t)),
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
									{ className: "dshr-item-name", title: item.path },
									item.displayPath.split(/[\\/]/).pop(),
								),
								h(
									"span",
									{ className: "dshr-item-meta" },
									t(item.op) + "  +" + item.added + " -" + item.removed,
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
