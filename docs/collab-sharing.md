# Live session sharing (Collab)

Share live hands one running **terminal session** to teammates as a live
**Collab room**: they watch the session as it runs from a link, and — with a
control link — steer it: prompt, interrupt, and answer its approval prompts.
OMP hosts the room; omp-ui opens it, shows the links, and keeps the tab's
indicator honest. ([#686](https://github.com/LankfordAI/omp-ui/issues/686))

[Documentation home](README.md)

## What it is for

OMP's `/collab` hosts a room from inside a session's TUI and publishes join
links bound to the session's current generation. Guests join from any browser
at `my.omp.sh` or from another `omp` with `omp join <link>`. Everything runs on
this machine: the agent, its tools, and its files stay where they are; guests
see and drive the session, not the computer.

This is different from omp-ui's own [remote access](remote-access.md) and
[remote instances](remote-instances.md), which reach people who run or join an
omp-ui app with its credentials and grant whole-instance access. Collab grants
one person one session, needs no omp-ui account on their side, and works for
anyone who can open a link. It is also different from the HUD's **share**
control, which uploads an encrypted static snapshot; live sharing is the running
session.

## Share a terminal session

Live sharing works on terminal tabs only. omp's `/collab` lives in the TUI;
native transcript sessions do not expose it over the RPC protocol, and the
dialog says so instead of offering a control that cannot work.

1. Open the command palette on the terminal tab and choose **Share live** (or
   click the chip corner of the terminal when a room is already up).
2. The first share on this install shows the privacy confirmation once.
3. Choose **full** or **view-only** and start sharing. omp types `/collab` (or
   `/collab view`) into the session itself — the same keystroke channel as
   typing in the terminal — and omp-ui confirms the room by watching omp's
   local registry for the row.
4. Copy or scan a link. A **control link** opens the room with the access you
   chose; a **view-only link** is always read-only, whatever the host's access
   is.

While the room is up, the tab shows a **live** chip; hovering it names the
access level. The dialog shows the guest count, a relay-offline notice when the
relay cannot be reached, and a waiting marker when a guest's request needs an
answer in the terminal. **Stop sharing** types `/collab stop` into the session;
the room's registry row disappears within a poll, and the chip retires.

## Full and view-only

- **Full access**: guests render the session natively and can prompt,
  interrupt, answer `select`/`editor` requests, and use Agent Hub. Their turns
  appear in the transcript like your own.
- **View only**: guests watch. Approval prompts and input stay with you.
- Changing the access level takes **stop sharing**, then a start with the
  other choice: the dialog shows no switch while a room is up, and the new
  room gets a fresh key.

## Trust model

Read this before the first share:

- **A link is secret material.** The room key lives only in the link's URL
  fragment, so the relay never sees plaintext — but anyone who holds the link
  can join while the room is open. Do not paste it into chat that others can
  read; the dialog says this too.
- **Full-access guests drive a session that runs tools on this machine.**
  Share full access the way you would hand over the keyboard.
- **Guests see everything the session says while they watch.** Live sharing is
  a room, not a snapshot: there is no retrospective redaction.

## Room lifetime

Rooms follow the session's generation, not the tab. `/new`, `/resume`, and a
branch switch end the current room, and the next share opens a new room with a
new key. omp-ui detects the rotation from the registry's generation counter and
re-fetches the links, so a stale link you handed out simply stops working —
which is the intended revocation path, alongside **stop sharing** and closing
the session (the registry row dies with the process).

## How it works underneath

OMP owns hosting; omp-ui only reads and steers. Desktop main's `CollabTracker`
polls `omp collab list --json` once per two seconds while at least one terminal
session is live, matches registry rows to tabs by OS pid, and publishes per-tab
state only on change — a foreign host (an `omp` you started in your own
terminal) is never surfaced, because its pid is not one of ours. Share and stop
are keystrokes into the PTY, and success is the registry row appearing (or
clearing) on a later poll, never an assumed round-trip; a share that has drawn
no row within six seconds reports the doubt instead of claiming a room. Join
links come from `omp collab link <pid> [--view] --json`, fetched on demand and
held only while the dialog is open. The renderer never holds a room key: links
are opaque URLs, re-fetched whenever the generation changes. See
[Architecture — Live sharing](architecture.md#live-sharing-collab).

## Related guides

- [Documentation home](README.md)
- [User guide](user-guide.md)
- [Remote access](remote-access.md) — the whole-instance alternative
- [Troubleshooting](troubleshooting.md)
