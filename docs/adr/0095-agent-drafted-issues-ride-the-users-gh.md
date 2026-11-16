# Agent-drafted issues ride the user's `gh`

> **Status:** Accepted, 2026-11-16. Amends [ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md) (`omp-ui_issue_draft` and `omp-ui_issue_file` join the gated host tools) and follows ADR-0094's posture for agent-write tools (setting gate, outside-sender exclusion, consent in the tool contract). Honors the [#414](https://github.com/LankfordAI/omp-ui/issues/414) rule: omp-ui holds no GitHub token.

An agent that hits a defect or spots a gap in omp-ui could only say so in prose; AGENTS.md says every request becomes an issue in `LankfordAI/omp-ui`, but "never initiate a filing on your own" meant the human was the only route. Two host tools close that gap without moving the consent: the agent recommends, the user approves, the host files.

## Decision

**1. Two tools, one write verb.** `omp-ui_issue_draft` is read-only: it validates arguments against the repo's issue templates (`bug_report.yml`, `feature_request.yml`), renders the exact markdown body the web form would produce — headings verbatim, template order — and runs `gh issue list --repo <repo> --search …` for duplicates. It files nothing. `omp-ui_issue_file` is the only write: `gh issue create --repo … --title … --label … --body-file …`, answered with the created URL. Both are essential strict-object schemas with one flat shape per tool (#1135); per-kind required fields live in one shared parser, so draft and file can never disagree about what the same arguments mean.

**2. The host binds approval to bytes.** `_file` re-renders the (title, repository, body) triple from its arguments with the same pure functions `_draft` used, and refuses unless the SHA-256 of that triple equals the fingerprint of the last draft this tab produced (a per-tab map on the answerer, cleared when the tab's process goes away). Any drift after a draft — one extra section, a different repository — forces another `_draft`, so what the user approved is byte-for-byte what gets filed. Consent itself stays a tool-contract rule like ADR-0094's `apply`: both descriptions state that filing requires the user's explicit request for it in this session; omp's host-tool approval tier still governs each call.

**3. No token (#414).** Every gh call shells out to the user's own CLI through the same `runGh` runner linked pull requests use (ADR-0079 posture): gh owns auth, host selection, and rate limits. Failure maps to four honest lines: not installed, not authenticated (exit 4), timed out or killed, or gh's first stderr line. The duplicate search failing never blocks a draft or a filing — the section is omitted with one honest line.

**4. Host facts, host gate.** The bug template's version block (omp-ui version, omp version, OS) is filled by main from the app version, `readInstalledOmpVersion` on the owning host's resolved binary, and `os.type() + os.release()` — appended once, never rewriting agent prose. A secrets guard (`scanSecrets`) runs over the rendered title and body in **both** tools before any duplicate search (whose words leave for GitHub) and before a draft is ever shown; a hit refuses with the shape id and never echoes the secret.

**5. Gates.** Registration mirrors the theme gate: setting `issueAgentAccess` (default off), never for webhook- or MCP-requested sessions, applied at the next spawn or resume, rpc-ui sessions only — PTY tabs have no host tools at all (ADR-0043). The answerer is constructed unconditionally at startup, so turning the setting on mid-run can never register a tool that answers "unavailable". A runaway cap of three filings per tab per process is incremented **before** the create runs, so a late gh success after the 60-second watchdog answer still counts; main logs the URL either way, and the description tells the agent a failed answer does not prove no issue was made.

## Consequences

- A duplicate means report-and-stop; the tool has no comment verb and no close — commenting on an existing issue stays the user's own path.
- The worst-case file path (version probe + search + create) sits inside the 60-second host-answer watchdog with a small margin; nothing needs a second result channel.
- The fingerprint makes "what was shown" a machine-checked property, not a prompt-honour: an agent that reworded the body between approval and filing is refused by the host, not asked nicely.
