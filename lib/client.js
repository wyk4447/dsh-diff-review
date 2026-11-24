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
		/**
		 * How often the panel asks the host what is waiting.
		 *
		 * Three rates, not one: a pending change is worth a fast answer, an empty
		 * panel is not, and a panel nobody is looking at is worth less than either.
		 * The old timer asked fifty times a minute whatever was going on, and a
		 * slow host made each of those calls wait for the one before it — so the
		 * answers came back out of order and the queue grew.
		 */
		const POLL_MS = 1200;
		const POLL_IDLE_MS = 5000;
		const POLL_HIDDEN_MS = 15000;
		// The ceiling the host puts on an edit request. Kept as a literal here so the
		// panel can refuse before sending: a body that is too large is rejected by
		// the route before any handler runs, and "request failed" is a poor way to
		// learn that a file was too big.
		const MAX_EDIT_BYTES = 8 * 1024 * 1024;

		// Bytes, not characters. The ceiling above is measured in bytes of JSON, and
		// a page of CJK is three times as many bytes as characters — counting the
		// wrong unit would let the panel believe it is under the limit and still be
		// refused. Falls back to UTF-8 by hand where TextEncoder is missing.
		function utf8Bytes(text) {
			const value = typeof text === "string" ? text : String(text === null || text === undefined ? "" : text);
			if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
			let size = 0;
			for (let index = 0; index < value.length; index += 1) {
				const code = value.charCodeAt(index);
				if (code < 0x80) size += 1;
				else if (code < 0x800) size += 2;
				else if (code >= 0xd800 && code <= 0xdbff) {
					size += 4;
					index += 1;
				} else size += 3;
			}
			return size;
		}

		const inject = ["slots", "locale", "sessions", "sidebarRight", "sidebarRightTabs"];

		/* ------------------------------------------------------------ locale -- */

		const zh = {
			"title": "改动审查",
			"empty": "暂无待审查的文件改动",
			"emptyHint": "当模型准备写入或修改文件时，会先在这里请你确认。",
			"accept": "接受",
			"reject": "拒绝",
			"allowTurn": "全部允许",
			"allowTurnHint": "接受这一项，并且之后所有写入都不再询问（删除和改名仍然会问；再点一次可以关掉）",
			"allowAllOff": "已全部允许 · 点此关闭",
			"allowAllOffHint": "现在所有写入都不再询问；点这里恢复逐项确认",
			"turnAllowed": "已全部允许：写入不再询问，删除和改名仍然会问",
			"sessionOff": "本会话不审核",
			"sessionOffHint": "这个对话里不再弹面板、也不记录改动；只影响当前对话，重启后仍然有效",
			"sessionOffOn": "已关闭 · 恢复审核",
			"sessionOffOnHint": "这个对话现在不问也不记；点这里恢复逐项确认",
			"sessionOffNote": "本会话已关闭审核：不再询问，也不记录改动",
			"create": "新增",
			"update": "修改",
			"delete": "删除",
			"unified": "改动视图",
			"full": "全文视图",
			"truncated": "文件过大，内容已截断",
			"notReviewable": "改动过大，仅显示统计",
			"commandOnly": "命令操作，无法预知最终内容",
			"inplaceOnly": "这些文件会被就地改写，新内容由工具决定",
			"waiting": "等待模型继续…",
			"gapLine": "⋯ 未改动的 {n} 行",
			"before": "原文",
			"after": "新文",
			"shell": "命令",
			"emptyFile": "（空文件）",
			"deletedFile": "（文件将被删除）",
			"deletedWhole": "整个文件将被删除，共 {n} 行；下面每行都是即将消失的内容",
			"dirEntry": "整个目录",
			"dirRemove": "整个目录将被删除，里面所有文件都会一起消失；这一步无法只恢复其中一个",
			"fullscreenOn": "全屏",
			"fullscreenOff": "退出全屏",
			"fullscreenHint": "把这一栏撑满编辑区来看 diff；再点一次收回",
			"error": "请求失败：{msg}",
			"diag": "闸门已检查 {calls} 次 · 最近工具 {tool} · 结果 {reason}",
			"diagHead": "闸门自检",
			"diagArm": "布防 {armed} · 心跳龄 {age}ms · 待审 {pending} · 会话 {session}",
			"diagTools": "闸门见过的工具：{tools}",
			"diagShape": "调用形态：{shape}",
			"diagRecent": "最近调用：{recent}",
			"diagTurn": "轮次：{turns}",
			"history": "本轮改动",
			"historyHint": "这次对话里改过的文件；点一行看整篇对比，点还原把文件恢复成改动前的样子",
			"historyEmpty": "本会话还没有审查记录",
			"historyBack": "返回待审",
			"historyThisTurn": "本轮",
			"historyTurn": "第 {n} 轮",
			"historyNoTurn": "更早的改动（升级前）",
			"historyGroupMeta": "{n} 个文件 · +{add} -{del}",
			"historyOpen": "看整篇对比",
			"historyToList": "返回列表",
			"historyMissing": "这条记录已经找不到了",
			"stateApplied": "已按你的版本落盘",
			"edit": "改一下",
			"editHint": "在面板里直接改，改完写盘；模型不会再用它的版本覆盖",
			"editApply": "应用",
			"editTitle": "你的版本",
			"editCancel": "放弃",
			"editBusy": "正在写入…",
			"editTooBig": "内容超过 {n} MB，无法在面板里提交",
			"editBytes": "{n} 字节",
			"editReasonEmpty": "内容不能为空",
			"editReasonNotEditable": "这类改动不能在面板里编辑",
			"editReasonDelete": "删除不能在面板里改成写入",
			"editReasonTruncated": "文件过大，内容已截断，编辑会丢掉后半段",
			"editReasonUnknown": "无法确定文件当前内容，编辑可能覆盖别人的改动",
			"editReasonStale": "文件已经变过了，请让模型重读后再改",
			"editReasonDenied": "没有写入权限",
			"editReasonMissingDir": "目标目录不存在",
			"editReasonFailed": "写入失败，请稍后再试",
			"editReasonUnchanged": "内容和原文一样，没什么可应用的",
			"editReasonMissing": "这份改动已经不在了，可能已经在别的标签页处理过了",
			"historyClearAll": "清空全部",
			"historyClearAllHint": "删掉这次对话存下的所有改动快照，删掉后就不能还原了",
			"historyClearTurn": "清空这一轮",
			"historyClearTurnHint": "只删这一轮的快照，其他轮次保留",
			"historyClearConfirm": "再点一次确认",
			"historyCleared": "已清掉 {n} 条",
			"historySize": "{n} 条 · {size}",
			"historySizeHint": "这次对话存下的改动快照，用来还原；条数和体积都有上限",
			"restore": "还原",
			"restoreHint": "把文件恢复成这次改动之前的内容；文件已再次变化时会拒绝",
			"restored": "已还原",
			"statePending": "待审",
			"stateAccepted": "已接受",
			"stateRejected": "已拒绝",
			"stateTimeout": "超时放行",
			"stateAllowed": "开关放行",
			"stateCancelled": "已取消",
			"restoreNotRestorable": "这条记录没有可用的原文快照",
			"restoreNotApplied": "这次改动并未落盘，无需还原",
			"restoreAlready": "已经还原过了",
			"restoreStale": "文件在此之后又变过，已拒绝还原",
			"restoreForbidden": "这个位置受保护，不允许还原",
			"restoreFailed": "还原失败，请稍后再试",
			"binaryFile": "二进制文件，{before} → {after} 字节",
			"sourceMapFile": "sourcemap，{before} → {after} 字节",
			"lineEndingsOnly": "仅换行符变化（{before} → {after} 字节）",
			"formattingOnly": "仅格式变化（缩进与空白），行内容未变",
			"fileCount": "{n} 个文件",
			"fileNoChange": "该文件内容未变",
			"fileOpaque": "内容由工具决定",
			"untouched": "未改动",
			"stepsHead": "这条命令会做这些事",
			"stepCd": "切换目录",
			"stepWrite": "写入",
			"stepDelete": "删除",
			"stepNote": "设置",
			"stepRun": "执行",
			"stepOpaque": "交给别的程序",
			"stepPath": "目标：{path}",
			"rawCommand": "原命令",
			"showRaw": "看原命令",
			"hideRaw": "收起原命令",
		};

		const en = {
			"title": "Diff review",
			"empty": "No changes waiting for review",
			"emptyHint": "When the model is about to write or edit a file, it asks here first.",
			"accept": "Accept",
			"reject": "Reject",
			"allowTurn": "Allow all writes",
			"allowTurnHint": "Accept this one and stop asking about any later write; deletes and renames still ask, and pressing again turns it off",
			"allowAllOff": "All writes allowed · turn off",
			"allowAllOffHint": "Writes are no longer reviewed; press to review each one again",
			"turnAllowed": "All writes allowed: no more prompts for writes, deletes and renames still ask",
			"sessionOff": "Do not review this chat",
			"sessionOffHint": "Stop asking and stop recording changes in this one conversation; other conversations are unaffected and the switch survives a restart",
			"sessionOffOn": "Review off · turn back on",
			"sessionOffOnHint": "Nothing is asked or recorded here; press to review each change again",
			"sessionOffNote": "Review is off for this chat: nothing is asked and nothing is recorded",
			"create": "New",
			"update": "Edit",
			"delete": "Delete",
			"unified": "Changes",
			"full": "Full file",
			"truncated": "File too large, content truncated",
			"notReviewable": "Change too large, statistics only",
			"commandOnly": "Command writes; the result is not knowable up front",
			"inplaceOnly": "These files are rewritten in place; the tool decides their new content",
			"waiting": "Waiting for the model…",
			"gapLine": "⋯ {n} unchanged lines",
			"before": "Before",
			"after": "After",
			"shell": "Command",
			"emptyFile": "(empty file)",
			"deletedFile": "(file will be removed)",
			"deletedWhole": "The whole file will be removed: {n} lines, every one of them gone",
			"dirEntry": "Whole folder",
			"dirRemove": "The whole folder will be removed, every file inside it goes with it; no single file can be restored from this",
			"fullscreenOn": "Fullscreen",
			"fullscreenOff": "Exit fullscreen",
			"fullscreenHint": "Fill the editor area with this column to read the diff; press again to restore",
			"error": "Request failed: {msg}",
			"diag": "Gate checked {calls} times · last tool {tool} · outcome {reason}",
			"diagHead": "Gate self-check",
			"diagArm": "Armed {armed} · heartbeat age {age}ms · pending {pending} · session {session}",
			"diagTools": "Tools seen by the gate: {tools}",
			"diagShape": "Call shape: {shape}",
			"diagRecent": "Recent calls: {recent}",
			"diagTurn": "Turns: {turns}",
			"history": "Changes this turn",
			"historyHint": "Files changed in this conversation; open one for the whole-file comparison, or restore it",
			"historyEmpty": "Nothing reviewed in this conversation yet",
			"historyBack": "Back to pending",
			"historyThisTurn": "This turn",
			"historyTurn": "Turn {n}",
			"historyNoTurn": "Earlier changes (before this upgrade)",
			"historyGroupMeta": "{n} files · +{add} -{del}",
			"historyOpen": "Whole-file comparison",
			"historyToList": "Back to the list",
			"historyMissing": "That record can no longer be found",
			"stateApplied": "Written with your version",
			"edit": "Edit",
			"editHint": "Edit right here and write it to disk; the model will not overwrite it with its own version",
			"editApply": "Apply",
			"editTitle": "Your version",
			"editCancel": "Discard",
			"editBusy": "Writing…",
			"editTooBig": "Content exceeds {n} MB and cannot be submitted from the panel",
			"editBytes": "{n} bytes",
			"editReasonEmpty": "Content cannot be empty",
			"editReasonNotEditable": "This kind of change cannot be edited in the panel",
			"editReasonDelete": "A removal cannot be edited into a write",
			"editReasonTruncated": "File too large, content was truncated; editing would drop the rest",
			"editReasonUnknown": "The current content cannot be confirmed; editing could overwrite someone else's change",
			"editReasonStale": "The file has changed; ask the model to read it again",
			"editReasonDenied": "No permission to write",
			"editReasonMissingDir": "The target directory does not exist",
			"editReasonFailed": "Write failed, try again",
			"editReasonUnchanged": "Identical to the original, nothing to apply",
			"editReasonMissing": "This change is gone; it was probably handled in another tab",
			"historyClearAll": "Clear all",
			"historyClearAllHint": "Delete every snapshot this conversation stored; restoring stops being possible",
			"historyClearTurn": "Clear this turn",
			"historyClearTurnHint": "Delete only this turn's snapshots; the other turns are kept",
			"historyClearConfirm": "Click again to confirm",
			"historyCleared": "Cleared {n}",
			"historySize": "{n} · {size}",
			"historySizeHint": "Snapshots this conversation shares for restoring; both the count and the size are capped",
			"restore": "Restore",
			"restoreHint": "Put the file back to what it held before this change; refused if it has changed since",
			"restored": "Restored",
			"statePending": "Pending",
			"stateAccepted": "Accepted",
			"stateRejected": "Rejected",
			"stateTimeout": "Timed out",
			"stateAllowed": "Allowed without review",
			"stateCancelled": "Cancelled",
			"restoreNotRestorable": "No usable snapshot for this entry",
			"restoreNotApplied": "This change never reached the disk, nothing to undo",
			"restoreAlready": "Already restored",
			"restoreStale": "The file changed since then; restore refused",
			"restoreForbidden": "This location is protected and cannot be restored",
			"restoreFailed": "Restore failed, try again",
			"binaryFile": "Binary file, {before} → {after} bytes",
			"sourceMapFile": "Source map, {before} → {after} bytes",
			"lineEndingsOnly": "Line endings only ({before} → {after} bytes)",
			"formattingOnly": "Formatting only (indent and whitespace), no line content changed",
			"fileCount": "{n} files",
			"fileNoChange": "This file was left unchanged",
			"fileOpaque": "The tool decides its content",
			"untouched": "Untouched",
			"stepsHead": "This command does the following",
			"stepCd": "Switch directory",
			"stepWrite": "Write",
			"stepDelete": "Delete",
			"stepNote": "Set",
			"stepRun": "Run",
			"stepOpaque": "Handed to another program",
			"stepPath": "Target: {path}",
			"rawCommand": "Raw command",
			"showRaw": "Show raw command",
			"hideRaw": "Hide raw command",
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

		/**
		 * How many lines a whole-file removal takes with it. Computed from the text
		 * rather than taken from the caller so both screens — the pending review and
		 * the history entry — say the same number for the same removal.
		 */
		function removedLineCount(before) {
			const text = String(before === null || before === undefined ? "" : before)
				.replace(/\r\n/g, "\n")
				.replace(/\n$/, "");
			return text === "" ? 0 : text.split("\n").length;
		}

		/**
		 * The diff itself, with no idea where it came from. Shared by the pending
		 * review and the history screen: the same change must look the same whether
		 * it is waiting for a decision or being read back a turn later, and two
		 * copies of this code would drift apart the first time one side was fixed.
		 */
		function renderDiffBody(options) {
			const rows = options.rows;
			const view = options.view;
			const t = options.t;
			if (!Array.isArray(rows) || rows.length === 0) return null;
			const after = options.after === null || options.after === undefined ? "" : options.after;
			const before = options.before === null || options.before === undefined ? "" : options.before;
			if (view === "full") {
				// Paint the changed lines inside each full file, so both panes keep the
				// real line numbers of the file instead of a renumbered diff side.
				const markedA = new Set();
				const markedB = new Set();
				for (const row of rows) {
					if (row.t === "del" && row.a !== null) markedA.add(row.a);
					if (row.t === "add" && row.b !== null) markedB.add(row.b);
				}
				return h(SplitView, {
					before,
					after,
					markedA,
					markedB,
					deleted: options.op === "delete" && after === "",
					deletedLines: removedLineCount(before),
					t,
				});
			}
			const spans = inlineRanges(rows);
			return h(
				"div",
				{ className: "dshr-code" },
				rows.map((row, index) => DiffRow(row, index, t, spans.get(index))),
			);
		}

		/**
		 * The editor. A whole-file textarea rather than a row-by-row editor: what
		 * gets written is exactly what is in the box, and pretending otherwise with
		 * per-line widgets would make the two disagree the moment a line is added.
		 *
		 * The left pane is the file as it stands so the reader can keep their place
		 * while typing, and it does not scroll with the box — a textarea scrolls
		 * itself, and mirroring a scroll into a read-only pane renders the file at a
		 * position nobody asked for.
		 */
		function EditPane(props) {
			const t = props.t;
			const before = props.before === null || props.before === undefined ? "" : props.before;
			return h(
				"div",
				{ className: "dshr-split dshr-edit" },
				FullFilePane({
					text: before,
					side: "a",
					marked: new Set(),
					t,
					scrollerRef: React.useRef(null),
					onScroll: null,
				}),
				h(
					"div",
					{ className: "dshr-pane", key: "b" },
					h("div", { className: "dshr-pane-head" }, t("editTitle")),
					h("textarea", {
						className: "dshr-editor",
						value: props.text,
						spellCheck: false,
						wrap: "off",
						onChange: (event) => props.onChange(event && event.target ? event.target.value : ""),
					}),
					h(
						"div",
						{ className: "dshr-edit-foot" },
						h(
							"span",
							{ className: "dshr-edit-bytes" },
							t("editBytes").replace("{n}", fmt(props.bytes)),
							props.tooBig ? " · " + t("editTooBig").replace("{n}", String(props.maxMb)) : "",
						),
						h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-ghost": "true",
								disabled: props.busy,
								onClick: () => props.onCancel(),
							},
							t("editCancel"),
						),
						h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-primary": "true",
								// Disabled rather than hidden: a reader who pasted a large
								// file needs to see why the button stopped working, and a
								// vanishing button explains nothing.
								disabled: props.busy || props.tooBig,
								onClick: () => props.onApply(),
							},
							props.busy ? t("editBusy") : t("editApply"),
						),
					),
				),
			);
		}

		/* ------------------------------------------------------------- store -- */

		function createStore() {
			let state = {
				changes: [],
				// The details that have been fetched, filed under the id they were
				// asked for. One entry per change rather than one slot for the
				// panel: the panel picks the one it shows, and a slow answer for
				// one change can never turn up next to another change's heading.
				details: {},
				error: null,
				ready: false,
				diag: null,
				// Which conversations have writes waved through, keyed by session.
				// A single boolean was wrong: the switch belongs to one conversation,
				// and reading it globally made every other tab show the state of
				// whichever one was toggled last.
				allowAll: {},
				// What the history screen is holding, per conversation, so the bar
				// can show the count and the bytes without opening it. Polled
				// because it changes when a change is reviewed, which is exactly
				// when nobody is looking here.
				history: {},
				// Which turn each conversation is on now, so "changes this turn"
				// can open on the turn the reader is actually looking at.
				turns: {},
				// The conversations with a panel open. The host is asked about
				// these and no others: the sizes of every conversation on the
				// machine are none of this panel's business.
				sessionIds: [],
				// Which conversations the reader silenced, keyed by session, for the
				// same reason `allowAll` is a table: one chat must never render
				// another's switch.
				off: {},
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
/* The switch in its on state reads as a status, not an action: it has to be
   obvious that writes are no longer reviewed, and equally obvious that the same
   button turns them back on. Muted amber rather than green, so it never looks
   like the "accept this change" button next to it. */
.dshr-btn[data-on="true"]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.dshr-btn[data-on="true"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshr-layout{display:flex;flex:1 1 auto;min-height:0}
.dshr-list{flex:none;width:200px;min-width:130px;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:6px}
.dshr-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;cursor:pointer;border-left:2px solid transparent}
.dshr-item[data-active="true"]{background:var(--dsw-alias-bg-layer-3);border-left-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-code-diff-added))}
.dshr-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dshr-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dshr-mono);font-size:12px;line-height:17px}
.dshr-item-meta{font-family:var(--dshr-mono);font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dshr-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
/* One command, several files: a strip above the code that switches which diff
   is on screen. Horizontal, because the file names are what a reader scans and
   a vertical list here would push the diff itself out of the pane. */
.dshr-files{display:flex;flex-wrap:wrap;gap:4px;padding:6px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshr-files-head{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);align-self:center;padding:0 6px 0 2px}
.dshr-files .dshr-item{flex-direction:row;align-items:center;gap:6px;padding:3px 8px;border-left-width:2px}
.dshr-files .dshr-item-meta{white-space:nowrap}
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
/* The step list, shown instead of one long command block. Each row is one
   statement of the command with what it does, so the reader can answer "is
   anything being written, and where?" without reading code. */
.dshr-steps{display:flex;flex-direction:column;gap:0;padding:7px 12px 4px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-steps-head{font-size:10px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding-bottom:4px}
.dshr-step{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:3px 0;font-size:12px;line-height:18px}
.dshr-step-kind{flex:none;font-size:10px;line-height:15px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshr-step[data-kind="write"] .dshr-step-kind{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dshr-step[data-kind="delete"] .dshr-step-kind{color:var(--dsw-alias-label-error, #c0392b);border-color:var(--dsw-alias-label-error, #c0392b)}
.dshr-step-text{flex:1 1 200px;min-width:0;font-family:var(--dshr-mono);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-all;white-space:pre-wrap}
.dshr-step-path{flex:1 0 100%;font-family:var(--dshr-mono);font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);padding-left:2px;word-break:break-all}
.dshr-step-code{flex:1 0 100%;margin:2px 0 0;padding:6px 8px;font-family:var(--dshr-mono);font-size:11px;line-height:17px;background:var(--dsw-alias-bg-layer-3);border-radius:4px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dshr-raw{padding:0 12px 7px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-raw-toggle{font:inherit;font-size:11px;line-height:17px;color:var(--dsw-alias-brand-primary);background:none;border:none;padding:2px 0;cursor:pointer}
.dshr-raw .dshr-cmd{padding:6px 0 0;background:none;border-bottom:none}
/* The history list is the same shape as the pending list, so it reuses the item
   classes; only the row body differs, because a finished entry carries a state
   and an undo instead of a diff. */
.dshr-hist{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 10px}
.dshr-hist-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshr-hist-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dshr-hist-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshr-hist-meta{font-family:var(--dshr-mono);font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dshr-hist-state{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* Turns are the unit a reader thinks in — "what did it just do?" — so the list
   is grouped and the group header is the click target for folding. */
.dshr-hist-group{margin-bottom:6px}
.dshr-hist-group-head{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dshr-hist-group-head:hover{background:var(--dsw-alias-bg-layer-3)}
.dshr-hist-twisty{flex:none;width:10px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* Totals and the clear-all button, above the groups: both describe the whole
   store, so they must not sit inside a group where they would read as one
   turn's business. */
.dshr-hist-tools{display:flex;align-items:center;gap:8px;padding:2px 8px 6px}
.dshr-hist-total{flex:none;font-family:var(--dshr-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshr-hist-note{flex:1 1 auto;min-width:0;text-align:right;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshr-hist-tools .dshr-btn{margin-left:auto}
.dshr-hist-group-head .dshr-btn{flex:none}
/* The bar's running total: a read-out that doubles as the way into the list. */
.dshr-hist-size{flex:none;font-family:var(--dshr-mono);font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.dshr-hist-size:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dshr-hist-turn{flex:none;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-primary)}
.dshr-hist-group-meta{flex:1 1 auto;min-width:0;text-align:right;font-family:var(--dshr-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The opened entry fills the pane: the list is gone, the comparison is the
   content, and the header carries the way back. */
.dshr-hist-open{display:flex;flex-direction:column;padding:0}
.dshr-hist-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);min-width:0}
.dshr-hist-open .dshr-split,.dshr-hist-open .dshr-code{flex:1 1 auto;min-height:0}
/* The editor takes the right-hand half, the way the after-pane does: the reader
   is replacing that side, so it belongs where they are already looking. */
.dshr-editor{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:none;border:none;outline:none;padding:8px 12px;font-family:var(--dshr-mono);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1, transparent);white-space:pre;overflow:auto;tab-size:4}
.dshr-edit-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshr-edit-bytes{flex:1 1 auto;min-width:0;font-family:var(--dshr-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
							h(
								"div",
								{ className: "dshr-code dshr-full" },
								h(
									"div",
									{ className: "dshr-gap" },
									props.t("deletedWhole").replace("{n}", String(props.deletedLines ?? 0)),
								),
							),
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
			const sessionId = props.sessionId;
			// The chip sits in one Session's header, so its number has to be that
			// Session's number. Counting the whole poll made Session B's chip
			// announce Session A's pending change — a leak the panel body already
			// avoided by filtering, but the title bypassed it.
			const changes = sessionId === undefined
				? snapshot.changes
				: snapshot.changes.filter((item) => item.sessionId === sessionId);
			const text = t("title");
			return h("span", null, changes.length > 0 ? text + " (" + changes.length + ")" : text);
		}

		function DiffReviewTab(props) {
			const store = props.store;
			const t = props.t;
			const sessionId = props.sessionId;
			// The host hands the body a reader for its own tab, which is where the
			// column's presentation state lives. It is read through a variable so the
			// hook is always called in the same order, even in a harness that does not
			// provide one.
			const readTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : () => null;
			const tabInfo = readTabInfo();
			const fullscreen = tabInfo !== null && tabInfo !== undefined && tabInfo.sidebar !== undefined
				? tabInfo.sidebar.fullscreen === true
				: false;
			const snapshot = useStore(store);
			// Tell the host which conversation this panel is about, so it answers
			// with that conversation's figures and turns instead of the whole
			// machine's. The registration is undone when the panel goes away.
			React.useEffect(
				() => store.registerSession(sessionId),
				[sessionId, store],
			);
			const [view, setView] = React.useState("unified");
			const [selectedId, setSelectedId] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			// The history is a second screen, not a second tab: it is the same panel
			// with the same conversation, and a reader wants to step back from a
			// pending decision to what they accepted a moment ago and return.
			const [showHistory, setShowHistory] = React.useState(false);
			const [histories, setHistories] = React.useState([]);
			const [histError, setHistError] = React.useState(null);
			// What the last clear removed. Shown once, then replaced by the next
			// action: a number that never goes away reads as a running total.
			const [histNote, setHistNote] = React.useState(null);
			// The store's own measurement, as the history answer carried it. Kept
			// separate from the bar's copy so a clear can report the new total
			// immediately, without waiting for the next poll to catch up.
			const [histSizes, setHistSizes] = React.useState(null);
			// One entry being undone, so two clicks cannot race two restores of the
			// same file.
			const [restoring, setRestoring] = React.useState(null);
			// A command touching several files is one decision carrying several
			// diffs. Which one a reader is looking at is panel state, not host
			// state: the host already sent every diff in the same answer.
			const [fileIndex, setFileIndex] = React.useState(0);
			// The step list is the review for a command with no diff; the raw command
			// stays folded underneath, because a summary is a reading aid and not a
			// replacement for the text being approved.
			const [showRaw, setShowRaw] = React.useState(false);
			// Editing is its own mode, not a flag on the diff: the right-hand side
			// stops being a rendering of the model's text and becomes the text the
			// reader is going to write. Keeping the whole file in one string is the
			// honest model of "apply my version" — a per-line editor would need the
			// same string anyway and would lie about what gets written.
			const [editing, setEditing] = React.useState(false);
			const [editText, setEditText] = React.useState("");
			const [editBusy, setEditBusy] = React.useState(false);
			const [editError, setEditError] = React.useState(null);
			// The history used to be a flat list of one-line rows: enough to know
			// something changed, not enough to see what. Opening a row fetches the
			// stored pair and draws the same comparison the pending review draws.
			const [openHistory, setOpenHistory] = React.useState(null);
			const [historyView, setHistoryView] = React.useState("full");
			const [historyBusy, setHistoryBusy] = React.useState(null);
			// Which turn groups the reader has folded shut. The current turn starts
			// open and the earlier ones start closed: a conversation with thirty
			// turns would otherwise open on a wall of rows with the turn they are in
			// buried wherever it happens to sort.
			const [foldedTurns, setFoldedTurns] = React.useState({});
			// Clearing deletes snapshots that cannot be recovered, so the button is
			// two-step: the first click arms it, the second one acts. `clearArmed`
			// holds the group it applies to ("all" for the whole store) and resets
			// whenever the screen is left, so a stray second click cannot land on a
			// different group than the one that was read.
			const [clearArmed, setClearArmed] = React.useState(null);
			const [clearBusy, setClearBusy] = React.useState(null);

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
				// A detail that has already been fetched for this change is left
				// alone: the guard is the id the detail was filed under, not a
				// separate flag that could disagree with it.
				if (snapshot.details[active.id] !== undefined) return;
				void store.loadDetail(active.id, sessionId);
			}, [active === null ? null : active.id, snapshot.details, store, sessionId]);

			// The diff belongs to the change it was fetched for. Reading it out of
			// the map by the active id is what keeps one change's text from being
			// shown under another's name.
			const detail = active !== null && snapshot.details[active.id] !== undefined
				? snapshot.details[active.id]
				: null;

			// A command that touched several files answers with one diff per file
			// instead of one pretend before/after for the whole call. The panel shows
			// one file at a time; the list above the code switches between them.
			const group = detail !== null && Array.isArray(detail.files) && detail.files.length > 1 ? detail.files : null;
			const shown = group === null ? null : group[Math.min(fileIndex, group.length - 1)];
			// Switching to another review must not leave the previous review's file
			// selection behind, or the first look at a two-file command lands on its
			// second file for no reason the reader can see.
			const activeKey = active === null ? null : active.id;
			React.useEffect(() => {
				setFileIndex(0);
				setShowRaw(false);
				// A half-typed replacement belongs to the change it was started on.
				// Carrying it across would offer to write one file's text over another.
				setEditing(false);
				setEditText("");
				setEditError(null);
			}, [activeKey]);

			const currentRows = shown === null ? (detail === null ? null : detail.rows) : shown.rows;
			const currentBefore = shown === null ? (detail === null ? null : detail.before) : shown.before;
			const currentAfter = shown === null ? (detail === null ? null : detail.after) : shown.after;
			const currentKind = shown === null ? (active === null ? "text" : active.kind) : shown.kind;
			const currentNote = shown === null ? (active === null ? undefined : active.note) : shown.note;
			// A whole-file removal is one flat block of `-` lines, and "the file is
			// going away" said nothing about how much went with it: the count is the
			// fact the reader was missing, so it is carried to both views.
			const currentOp = shown === null ? (active === null ? null : active.op) : shown.op;
			const removedWhole = currentOp === "delete" && (currentAfter === null || currentAfter === "");
			const beforeLines = String(currentBefore === null ? "" : currentBefore)
				.replace(/\r\n/g, "\n")
				.replace(/\n$/, "");
			const shownLines = removedWhole && beforeLines !== "" ? beforeLines.split("\n").length : 0;
			// A command-level review has no rows to draw, so the view toggle would be a
			// button that changes nothing: hide it there rather than lie about it.
			const hasRows = Array.isArray(currentRows) && currentRows.length > 0;

			// A folder is not a file, so it has neither a byte count nor a line diff:
			// the only true statement is that everything inside it goes away, and that
			// it cannot be taken back one file at a time. Computed here because both
			// the note below and the edit guard need it.
			const shownDirectory = (shown === null ? undefined : shown.directory) === true
				|| (active !== null && active.directory === true);

			// Whether handing the panel a whole file makes sense at all. Each of
			// these mirrors a refusal in `api.applyEdited`; a condition missing here
			// is a button that exists only to fail. `truncated` is checked instead of
			// the host's `known`, which is never sent to the panel: a condition on a
			// field that never arrives would read true forever and hide the button
			// from every change.
			const editable = active !== null
				&& active !== undefined
				&& (active.tool === "write" || active.tool === "edit")
				&& active.op !== "delete"
				&& active.truncated !== true
				&& currentKind === "text"
				&& active.directory !== true
				&& shownDirectory !== true;

			// Measured on the text as it stands, not on the change: the reader may
			// have pasted something much larger than what the model proposed, and the
			// request ceiling applies to what is actually going to be sent.
			const editBytes = utf8Bytes(editText);
			const editTooBig = editBytes > MAX_EDIT_BYTES;

			// The reasons an edit can be refused, spelled out in the same words the
			// host uses for its codes. A code with no sentence falls back to the
			// generic failure text rather than showing the reader a token like
			// "stale" and leaving them to guess.
			const editReasonText = (code) => {
				switch (code) {
					case "empty":
						return t("editReasonEmpty");
					case "not-editable":
						return t("editReasonNotEditable");
					case "delete-not-editable":
						return t("editReasonDelete");
					case "truncated":
						return t("editReasonTruncated");
					case "unknown-content":
						return t("editReasonUnknown");
					case "stale":
						return t("editReasonStale");
					case "denied":
						return t("editReasonDenied");
					case "missing-dir":
						return t("editReasonMissingDir");
					case "unchanged":
						return t("editReasonUnchanged");
					case "missing":
						return t("editReasonMissing");
					default:
						return t("editReasonFailed");
				}
			};

			// Sending the panel's text instead of the model's. On success the change
			// stops being pending, so the whole review disappears on the next poll —
			// there is nothing left to edit, and leaving the editor open would offer a
			// second write of text that is already on disk.
			const applyEdited = async () => {
				if (active === null || active === undefined || editBusy || editTooBig) return;
				setEditBusy(true);
				setEditError(null);
				try {
					const value = await apiCall("applyEdited", {
						id: active.id,
						sessionId: active.sessionId,
						content: editText,
					});
					if (value !== null && typeof value === "object") {
						if (typeof value.error === "string") {
							setEditError(editReasonText(value.error));
							return;
						}
						// An answer that is not a refusal and not a success is
						// neither. The editor used to close on it and the panel
						// said the write went through while the file was never
						// touched — the reader's text was simply dropped.
						if (value.ok !== true) {
							setEditError(editReasonText(typeof value.missing === "boolean" ? "missing" : "failed"));
							return;
						}
					}
					setEditing(false);
					setEditText("");
					store.refresh();
				} catch (error) {
					setEditError(error instanceof Error ? error.message : String(error));
				} finally {
					setEditBusy(false);
				}
			};

			// The switch belongs to this conversation. Reading it out of a table is
			// the whole point: a conversation nobody touched must keep showing its
			// own state instead of mirroring whichever tab was toggled last.
			//
			// `reviewSession` falls back to the change's own owner, because a tab
			// opened from a poll notification can arrive before the host hands it a
			// session, and a switch with no session to speak for is not a switch.
			const reviewSession =
				typeof sessionId === "string" && sessionId !== ""
					? sessionId
					: active !== null && typeof active.sessionId === "string"
						? active.sessionId
						: "";
			const allowAllOn = reviewSession !== "" && snapshot.allowAll !== null && snapshot.allowAll !== undefined && snapshot.allowAll[reviewSession] === true;
			// Silenced for this conversation: no prompt, no record. Read from the
			// host rather than kept locally, because the switch outlives the tab.
			// Silenced for this conversation: no prompt, no record. Read from the
			// host rather than kept locally, because the switch outlives the tab.
			const reviewOff = reviewSession !== "" && snapshot.off !== null && snapshot.off !== undefined && snapshot.off[reviewSession] === true;

			const decide = async (item, action) => {
				if (item === undefined || item === null) return;
				setBusy(item.id);
				try {
					// Name the owner the record came from, so the host can refuse a
					// decision aimed at another Session's change. The panel already
					// filters what it shows; this is the second half of the same rule,
					// on the side that actually holds the pending call.
					await apiCall("decide", { id: item.id, action: action, sessionId: item.sessionId });
				} catch (error) {
					store.set({ error: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(null);
					store.refresh();
				}
			};

			// The switch needs no pending change to act on: turning it off must work
			// from the empty panel too, which is where a reader ends up right after
			// allowing everything. It names its own conversation, because the switch
			// turns on writes for one session and no other.
			const setAllowAll = async (value) => {
				if (reviewSession === "") return;
				setBusy("switch");
				try {
					await apiCall("decide", { action: "setAllowAll", value: value, sessionId: reviewSession });
				} catch (error) {
					store.set({ error: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(null);
					store.refresh();
				}
			};

			/**
			 * Silence this conversation, or start reviewing it again.
			 *
			 * Its own route action rather than a flag on `setAllowAll`: the two
			 * mean different things. Allowing everything still reviews and still
			 * records, it just answers for you; this one stops both.
			 */
			const setSessionOff = async (value) => {
				if (reviewSession === "") return;
				setBusy("session-off");
				try {
					const value2 = await apiCall("decide", { action: "setSessionOff", value: value, sessionId: reviewSession });
					// Merge rather than replace: the table describes every silenced
					// conversation, and this call only learned about one of them.
					const next = Object.assign({}, snapshot.off);
					if (value2 !== null && value2 !== undefined && value2.off === true) next[reviewSession] = true;
					else delete next[reviewSession];
					store.set({ off: next });
				} catch (error) {
					store.set({ error: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(null);
					store.refresh();
				}
			};

			/**
			 * Fetch the history screen's data.
			 *
			 * Pulled on demand rather than polled: the pending list changes while a
			 * reader waits, but a finished change never appears on its own, so a
			 * second request every 1.2s would buy nothing.
			 */
			const loadHistory = async () => {
				if (reviewSession === "") return;
				try {
					const value = await apiCall("history", { sessionId: reviewSession });
					const entries = value && Array.isArray(value.entries) ? value.entries : [];
					setHistories(entries);
					setHistSizes(value && typeof value.stats === "object" && value.stats !== null ? value.stats : null);
					setHistError(null);
				} catch (error) {
					setHistError(error instanceof Error ? error.message : String(error));
				}
			};

			React.useEffect(() => {
				if (showHistory) void loadHistory();
			}, [showHistory, reviewSession]);

			// Leaving the history screen disarms the delete button: a confirmation
			// that survives navigation is one the reader has forgotten giving. The
			// "cleared N" note is dropped with it, because it describes one action on
			// a screen the reader has since walked away from.
			React.useEffect(() => {
				if (!showHistory) {
					setClearArmed(null);
					setHistNote(null);
				}
			}, [showHistory]);

			/**
			 * Delete stored snapshots — everything, or one turn.
			 *
			 * `undefined` means every turn, `null` the entries that predate turn
			 * numbers, a number one turn. The host answers with the remaining list so
			 * the screen and the bar both update from the same reply.
			 */
			const clearHistory = async (turn) => {
				if (reviewSession === "") return;
				const key = turn === undefined ? "all" : turn === null ? "none" : String(turn);
				if (clearArmed !== key) {
					setClearArmed(key);
					return;
				}
				setClearArmed(null);
				setClearBusy(key);
				try {
					const value = await apiCall("historyClear", { sessionId: reviewSession, turn: turn });
					const entries = value && Array.isArray(value.entries) ? value.entries : [];
					setHistories(entries);
					setHistSizes(value && typeof value.stats === "object" && value.stats !== null ? value.stats : null);
					setHistError(null);
					const removed = value && typeof value.removed === "number" ? value.removed : 0;
					// Nothing left to compare: an open detail would show a pair whose
					// entry no longer exists.
					if (removed > 0) {
						setOpenHistory(null);
						setHistNote(t("historyCleared").replace("{n}", String(removed)));
					}
					store.refresh();
				} catch (error) {
					setHistError(error instanceof Error ? error.message : String(error));
				} finally {
					setClearBusy(null);
				}
			};

			/** Word a host refusal as the sentence the reader needs, not a code. */
			const restoreReason = (code) => {
				if (code === "not-restorable") return t("restoreNotRestorable");
				if (code === "not-applied") return t("restoreNotApplied");
				if (code === "already-restored") return t("restoreAlready");
				if (code === "stale") return t("restoreStale");
				if (code === "target-forbidden") return t("restoreForbidden");
				return t("restoreFailed");
			};

			const restore = async (entry) => {
				if (entry === undefined || entry === null) return;
				if (reviewSession === "") return;
				setRestoring(entry.id);
				try {
					const value = await apiCall("restore", { id: entry.id, sessionId: reviewSession });
					if (value && typeof value.error === "string") {
						setHistError(restoreReason(value.error));
					} else {
						setHistError(null);
					}
				} catch (error) {
					setHistError(error instanceof Error ? error.message : String(error));
				} finally {
					setRestoring(null);
					await loadHistory();
				}
			};

			// An undo that cannot be verified is not offered at all: a button that
			// always refuses is worse than its absence. `applied` counts because the
			// reader's own version is what reached the disk — it is not a pending
			// change any more, and restoring still means something.
			const canRestore = (entry) => entry !== null
				&& entry !== undefined
				&& entry.restorable === true
				&& entry.verify !== null
				&& entry.verify !== undefined
				&& (entry.state === "accepted"
					|| entry.state === "timeout"
					|| entry.state === "allowed"
					|| entry.state === "applied")
				&& (entry.restoredAt === null || entry.restoredAt === undefined);

			// One entry opened for reading. Fetched rather than carried in the list:
			// the stored pair is the whole file, and a conversation with forty
			// changes would otherwise ship every byte of all of them to draw a list.
			const openEntry = async (entry) => {
				if (entry === null || entry === undefined) return;
				if (reviewSession === "") return;
				setHistoryBusy(entry.id);
				try {
					const value = await apiCall("historyDetail", { id: entry.id, sessionId: reviewSession });
					if (value === null || typeof value !== "object" || value.missing === true) {
						setHistError(t("historyMissing"));
						return;
					}
					setHistError(null);
					setHistoryView("full");
					setOpenHistory({
						entry: value.entry === null || value.entry === undefined ? entry : value.entry,
						before: value.before,
						after: value.after,
						rows: value.rows,
					});
				} catch (error) {
					setHistError(error instanceof Error ? error.message : String(error));
				} finally {
					setHistoryBusy(null);
				}
			};

			/** Human units for a byte count; raw bytes are unreadable at a glance. */
			const sizeText = (bytes) => {
				const n = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
				if (n < 1024) return n + " B";
				if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
				return (n / (1024 * 1024)).toFixed(1) + " MB";
			};
			// What the store is holding. The bar's figures come off the poll, because
			// that is the only thing running when the screen is shut; the history
			// answer carries its own, which is fresher right after a clear and is
			// what the screen itself shows when it has one.
			//
			// The figures are the reviewed conversation's, not the sum of every
			// conversation on the machine: the bar sits above one conversation's
			// history and has to answer for that one.
			const histStats =
				reviewSession !== "" && snapshot.history !== null && typeof snapshot.history === "object"
					? snapshot.history[reviewSession] || { entries: 0, bytes: 0 }
					: { entries: 0, bytes: 0 };
			const screenStats = histSizes !== null && typeof histSizes === "object" ? histSizes : histStats;

			// A finished change is grouped by the turn that made it. A flat list is
			// unreadable once there are thirty of them, and the question a reader
			// actually has — "what did it just do?" — is answered by the last group.
			const turnKeyOf = (entry) => (typeof entry.turn === "number" ? String(entry.turn) : "");
			const turnGroups = [];
			const groupIndex = {};
			for (const entry of histories) {
				const key = turnKeyOf(entry);
				if (!Object.hasOwn(groupIndex, key)) {
					groupIndex[key] = turnGroups.length;
					turnGroups.push({ key, turn: typeof entry.turn === "number" ? entry.turn : null, entries: [] });
				}
				turnGroups[groupIndex[key]].entries.push(entry);
			}
			// The host hands the history over newest first, so the first group is
			// the one that happened last. It stands in for "this turn" when the
			// host cannot name the turn.
			const newestGroupKey = turnGroups.length > 0 ? turnGroups[0].key : null;
			// The turn the reviewed conversation is on now. It comes from the host
			// because only the host knows which turn a conversation has reached;
			// without it every group looked like an old one and the reader had to
			// open each one to see which was new.
			const currentTurn =
				reviewSession !== "" && snapshot.turns !== null && typeof snapshot.turns === "object"
					? typeof snapshot.turns[reviewSession] === "number"
						? snapshot.turns[reviewSession]
						: null
					: null;
			const turnTitle = (group) => {
				if (group.turn === null) return t("historyNoTurn");
				if (currentTurn !== null && group.turn === currentTurn) return t("historyThisTurn");
				return t("historyTurn").replace("{n}", String(group.turn));
			};
			const groupMetaOf = (group) => {
				let added = 0;
				let removed = 0;
				for (const entry of group.entries) {
					added += typeof entry.added === "number" ? entry.added : 0;
					removed += typeof entry.removed === "number" ? entry.removed : 0;
				}
				return t("historyGroupMeta")
					.replace("{n}", String(group.entries.length))
					.replace("{add}", String(added))
					.replace("{del}", String(removed));
			};
			const stateKeyOf = (entry) => (entry.state === "applied"
				? "stateApplied"
				: entry.state === "accepted"
					? "stateAccepted"
					: entry.state === "allowed"
						? "stateAllowed"
						: entry.state === "rejected"
							? "stateRejected"
							: entry.state === "timeout"
								? "stateTimeout"
								: entry.state === "cancelled"
									? "stateCancelled"
									: "statePending");

			/**
			 * One history row. Shared by every group so a row looks the same no
			 * matter which turn it came from.
			 */
			const historyRow = (entry) => h(
				"div",
				{
					className: "dshr-hist-row",
					key: entry.id,
					title: t("historyOpen"),
					"data-busy": String(historyBusy === entry.id),
					onClick: () => void openEntry(entry),
				},
				h("span", { className: "dshr-badge", "data-op": entry.op }, t(entry.op)),
				h(
					"span",
					{ className: "dshr-hist-body" },
					h("span", { className: "dshr-item-name", title: entry.path }, String(entry.path).split(/[\\/]/).pop()),
					h(
						"span",
						{ className: "dshr-hist-meta" },
						t(stateKeyOf(entry))
							+ (entry.restoredAt !== null && entry.restoredAt !== undefined ? " · " + t("restored") : ""),
					),
				),
				canRestore(entry)
					? h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-ghost": "true",
								title: t("restoreHint"),
								disabled: restoring === entry.id,
								onClick: (event) => {
									// The row itself opens the comparison; the undo is a
									// separate intent and must not be swallowed by it.
									if (event && typeof event.stopPropagation === "function") event.stopPropagation();
									void restore(entry);
								},
							},
							t("restore"),
						)
					: null,
			);

			// The opened entry, drawn with the same body the pending review uses.
			// A stored pair can be missing its `after` (the file was too large to
			// keep), so the view falls back to the hunk list instead of an empty pane.
			const historyDetailScreen = openHistory === null
				? null
				: h(
						"div",
						{ className: "dshr-hist dshr-hist-open" },
						h(
							"div",
							{ className: "dshr-hist-head" },
							h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-ghost": "true",
									onClick: () => setOpenHistory(null),
								},
								t("historyToList"),
							),
							h("span", { className: "dshr-badge", "data-op": openHistory.entry.op }, t(openHistory.entry.op)),
							h("span", { className: "dshr-item-name", title: openHistory.entry.path }, String(openHistory.entry.path).split(/[\\/]/).pop()),
							h("span", { className: "dshr-hist-meta" }, t(stateKeyOf(openHistory.entry))),
							openHistory.after === null || openHistory.after === undefined
								? null
								: h(
										"button",
										{
											className: "dshr-btn",
											type: "button",
											"data-ghost": "true",
											onClick: () => setHistoryView(historyView === "full" ? "unified" : "full"),
										},
										t(historyView === "full" ? "unified" : "full"),
									),
							canRestore(openHistory.entry)
								? h(
										"button",
										{
											className: "dshr-btn",
											type: "button",
											"data-ghost": "true",
											title: t("restoreHint"),
											disabled: restoring === openHistory.entry.id,
											onClick: () => void restore(openHistory.entry),
										},
										t("restore"),
									)
								: null,
						),
						histError === null ? null : h("div", { className: "dshr-note dshr-error" }, histError),
						openHistory.rows === null || openHistory.rows === undefined
							? h("div", { className: "dshr-empty-hint" }, t("historyEmpty"))
							: renderDiffBody({
									rows: openHistory.rows,
									before: openHistory.before,
									after: openHistory.after,
									op: openHistory.entry.op,
									view: historyView,
									t,
								}),
					);

			const historyScreen = showHistory
				? h(
						"div",
						{ className: "dshr-hist" },
						histError === null || historyDetailScreen !== null
							? null
							: h("div", { className: "dshr-note dshr-error" }, histError),
						historyDetailScreen !== null
							? historyDetailScreen
							: histories.length === 0
								? h("div", { className: "dshr-empty-hint" }, t("historyEmpty"))
								: [
										// The totals and the one button that clears everything sit
										// above the groups: both are about the whole store, and
										// putting them inside a group would suggest they only
										// affect that turn.
										h(
											"div",
											{ className: "dshr-hist-tools", key: "tools" },
											h(
												"span",
												{ className: "dshr-hist-total", title: t("historySizeHint") },
												t("historySize")
													.replace("{n}", String(screenStats.entries))
													.replace("{size}", sizeText(screenStats.bytes)),
											),
											histNote === null
												? null
												: h("span", { className: "dshr-hist-note" }, histNote),
											h(
												"button",
												{
													className: "dshr-btn",
													type: "button",
													"data-danger": "true",
													"data-on": String(clearArmed === "all"),
													title: t("historyClearAllHint"),
													disabled: clearBusy !== null,
													onClick: () => void clearHistory(undefined),
												},
												t(clearArmed === "all" ? "historyClearConfirm" : "historyClearAll"),
											),
										),
										...turnGroups.map((group) => {
											// The turn in progress is open, the earlier ones are shut:
											// a conversation with many turns would otherwise open on a
											// wall of rows with the reader's own turn buried in it.
											//
											// When the host cannot say which turn the conversation is
											// on, the newest group is left open instead: shutting
											// every group would hide the whole history behind a
											// stack of headings, which is worse than showing one
											// group too many.
											const folded = Object.hasOwn(foldedTurns, group.key)
												? foldedTurns[group.key] === true
												: group.turn === null
													? false
													: currentTurn !== null
														? group.turn !== currentTurn
														: group.key !== newestGroupKey;
											return h(
												"div",
												{ className: "dshr-hist-group", key: "g" + group.key },
												h(
													"div",
													{
														className: "dshr-hist-group-head",
														"data-folded": String(folded),
														onClick: () => {
															const next = Object.assign({}, foldedTurns);
															next[group.key] = !folded;
															setFoldedTurns(next);
														},
													},
													h("span", { className: "dshr-hist-twisty" }, folded ? "▸" : "▾"),
													h("span", { className: "dshr-hist-turn" }, turnTitle(group)),
													h("span", { className: "dshr-hist-group-meta" }, groupMetaOf(group)),
													// Clearing one turn is the narrow version of the button
													// above, next to the group it applies to so there is no
													// doubt about its scope.
													h(
														"button",
														{
															className: "dshr-btn",
															type: "button",
															"data-ghost": "true",
															"data-danger": "true",
															"data-on": String(clearArmed === group.key),
															title: t("historyClearTurnHint"),
															disabled: clearBusy !== null,
															onClick: (event) => {
																// The group head folds the group; clearing is a
																// different intent and must not also fold it.
																if (event && typeof event.stopPropagation === "function") event.stopPropagation();
																void clearHistory(group.turn === null ? null : group.turn);
															},
														},
														t(clearArmed === group.key ? "historyClearConfirm" : "historyClearTurn"),
													),
												),
												folded ? null : group.entries.map((entry) => historyRow(entry)),
											);
										}),
									],
					)
				: null;


			const header = h(
				"div",
				{ className: "dshr-bar" },
				// The bar is always there, even with nothing to review, because the switch
				// lives in it. With the old per-request exemption the button disappeared
				// the moment it was granted, so the one control that could undo it was
				// gone — a switch you cannot find again is the bug this replaces.
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
							// Editing the change is not accepting it: the model asks for
							// one text and the reader hands back another, so the panel has
							// to carry a whole file. Drawn only when the host would accept
							// it at all — every condition here mirrors a refusal in
							// `api.applyEdited`, because a button that always fails is worse
							// than no button.
							editable
								? h(
										"button",
										{
											className: "dshr-btn",
											type: "button",
											"data-ghost": "true",
											"data-on": String(editing),
											title: t("editHint"),
											disabled: busy === active.id,
											onClick: () => {
												if (editing) {
													setEditing(false);
													return;
												}
												setEditError(null);
												setEditText(currentAfter === null ? "" : currentAfter);
												setEditing(true);
											},
										},
										t("edit"),
									)
								: null,
						)
					: null,
				// A diff read in a column a third of a screen wide is read three words
				// at a time. The host's own chrome has this control already; repeating
				// it here is what makes the panel usable without hunting for it, and it
				// is drawn only when the host actually offers the action.
				props.canFullscreen === true
					? h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-ghost": "true",
								"data-on": String(fullscreen),
								title: t("fullscreenHint"),
								onClick: () => props.toggleFullscreen(),
							},
							t(fullscreen ? "fullscreenOff" : "fullscreenOn"),
						)
					: null,
				// The history sits next to the switch rather than in its own tab: it
				// answers the same question one step later ("what did I just accept"),
				// so it belongs to the same panel and must be reachable from the empty
				// state too — that is where a reader lands after allowing everything.
				reviewSession === ""
					? null
					: h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-ghost": "true",
								"data-on": String(showHistory),
								title: t("historyHint"),
								onClick: () => setShowHistory(!showHistory),
							},
							t(showHistory ? "historyBack" : "history"),
						),
				// How much is stored, on the bar itself: the answer to "is this
				// growing?" should not require opening the screen that lists it. It
				// is also the switch — pressing it opens the history — so the number
				// and the list are one control rather than two.
				reviewSession === "" || histStats.entries === 0
					? null
					: h(
							"span",
							{
								className: "dshr-hist-size",
								title: t("historySizeHint"),
								onClick: () => setShowHistory(true),
							},
							t("historySize")
								.replace("{n}", String(histStats.entries))
								.replace("{size}", sizeText(histStats.bytes)),
						),
				// The switch is always on screen — that is the whole point of replacing
				// a per-request exemption with it. Off, it accepts what is on screen and
				// stops asking about later writes; on, the same button turns it back off,
				// because a switch nobody can find again is exactly the bug it fixes.
				allowAllOn
					? h(
							"button",
							{
								className: "dshr-btn",
								type: "button",
								"data-on": "true",
								title: t("allowAllOffHint"),
								disabled: busy === "switch",
								onClick: () => setAllowAll(false),
							},
							t("allowAllOff"),
						)
					: reviewSession === ""
						? null
						: h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-ghost": "true",
									title: t("allowTurnHint"),
									disabled: active === null ? busy === "switch" : busy === active.id,
									// With nothing on screen there is no change to accept along
									// the way, so the switch is flipped on its own — the same
									// route, one argument lighter.
									onClick: () => (active === null ? setAllowAll(true) : decide(active, "allowTurn")),
								},
								t("allowTurn"),
							),
				// The biggest switch, and the only one that has to be reachable from a
				// panel with nothing in it: once a conversation is silenced there is
				// never anything on screen, so the way back has to live on the bar.
				reviewSession === ""
					? null
					: reviewOff
						? h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-on": "true",
									title: t("sessionOffOnHint"),
									disabled: busy === "session-off",
									onClick: () => setSessionOff(false),
								},
								t("sessionOffOn"),
							)
						: h(
								"button",
								{
									className: "dshr-btn",
									type: "button",
									"data-ghost": "true",
									title: t("sessionOffHint"),
									disabled: busy === "session-off",
									onClick: () => setSessionOff(true),
								},
								t("sessionOff"),
							),
				// Accept and reject act on the change, so they exist only while there is
				// one: the switch above is the only control that has to survive an empty
				// panel.
				active === null
					? null
					: h(
							React.Fragment,
							null,
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
						),
			);

			const notes = [];
			if (snapshot.error !== null) notes.push(h("div", { className: "dshr-note dshr-error", key: "err" }, t("error").replace("{msg}", snapshot.error)));
			// The switch is process-wide, so this note appears on every tab, including
			// the empty one: that is where a reader ends up right after allowing
			// everything, and silence there would look like a broken panel.
			if (allowAllOn) notes.push(h("div", { className: "dshr-note", key: "turn" }, t("turnAllowed")));
			// Silence has to be visible somewhere. A panel that simply stops asking
			// is indistinguishable from a broken one, and the reader who turned it
			// off may have been in another conversation at the time.
			if (reviewOff) notes.push(h("div", { className: "dshr-note", key: "off" }, t("sessionOffNote")));
			if (active !== null && active.truncated) notes.push(h("div", { className: "dshr-note", key: "trunc" }, t("truncated")));
			// A file the panel cannot diff line by line still has a change worth
			// reporting, and the byte counts are the whole of what can be said.
			if (active !== null && currentKind === "binary") {
				notes.push(
					h(
						"div",
						{ className: "dshr-note", key: "binary" },
						t("binaryFile")
							.replace("{before}", String(shown === null ? active.bytesBefore ?? 0 : shown.bytesBefore ?? 0))
							.replace("{after}", String(shown === null ? active.bytesAfter ?? 0 : shown.bytesAfter ?? 0)),
					),
				);
			}
			if (active !== null && currentKind === "sourcemap") {
				notes.push(
					h(
						"div",
						{ className: "dshr-note", key: "sourcemap" },
						t("sourceMapFile")
							.replace("{before}", String(shown === null ? active.bytesBefore ?? 0 : shown.bytesBefore ?? 0))
							.replace("{after}", String(shown === null ? active.bytesAfter ?? 0 : shown.bytesAfter ?? 0)),
					),
				);
			}
			// Two reports that used to be drawn as a full diff: nothing a reviewer
			// would read as a change of meaning, and drawing them line by line made a
			// reindent look like a rewrite.
			if (active !== null && currentNote === "line-endings") {
				notes.push(
					h(
						"div",
						{ className: "dshr-note", key: "eol" },
						t("lineEndingsOnly")
							.replace("{before}", String(shown === null ? active.bytesBefore ?? 0 : shown.bytesBefore ?? 0))
							.replace("{after}", String(shown === null ? active.bytesAfter ?? 0 : shown.bytesAfter ?? 0)),
					),
				);
			}
			if (active !== null && currentNote === "formatting") {
				notes.push(h("div", { className: "dshr-note", key: "fmt" }, t("formattingOnly")));
			}
			if (active !== null && shownDirectory) {
				notes.push(h("div", { className: "dshr-note", key: "dir" }, t("dirRemove")));
			}
			// A refusal is the one note that must never be silent: the reader pressed
			// Apply, and nothing on disk changed. Drawn above the diff so it is not
			// pushed out of view by a long file.
			if (editing && editError !== null) {
				notes.push(h("div", { className: "dshr-note dshr-error", key: "edit" }, String(editError)));
			}
			// Deleting a file produced a column of `-` lines with no statement of what
			// it added up to: this is that statement, and it is the one line that says
			// "everything in this file is about to be gone".
			if (active !== null && removedWhole && shownLines > 0 && view !== "full") {
				notes.push(
					h("div", { className: "dshr-note", key: "whole" }, t("deletedWhole").replace("{n}", String(shownLines))),
				);
			}
			// Two different statements, two different sentences: a shell command whose
			// result the shell decides later is not the same as a change too large to
			// draw, and saying the latter for the former is simply wrong. A formatter
			// is a third case again: the files are named, their new text is not.
			if (active !== null && active.reviewable === false) {
				const reasonKey = active.reason === "inplace"
					? "inplaceOnly"
					: (active.reason === "shell-command" ? "commandOnly" : "notReviewable");
				notes.push(h("div", { className: "dshr-note", key: "big" }, t(reasonKey)));
			}
			// A shell change has no before/after text to compare: show what the user is
			// approving. The step list comes first because it is the answer to the
			// question the whole block used to raise — "what is this command doing?"
			// — with the raw command folded underneath for the cases where the
			// summary is not enough. Approving a command you were shown only as a
			// summary would be approving something unseen, so the text is never gone,
			// just one click away.
			if (active !== null && typeof active.command === "string" && active.command !== "") {
				const steps = Array.isArray(active.steps) ? active.steps : [];
				if (steps.length > 0) {
					const stepLabels = {
						cd: "stepCd",
						write: "stepWrite",
						delete: "stepDelete",
						note: "stepNote",
						run: "stepRun",
						opaque: "stepOpaque",
					};
					const rows = [];
					rows.push(h("div", { className: "dshr-steps-head", key: "h" }, t("stepsHead")));
					for (let i = 0; i < steps.length; i += 1) {
						const step = steps[i];
						const label = t(stepLabels[step.kind] ?? "stepRun");
						const body = [
							h("span", { className: "dshr-step-kind", "data-kind": step.kind, key: "k" }, label),
							h("code", { className: "dshr-step-text", key: "t" }, String(step.text ?? "")),
						];
						// The file the step writes is the one thing a reader decides on, so
						// it is repeated as a target rather than left inside the code text.
						if (typeof step.path === "string" && step.path !== "") {
							body.push(h("div", { className: "dshr-step-path", key: "p" }, t("stepPath").replace("{path}", step.path)));
						}
						// An inline script gets its own block: that text is what was read
						// to decide the command was harmless or not.
						if (typeof step.code === "string" && step.code !== "") {
							body.push(h("code", { className: "dshr-step-code", key: "c" }, step.code));
						}
						rows.push(h("div", { className: "dshr-step", "data-kind": step.kind, key: `s${i}` }, ...body));
					}
					notes.push(h("div", { className: "dshr-steps", key: "steps" }, ...rows));
				}
				const toggle = h(
					"button",
					{
						type: "button",
						className: "dshr-raw-toggle",
						key: "rawtoggle",
						onClick: () => setShowRaw(!showRaw),
					},
					showRaw ? t("hideRaw") : t("showRaw"),
				);
				// With nothing to summarise there is no reason to fold the text away:
				// an empty step list means the summary would have been empty too, and a
				// hidden command with a button to reveal it is strictly worse than the
				// command itself.
				const unfoldable = steps.length === 0;
				const block = showRaw || unfoldable
					? h(
							"div",
							{ className: "dshr-cmd", key: "cmd" },
							h("span", { className: "dshr-cmd-label" }, t("rawCommand")),
							h("code", { className: "dshr-cmd-text" }, active.command),
						)
					: null;
				// The toggle is pointless when there is nothing folded away: it would
				// either reveal what is already on screen or hide the only review there
				// is.
				notes.push(
					h("div", { className: "dshr-raw", key: "raw" }, unfoldable ? null : toggle, block),
				);
			}

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
							// Nothing keys off turns any more — the switch is manual — but a
							// host that never reports one produces exactly the same panel as
							// a bug on our side, so the table stays as evidence.
							h(
								"div",
								{ className: "dshr-diagline", key: "d6" },
								t("diagTurn").replace(
									"{turns}",
									diag.turns !== null && typeof diag.turns === "object" && Object.keys(diag.turns).length > 0
										? Object.keys(diag.turns).map((sid) => String(sid).slice(0, 8) + "=" + String(diag.turns[sid])).join(", ")
										: "-",
								),
							),
						]
					: [];
				// The empty panel renders the bar and the notes too. Flipping the switch
				// leaves nothing to review, so this is the only screen a reader can be
				// looking at — and that is exactly where the control that turns the
				// switch back off used to disappear along with the panel.
				//
				// The same holds for the history: with nothing pending, it is the only
				// content this panel has, so it must be able to fill the pane.
				return h(
					"div",
					{ className: "dshr-root" },
					header,
						notes,
					historyScreen !== null
						? historyScreen
						: h(
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



			let body;
			if (active === null || detail === null) {
				body = h("div", { className: "dshr-empty" }, h("div", { className: "dshr-empty-hint" }, t("waiting")));
			} else if (editing) {
				// Editing needs both halves of the file even when the view is the hunk
				// list: the box holds the whole thing, so the pane beside it must too.
				body = h(EditPane, {
					before: currentBefore,
					text: editText,
					bytes: editBytes,
					tooBig: editTooBig,
					maxMb: String(MAX_EDIT_BYTES / (1024 * 1024)),
					busy: editBusy,
					t,
					onChange: (value) => setEditText(value),
					onCancel: () => {
						setEditing(false);
						setEditText("");
						setEditError(null);
					},
					onApply: () => void applyEdited(),
				});
			} else if (!hasRows) {
				// Nothing to draw: a command-level review is fully described by the command
				// block above, and an empty code pane would read as a failed render. A
				// binary file has no lines at all, so its size summary is the whole story.
				body = null;
			} else {
				body = renderDiffBody({
					rows: currentRows,
					before: currentBefore,
					after: currentAfter,
					op: shown === null ? active.op : shown.op,
					view,
					t,
				});
			}

			// A command that rewrote five files is five reviews in one decision. The
			// host sends every diff in the same answer, so switching files is a local
			// state change: no extra request, and the accept button stays one button
			// because the shell command behind it is still one command.
			const fileStrip = group === null
				? null
				: h(
						"div",
						{ className: "dshr-files" },
						h("div", { className: "dshr-files-head" }, t("fileCount").replace("{n}", String(group.length))),
						group.map((file, index) =>
							h(
								"div",
								{
									key: file.path + ":" + index,
									className: "dshr-item",
									"data-active": String(index === Math.min(fileIndex, group.length - 1)),
									title: file.path,
									onClick: () => setFileIndex(index),
								},
								h("span", { className: "dshr-badge", "data-op": file.op }, t(file.op)),
								h(
									"span",
									{ className: "dshr-item-name" },
									String(file.path).split(/[\\/]/).pop(),
								),
								h(
									"span",
									{ className: "dshr-item-meta" },
									// The kind comes first: a binary file has no line diff, so
									// testing `computed` before it labelled every binary file
									// "this file was left unchanged" — the opposite of the
									// truth, since its bytes are the reason it is in the strip.
									file.directory === true
										? t("dirEntry")
										: file.opaque === true
										? t("fileOpaque")
										: file.kind !== "text"
										? String(file.bytesBefore ?? 0) + " → " + String(file.bytesAfter ?? 0) + " B"
										: file.computed !== true
											? t("fileNoChange")
											: file.added === 0 && file.removed === 0
												? t("untouched")
												: "+" + file.added + " -" + file.removed,
								),
							),
						),
					);

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
				historyScreen !== null
					? historyScreen
					: h("div", { className: "dshr-layout" }, list, h("div", { className: "dshr-main" }, fileStrip, body)),
			);
		}

		/* -------------------------------------------------------------- apply -- */

		function apply(ctx) {
			ensureCss();

			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "dsh-diff-review: dictionaries");

			const store = createStore();
			/**
			 * Which conversations have a panel open.
			 *
			 * The panel asks the host about these and about nothing else. The host
			 * used to be asked about everything and answered with the size of
			 * every conversation on the machine, which is why the bar's figures
			 * never matched the history screen underneath it.
			 *
			 * A count rather than a flag: two tabs on the same conversation are
			 * two panels, and the second one closing must not take the first
			 * one's question away with it.
			 */
			const openSessions = new Map();
			store.registerSession = (sid) => {
				if (typeof sid !== "string" || sid === "") return () => {};
				openSessions.set(sid, (openSessions.get(sid) ?? 0) + 1);
				store.set({ sessionIds: Array.from(openSessions.keys()) });
				return () => {
					const left = (openSessions.get(sid) ?? 1) - 1;
					if (left <= 0) openSessions.delete(sid);
					else openSessions.set(sid, left);
					store.set({ sessionIds: Array.from(openSessions.keys()) });
				};
			};
			/**
			 * Fetch one change's diff and file it under its own id.
			 *
			 * The detail used to live in one slot with one id beside it, so a slow
			 * answer for one change could arrive after a newer one and be shown
			 * under the newer one's heading: the file's name from one change and
			 * the text of another. Filing by id makes that impossible, and it lets
			 * two panels show two different changes at the same time.
			 */
			store.loadDetail = async (id, owner) => {
				try {
					// Name the owner so the host can refuse a record that belongs to
					// another Session: the panel is one Session's window, and the id
					// alone must not double as a permission.
					const value = await apiCall("detail", { id: id, sessionId: owner });
					const details = Object.assign({}, store.get().details);
					// A record that is gone is filed as gone, so the panel stops
					// asking for it and shows what is there instead.
					details[id] = value && value.missing === true ? null : value;
					store.set({ details: details, error: null });
				} catch (error) {
					store.set({ error: error instanceof Error ? error.message : String(error) });
				}
			};
			store.refresh = async () => {
				try {
					const value = await apiCall("list", { sessionIds: store.get().sessionIds });
					const next = Array.isArray(value && value.changes) ? value.changes : [];
					// Details for changes that are gone are dropped with them: the
					// map is a cache of what is pending, not a log.
					const details = Object.assign({}, store.get().details);
					for (const id of Object.keys(details)) {
						if (!next.some((item) => item.id === id)) delete details[id];
					}
					store.set({
						changes: next,
						details: details,
						ready: true,
						error: null,
						// Which conversations are waved through, as a table. Copied
						// rather than aliased so a later mutation on the host side
						// cannot reach into React state behind the store's back.
						allowAll:
							value && typeof value.allowAll === "object" && value.allowAll !== null
								? Object.assign({}, value.allowAll)
								: {},
						// The bar shows how much history is stored, so it comes on the
						// same poll instead of costing a second request. The figures
						// are keyed by conversation: the bar sits above one
						// conversation's history and has to answer for that one.
						history:
							value && typeof value.historyBySession === "object" && value.historyBySession !== null
								? Object.assign({}, value.historyBySession)
								: {},
						turns:
							value && typeof value.turns === "object" && value.turns !== null
								? Object.assign({}, value.turns)
								: {},
						// Which conversations are silenced, as a table keyed by
						// session. Read from the host because the switch is kept
						// there: a second tab must show the same answer as the
						// one that flipped it.
						off:
							value && typeof value.off === "object" && value.off !== null
								? Object.assign({}, value.off)
								: {},
					});
				} catch (error) {
					store.set({ ready: true, error: error instanceof Error ? error.message : String(error) });
				}
			};

			/* ------------------------------------------------- tab open -- */

			/**
			 * Whether the host can widen this column on request.
			 *
			 * Read from the service face rather than assumed: `toggleFullscreen` only
			 * exists on hosts that ship the dock panel, and a button that throws when
			 * pressed is worse than a button that is not there.
			 */
			const canFullscreen = () =>
				typeof ctx.sidebarRight === "object"
				&& ctx.sidebarRight !== null
				&& typeof ctx.sidebarRight.toggleFullscreen === "function"
				&& typeof ctx.sidebarRight.commandTarget === "function";

			/**
			 * Widen or restore this column, the same way its own chrome button does.
			 *
			 * `commandTarget()` captures the pane the command applies to; passing no
			 * element lets it fall back to the on-screen Session's active dock pane,
			 * which is where this tab lives. A floating pane or a collapsed column is
			 * left alone by the host, so no state has to be tracked here.
			 */
			const toggleFullscreen = () => {
				if (!canFullscreen()) return;
				try {
					const target = ctx.sidebarRight.commandTarget();
					if (target === undefined || target === null) return;
					ctx.sidebarRight.toggleFullscreen(target);
				} catch {
					/* a host that refuses the action leaves the layout as it was */
				}
			};

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
				let inFlight = false;
				let timer = null;
				/**
				 * How long to wait before asking again.
				 *
				 * A pending change is worth a fast answer; an empty panel is not.
				 * The old timer asked fifty times a minute whatever was going on,
				 * and a slow host made each of those calls wait for the one before
				 * it — so the answers came back out of order and the queue grew.
				 */
				const isHidden = () =>
					typeof document !== "undefined" && document !== null && document.hidden === true;

				const schedule = (delay) => {
					if (disposed) return;
					if (timer !== null) window.clearTimeout(timer);
					timer = window.setTimeout(() => {
						timer = null;
						void tick();
					}, delay);
				};

				const tick = async () => {
					if (disposed) return;
					// One poll at a time. The next tick used to start before the last
					// answer came back, which stacked requests and let an older
					// answer land after a newer one.
					if (inFlight) {
						schedule(POLL_MS);
						return;
					}
					inFlight = true;
					let waiting = 0;
					try {
						const value = await apiCall("list", { sessionIds: store.get().sessionIds });
						const next = Array.isArray(value && value.changes) ? value.changes : [];
						waiting = next.length;
						// Details for changes that are gone are dropped with them.
						const details = Object.assign({}, store.get().details);
						for (const id of Object.keys(details)) {
							if (!next.some((item) => item.id === id)) delete details[id];
						}
						store.set({
							changes: next,
							details: details,
							ready: true,
							error: null,
							diag: value && typeof value.diag === "object" ? value.diag : null,
							// The poller is the live path — `refresh` only runs after a
							// decision — so the switch state has to be carried here too,
							// or the panel would show a stale state until the next click.
							allowAll:
								value && typeof value.allowAll === "object" && value.allowAll !== null
									? Object.assign({}, value.allowAll)
									: {},
							history:
								value && typeof value.historyBySession === "object" && value.historyBySession !== null
									? Object.assign({}, value.historyBySession)
									: {},
							turns:
								value && typeof value.turns === "object" && value.turns !== null
									? Object.assign({}, value.turns)
									: {},
							// The switch is persisted, so it arrives with every poll
							// rather than only from the click that set it.
							off:
								value && typeof value.off === "object" && value.off !== null
									? Object.assign({}, value.off)
									: {},
						});
						for (const item of next) {
							if (known.has(item.id)) continue;
							known.add(item.id);
							scheduleOpen(item.sessionId);
						}
						for (const id of Array.from(known)) {
							if (!next.some((item) => item.id === id)) known.delete(id);
						}
					} catch (error) {
						store.set({ ready: true, error: error instanceof Error ? error.message : String(error) });
					} finally {
						inFlight = false;
						// Nothing is waiting: there is no reason to ask again so
						// often. A hidden panel is asked even less often — nobody is
						// looking at it, and the browser throttles timers there anyway.
						schedule(waiting > 0 ? POLL_MS : isHidden() ? POLL_HIDDEN_MS : POLL_IDLE_MS);
					}
				};
				void tick();
				return () => {
					disposed = true;
					if (timer !== null) {
						window.clearTimeout(timer);
						timer = null;
					}
					if (openTimer !== null) {
						window.clearTimeout(openTimer);
						openTimer = null;
					}
				};
			}, "dsh-diff-review: pending poller");

			/* --------------------------------------------------- tab types -- */

			/**
			 * The artwork the guide entry draws, and the same artwork the manifest
			 * ships as `icon.svg`.
			 *
			 * A tab type may name a component here; without one the sidebar falls back
			 * to its own cube glyph, which is what our entry used to show — so editing
			 * the manifest icon alone changed the plugin list but left this list
			 * untouched. The fills are literal rather than `currentColor`: this
			 * artwork is drawn both here and, as a file, inside an `<img>`, and an
			 * `<img>` gives its SVG no page CSS to inherit from.
			 */
			const ReviewArtwork = (props) => {
				const size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 22;
				return h(
					"svg",
					{
						width: size,
						height: size,
						viewBox: "0 0 1024 1024",
						xmlns: "http://www.w3.org/2000/svg",
						className: props !== undefined && props !== null ? props.className : undefined,
						"aria-hidden": "true",
						focusable: "false",
					},
					h("path", {
						key: "sheet",
						fill: "#D6F3FA",
						d: "M609 805.1H214.5c-71.4 0-129.9-58.4-129.9-129.9V192.3c0-71.4 58.4-129.9 129.9-129.9H609c71.4 0 129.9 58.4 129.9 129.9v482.9c0 71.4-58.4 129.9-129.9 129.9z",
					}),
					h("path", {
						key: "ink",
						fill: "#18BAE5",
						d: "M503.6 916.1c0 12.8-10.4 23.1-23.1 23.1H246.2c-58 0-105.1-47-105.1-105.1V220c0-58 47-105.1 105.1-105.1h499.2c58 0 105.1 47 105.1 105.1v188.3c0 12.8-10.4 23.1-23.1 23.1-12.8 0-23.1-10.4-23.1-23.1V220c0-32.5-26.3-58.8-58.8-58.8H246.2c-32.5 0-58.8 26.3-58.8 58.8v614.2c0 32.5 26.3 58.8 58.8 58.8h234.3c12.7 0 23.1 10.3 23.1 23.1zM271.4 410.4c-12.7 0-23.1 10.4-23.1 23.1 0 12.7 10.4 23.1 23.1 23.1h117.3c12.7 0 23.1-10.4 23.1-23.1 0-12.7-10.4-23.1-23.1-23.1H271.4z m661.1 540.3c-10.3 10.3-27.2 10.3-37.6 0l-104-104c-44.3 35.6-100.4 57.1-161.5 57.1-142.4 0-258.2-115.8-258.2-258.2 0-142.4 115.8-258.2 258.2-258.2 142.4 0 258.2 115.8 258.2 258.2 0 62.2-22.1 119.2-58.8 163.9l103.8 103.8c10.2 10.1 10.2 27-0.1 37.4z m-91.3-305.2c0-116.9-95.1-211.9-211.9-211.9s-211.9 95.1-211.9 211.9 95.1 211.9 211.9 211.9 211.9-95.1 211.9-211.9z m-67.9-21.3c-11.2 0-20.2 9-20.2 20.2 0 65.4-53.2 118.7-118.7 118.7-11.2 0-20.2 9-20.2 20.2s9 20.2 20.2 20.2c42.5 0 82.4-16.5 112.4-46.6 30-30 46.6-70 46.6-112.4 0.1-11.2-8.9-20.3-20.1-20.3zM566.2 500.8c-34.8 16.6-62.4 45.2-77.7 80.6-4.4 10.2 0.3 22.1 10.5 26.6 2.6 1.1 5.3 1.6 8 1.6 7.8 0 15.3-4.5 18.5-12.2 11.4-26.4 32-47.8 58-60.2 10.1-4.8 14.3-16.8 9.5-26.9-4.7-10-16.7-14.3-26.8-9.5z m93.1-226.4c0-12.7-10.4-23.1-23.1-23.1H271.4c-12.7 0-23.1 10.4-23.1 23.1 0 12.7 10.4 23.1 23.1 23.1h364.8c12.7 0.1 23.1-10.3 23.1-23.1z",
					}),
				);
			};

			const TabTitleBound = (props) => TabTitle(Object.assign({}, props, { t: t, store: store }));
			const TabBodyBound = (props) => {
				const merged = Object.assign({}, props, {
					t: t,
					store: store,
					canFullscreen: canFullscreen(),
					toggleFullscreen: toggleFullscreen,
				});
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
						//
						// `icon` is what the entry actually draws — the sidebar's own
						// cube stands in when it is absent, which is why setting the
						// manifest icon changed nothing here.
						guide: [
							{
								id: "review",
								order: 30,
								title: () => t("title"),
								description: () => t("emptyHint"),
								icon: ReviewArtwork,
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
		// The poll rates, so a test can tell the poller's timer apart from the
		// other timers on the same channel instead of guessing by delay.
		exports.POLL_DELAYS = { active: POLL_MS, idle: POLL_IDLE_MS, hidden: POLL_HIDDEN_MS };
		return module.exports;
	}
});
