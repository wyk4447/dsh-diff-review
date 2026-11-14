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
			"allowTurn": "全部允许",
			"allowTurnHint": "接受这一项，并且之后所有写入都不再询问（删除和改名仍然会问；再点一次可以关掉）",
			"allowAllOff": "已全部允许 · 点此关闭",
			"allowAllOffHint": "现在所有写入都不再询问；点这里恢复逐项确认",
			"turnAllowed": "已全部允许：写入不再询问，删除和改名仍然会问",
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
			"diagTurn": "轮次：{turns}",
			"history": "历史",
			"historyHint": "本会话审查过的改动；点还原把文件恢复成改动前的样子",
			"historyEmpty": "本会话还没有审查记录",
			"historyBack": "返回待审",
			"restore": "还原",
			"restoreHint": "把文件恢复成这次改动之前的内容；文件已再次变化时会拒绝",
			"restored": "已还原",
			"statePending": "待审",
			"stateAccepted": "已接受",
			"stateRejected": "已拒绝",
			"stateTimeout": "超时放行",
			"stateCancelled": "已取消",
			"restoreNotRestorable": "这条记录没有可用的原文快照",
			"restoreNotApplied": "这次改动并未落盘，无需还原",
			"restoreAlready": "已经还原过了",
			"restoreStale": "文件在此之后又变过，已拒绝还原",
			"restoreFailed": "还原失败，请稍后再试",
			"binaryFile": "二进制文件，{before} → {after} 字节",
			"sourceMapFile": "sourcemap，{before} → {after} 字节",
			"lineEndingsOnly": "仅换行符变化（{before} → {after} 字节）",
			"formattingOnly": "仅格式变化（缩进与空白），行内容未变",
			"fileCount": "{n} 个文件",
			"fileNoChange": "该文件内容未变",
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
			"diagTurn": "Turns: {turns}",
			"history": "History",
			"historyHint": "Changes already reviewed in this conversation; restore puts one file back",
			"historyEmpty": "Nothing reviewed in this conversation yet",
			"historyBack": "Back to pending",
			"restore": "Restore",
			"restoreHint": "Put the file back to what it held before this change; refused if it has changed since",
			"restored": "Restored",
			"statePending": "Pending",
			"stateAccepted": "Accepted",
			"stateRejected": "Rejected",
			"stateTimeout": "Timed out",
			"stateCancelled": "Cancelled",
			"restoreNotRestorable": "No usable snapshot for this entry",
			"restoreNotApplied": "This change never reached the disk, nothing to undo",
			"restoreAlready": "Already restored",
			"restoreStale": "The file changed since then; restore refused",
			"restoreFailed": "Restore failed, try again",
			"binaryFile": "Binary file, {before} → {after} bytes",
			"sourceMapFile": "Source map, {before} → {after} bytes",
			"lineEndingsOnly": "Line endings only ({before} → {after} bytes)",
			"formattingOnly": "Formatting only (indent and whitespace), no line content changed",
			"fileCount": "{n} files",
			"fileNoChange": "This file was left unchanged",
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

		/* ------------------------------------------------------------- store -- */

		function createStore() {
			let state = {
				changes: [],
				detail: null,
				detailId: null,
				error: null,
				ready: false,
				diag: null,
				// Which conversations have writes waved through, keyed by session.
				// A single boolean was wrong: the switch belongs to one conversation,
				// and reading it globally made every other tab show the state of
				// whichever one was toggled last.
				allowAll: {},
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
			const snapshot = useStore(store);
			const [view, setView] = React.useState("unified");
			const [selectedId, setSelectedId] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			// The history is a second screen, not a second tab: it is the same panel
			// with the same conversation, and a reader wants to step back from a
			// pending decision to what they accepted a moment ago and return.
			const [showHistory, setShowHistory] = React.useState(false);
			const [histories, setHistories] = React.useState([]);
			const [histError, setHistError] = React.useState(null);
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
				store.load(active.id, sessionId);
			}, [active === null ? null : active.id, snapshot.detailId, snapshot.detail, store]);

			const detail = snapshot.detailId !== null && active !== null && snapshot.detailId === active.id
				? snapshot.detail
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
			}, [activeKey]);

			const currentRows = shown === null ? (detail === null ? null : detail.rows) : shown.rows;
			const currentBefore = shown === null ? (detail === null ? null : detail.before) : shown.before;
			const currentAfter = shown === null ? (detail === null ? null : detail.after) : shown.after;
			const currentKind = shown === null ? (active === null ? "text" : active.kind) : shown.kind;
			const currentNote = shown === null ? (active === null ? undefined : active.note) : shown.note;
			// A command-level review has no rows to draw, so the view toggle would be a
			// button that changes nothing: hide it there rather than lie about it.
			const hasRows = Array.isArray(currentRows) && currentRows.length > 0;

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
					setHistError(null);
				} catch (error) {
					setHistError(error instanceof Error ? error.message : String(error));
				}
			};

			React.useEffect(() => {
				if (showHistory) void loadHistory();
			}, [showHistory, reviewSession]);

			/** Word a host refusal as the sentence the reader needs, not a code. */
			const restoreReason = (code) => {
				if (code === "not-restorable") return t("restoreNotRestorable");
				if (code === "not-applied") return t("restoreNotApplied");
				if (code === "already-restored") return t("restoreAlready");
				if (code === "stale") return t("restoreStale");
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

			const historyScreen = showHistory
				? h(
						"div",
						{ className: "dshr-hist" },
						histError === null
							? null
							: h("div", { className: "dshr-note dshr-error" }, histError),
						histories.length === 0
							? h("div", { className: "dshr-empty-hint" }, t("historyEmpty"))
							: histories.map((entry) =>
									h(
										"div",
										{ className: "dshr-hist-row", key: entry.id },
										h("span", { className: "dshr-badge", "data-op": entry.op }, t(entry.op)),
										h(
											"span",
											{ className: "dshr-hist-body" },
											h("span", { className: "dshr-item-name", title: entry.path }, String(entry.path).split(/[\\/]/).pop()),
											h(
												"span",
												{ className: "dshr-hist-meta" },
												t(
													entry.state === "accepted"
														? "stateAccepted"
														: entry.state === "rejected"
															? "stateRejected"
															: entry.state === "timeout"
																? "stateTimeout"
																: entry.state === "cancelled"
																	? "stateCancelled"
																	: "statePending",
												)
													+ (entry.restoredAt !== null && entry.restoredAt !== undefined ? " · " + t("restored") : ""),
											),
										),
										// An undo that cannot be verified is not offered at all:
										// a button that always refuses is worse than its absence.
										entry.restorable === true
											&& entry.verify !== null && entry.verify !== undefined
											&& (entry.state === "accepted" || entry.state === "timeout")
											&& (entry.restoredAt === null || entry.restoredAt === undefined)
											? h(
													"button",
													{
														className: "dshr-btn",
														type: "button",
														"data-ghost": "true",
														title: t("restoreHint"),
														disabled: restoring === entry.id,
														onClick: () => restore(entry),
													},
													t("restore"),
												)
											: null,
									),
								),
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
			// Two different statements, two different sentences: a shell command whose
			// result the shell decides later is not the same as a change too large to
			// draw, and saying the latter for the former is simply wrong.
			if (active !== null && active.reviewable === false) {
				notes.push(h("div", { className: "dshr-note", key: "big" }, t(active.reason === "shell-command" ? "commandOnly" : "notReviewable")));
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
			} else if (!hasRows) {
				// Nothing to draw: a command-level review is fully described by the command
				// block above, and an empty code pane would read as a failed render. A
				// binary file has no lines at all, so its size summary is the whole story.
				body = null;
			} else if (view === "full") {
				// Paint the changed lines inside each full file, so both panes keep the real
				// line numbers of the file instead of a renumbered diff side.
				const markedA = new Set();
				const markedB = new Set();
				for (const row of currentRows) {
					if (row.t === "del" && row.a !== null) markedA.add(row.a);
					if (row.t === "add" && row.b !== null) markedB.add(row.b);
				}
				body = h(SplitView, {
					before: currentBefore === null ? "" : currentBefore,
					after: currentAfter === null ? "" : currentAfter,
					markedA,
					markedB,
					deleted: (shown === null ? active.op : shown.op) === "delete" && (currentAfter === null || currentAfter === ""),
					t,
				});
			} else {
				const spans = inlineRanges(currentRows);
				body = h(
					"div",
					{ className: "dshr-code" },
					currentRows.map((row, index) => DiffRow(row, index, t, spans.get(index))),
				);
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
									file.kind !== "text"
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
			store.load = async (id, owner) => {
				store.set({ detailId: id });
				try {
					// Name the owner so the host can refuse a record that belongs to
					// another Session: the panel is one Session's window, and the id
					// alone must not double as a permission.
					const value = await apiCall("detail", { id: id, sessionId: owner });
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
						// Which conversations are waved through, as a table. Copied
						// rather than aliased so a later mutation on the host side
						// cannot reach into React state behind the store's back.
						allowAll:
							value && typeof value.allowAll === "object" && value.allowAll !== null
								? Object.assign({}, value.allowAll)
								: {},
					});
					if (!stillThere && next.length > 0) store.load(next[0].id, next[0].sessionId);
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
							// decision — so the switch state has to be carried here too,
							// or the panel would show a stale state until the next click.
							allowAll:
								value && typeof value.allowAll === "object" && value.allowAll !== null
									? Object.assign({}, value.allowAll)
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
						const current = store.get();
						if (next.length > 0 && !next.some((item) => item.id === current.detailId)) {
							store.load(next[0].id, next[0].sessionId);
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
		return module.exports;
	}
});
