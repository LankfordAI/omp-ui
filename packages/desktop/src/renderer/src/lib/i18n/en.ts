/**
 * English catalog — the source of truth (issue #363). Plain text only: no
 * HTML, no angle brackets. {var} placeholders are substituted by t().
 * Surface by surface the rest of the chrome fills this in.
 */
export const en = {
  "settings.general.language": "Language",
  "settings.general.languageHint":
    "The language of the application chrome. Session content and terminal output are never translated.",
  // Shared shell words (ui/controls.tsx, ui/overlays.tsx, dialog footers)
  "common.dialog.cancel": "Cancel",
  "common.overlay.close": "close dialog",
  "common.overlay.closeNamed": "close {label}",
  "common.button.attachImages": "attach images",
  "common.button.copy": "copy",
  "common.button.copied": "copied",

  // App.tsx — TitleBar
  "app.titlebar.newSession": "new session in current project",
  "app.titlebar.addProject": "add project",
  "app.titlebar.expandSidebar": "expand sidebar",
  "app.titlebar.collapseSidebar": "collapse sidebar",

  // App RestoringSessions
  "app.restoring.label": "Restoring sessions…",

  // App Welcome
  "app.welcome.hasProjectsHint":
    "Pick a session from the sidebar, or start a new one in any tracked project.",
  "app.welcome.addProject": "Add project",
  "app.welcome.openSession": "Open session…",
  "app.welcome.noProjectsHint":
    "Track a project directory, then run omp agents against it — as a terminal or as a native session.",
  "app.welcome.hintCommandPalette": "command palette",
  "app.welcome.hintNewSession": "new session in the current project",
  "app.welcome.hintMode": "switch Build / Plan mode",
  "app.welcome.hintConsole": "toggle console",
  "app.welcome.hintSearch": "search within a session",
  "app.welcome.hintTranscriptScale": "larger transcript text",

  // App compact shell nav
  "app.compact.projectsAndSessions": "projects and sessions",
  "app.compact.inspector": "inspector",

  // ExtensionDialogHost.tsx
  "dialog.extension.fallbackTitle": "extension request",
  "dialog.extension.waiting": "the agent is waiting on this answer",
  "dialog.extension.answered": "answered",
  "dialog.extension.selected": "{n} selected",
  "dialog.extension.pickedTitle": "answers picked so far — picking again removes one",
  "dialog.extension.more": "{n} more",
  "dialog.extension.reviewFinal": "answers are final once sent · Esc back",
  "dialog.extension.backToQuestion": "back to question {n}",
  "dialog.extension.noChoices": "No choices are available for this request.",
  "dialog.extension.other": "Other — type your own…",
  "dialog.extension.multiHint": "↑↓ move · Space or click toggles · Enter done · Esc dismiss",
  "dialog.extension.singleHint": "↑↓ choose · Enter answer · Esc dismiss",
  "dialog.extension.cancel": "cancel",
  "dialog.extension.confirm": "confirm",
  "dialog.extension.submit": "submit",
  "dialog.extension.doneTitle": "finish selecting and send the answer",
  "dialog.extension.done": "done selecting",
  "dialog.extension.seriesProgress": "question series progress",
  "dialog.extension.reviewing": "Reviewing {n} of {total}",
  "dialog.extension.question": "Question {n} of {total}",
  "dialog.extension.questionAria": "question {page} of {total}, {status}",
  "dialog.extension.questionCurrent": "current",
  "dialog.extension.questionNotAnswered": "not answered",
  "dialog.extension.questionReviewing": ", reviewing",

  // DeleteSessionDialog.tsx
  "dialog.delete.kicker": "Irreversible action",
  "dialog.delete.title": "Delete “{title}”?",
  "dialog.delete.merging": "merging…",
  "dialog.delete.mergeAndDelete": "merge & delete",
  "dialog.delete.deleteMany": "Delete {n} sessions",
  "dialog.delete.deleteSession": "Delete session",
  "dialog.delete.running": "Its running agent will be stopped. ",
  "dialog.delete.erased": "Its transcript and artifacts will be erased. ",
  "dialog.delete.worktreeDeleted":
    "Its worktree checkout will be removed — uncommitted changes there are lost, and the branch {branch} is deleted. ",
  "dialog.delete.worktreeAlreadyMerged":
    "Its worktree checkout will be removed — uncommitted changes there are lost. The branch {branch} (already in {destination}) is deleted. ",
  "dialog.delete.worktreeSurvives":
    "Its worktree checkout will be removed — uncommitted changes there are lost. Commits survive on {branch}. ",
  "dialog.delete.cannotUndo": "This cannot be undone.",
  "dialog.delete.alsoDeletes": "Also deletes {n} plan implementation descendant{s}",
  "dialog.delete.runningSuffix": " · running",
  "dialog.delete.more": "+{n} more",
  "dialog.delete.cascadeErased":
    "Their transcripts and artifacts are erased too, and any running agent among them is stopped.",
  "dialog.delete.mergeRow": "merge {branch} into {destination} first",
  "dialog.delete.dontShowAgain": "Do not show this warning again",
  "dialog.delete.busy": "a session is mid-turn in the project",
  "dialog.delete.baseGone": "the recorded base no longer resolves",
  "dialog.delete.checkoutFirst": "check out {destination} in the project first",
  "dialog.delete.mergeInProgress": "a merge is already in progress in the project",
  "dialog.delete.alreadyMerged": "already in {destination}",
  "dialog.delete.branchGone": "the worktree branch no longer exists — nothing to merge",
  "dialog.delete.mergeNoLonger": "the merge is no longer possible — uncheck it to delete plainly",
  "dialog.delete.mergeConflicts":
    "the merge stopped on {n} file(s) — resolve them in {cwd}, then delete without merging",

  // NewWorktreeSessionDialog.tsx
  "dialog.worktree.kicker": "New worktree session",
  "dialog.worktree.title": "Start a session in a fresh worktree?",
  "dialog.worktree.create": "Create session",
  "dialog.worktree.notGit": "This project isn't inside a git repo, so there's nothing to worktree.",
  "transcript.assistant.thinking": "thinking",
  "transcript.speaker.assistant": "assistant",
  "transcript.speaker.you": "you",
  "transcript.view.jumpToLatest": "jump to latest",
  "transcript.empty.title": "Nothing yet",
  "transcript.empty.hint": "Send a prompt to start the session.",
  "transcript.usage.cache": "cache",
  "transcript.usage.ttft": "ttft",
  "transcript.image.alt": "attached image {n}",
  "transcript.image.title": "{mimeType} — image {n} of {count}",
  "notice.path.open": "open {path}",
  "notice.path.reveal": "reveal in file manager",
  "transcript.command.tuiHandoff": "run in omp TUI",
  "transcript.row.broken": "message failed to render",
  "transcript.tool.plan": "plan",
  "transcript.tool.running": "running",
  "transcript.tool.error": "error",
  "transcript.tool.aborted": "aborted",
  "transcript.tool.cancelled": "cancelled",
  "transcript.tool.stalled": "stalled {duration}",
  "transcript.tool.stalledTitle":
    "No model-stream frame (text, thinking, or tool-call arguments) has arrived while " +
    "the assistant response is open. Local tool execution does not reset this clock.",
  "transcript.tool.writing": "writing",
  "transcript.tool.streaming": "streaming",
  "transcript.tool.showOutput": "show output · {lines} lines",
  "transcript.tool.allArguments": "all arguments",
  "transcript.contextmenu.copy": "Copy",
  "transcript.contextmenu.copyMarkdown": "Copy as Markdown",
  "transcript.findbar.placeholder": "search",
  "transcript.findbar.noMatches": "no matches",
  "transcript.findbar.position": "{index} / {count}",
  "transcript.findbar.previous": "previous match",
  "transcript.findbar.next": "next match",
  "transcript.findbar.close": "close find",
  "transcript.subagent.backToMain": "back to main agent",
  "transcript.subagent.back": "‹ main agent",
  "transcript.subagent.agentType": "agent type: {type}",
  "transcript.subagent.readOnly": "read-only subagent view",
  "transcript.subagent.empty": "No activity captured yet — the transcript fills in as the agent works.",
  // Composer textarea placeholders
} as const;
