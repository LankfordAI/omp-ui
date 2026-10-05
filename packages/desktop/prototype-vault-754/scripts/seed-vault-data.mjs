// PROTOTYPE (#754): throwaway.
// The invented seed notes, shared by seed-vault.mjs and the bench smoke.
const fm = (extra = "") => `---\nprototype-754-seed: true\n${extra}---\n\n`;

export const SEED_NOTES = {
  "2026-09-29 omp-ui Planning Meeting.md":
    fm("date: 2026-09-29\nattendees: [Priya, Sam, Lee]\ntags: [meeting, omp-ui]\n") +
    `# omp-ui planning meeting

- Session HUD stays one line on desktop; overflow goes to the inspector rail.
- Open question: should vault writes be allowed while Plan mode is on? Priya: no, Plan means read-only.
- Sam to check how long a vault search may take before the agent gives up.
- Next: try the Obsidian hand-off on Linux.
`,
  "2026-10-02 Standup.md":
    fm("date: 2026-10-02\ntags: [standup]\n") +
    `# Standup 2026-10-02

- omp-ui: vault prototype next, measure search on a big vault.
- Home lab: replace the NAS fan.
`,
  "Session HUD.md":
    fm("tags: [idea]\n") +
    `# Session HUD

Idea: show cost per turn in the HUD. Maybe a mini context bar next to it.
Keep it glanceable; nothing that needs a click.
`,
  "Home Lab.md":
    fm("tags: [home]\n") +
    `# Home Lab

- NAS: 4-bay, two mirrors. The fan rattles, see [[2026-10-02 Standup]].
- Proxmox host: 64 GB, runs the media VM and the backup VM.
- UPS: 1500 VA, battery swapped in spring; self-test monthly.
`,
  "Reading List.md":
    fm("tags: [reading]\n") +
    `# Reading List

1. The Quiet Ledger, by Mara Oduya
2. Notes from a Slow Compiler, by Ivo Brandt
3. Harbor of Small Machines, by Lucia Ferrante
4. The Index Keeper, by Tomas Reyl
5. Weather for Engineers, by Ada Kinsella
`,
  "Obsidian Tips.md":
    fm("tags: [obsidian]\n") +
    `# Obsidian Tips

- Wikilinks resolve by name, so [[Title]] works from any folder.
- Use index notes to group related notes instead of deep folders.
- Keep folders flat; search and links do the finding.
`,
  "Desk Setup.md":
    fm("tags: [home]\n") +
    `# Desk Setup

Standing desk, one 32 inch monitor, the split keyboard. The omp-ui icon is the wallpaper this week:

![[omp-ui icon.png]]
`,
};
