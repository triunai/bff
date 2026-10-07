// Plain-words help copy (pure data). No internal project names; the agent tools are named together, never one alone.
export const GLOSSARY: readonly { term: string; meaning: string }[] = [
  { term: "Bead", meaning: "One tracked piece of work, such as a task or a bug, kept in your Beads tracker." },
  { term: "Lane", meaning: "One agent session (Claude, Codex or another tool) doing a job, or a column on the Board." },
  { term: "Drift", meaning: "A mismatch between what the tracker says and what is really happening, such as a claimed bead with no agent working on it." },
  { term: "Claim", meaning: "Marking a bead as taken so that only one agent works on it at a time." },
  { term: "Gate", meaning: "A check or a person's approval that must pass before work moves on." },
  { term: "Sealing", meaning: "Locking a finished piece of work so later changes cannot quietly rewrite it." },
  { term: "Herdr", meaning: "The terminal manager that runs your agent sessions side by side and lets Osiris see them." },
  { term: "Fleet", meaning: "All the agent sessions running right now, whichever tool started them." },
  { term: "Workstream (thread)", meaning: "One ongoing line of work with its own notes and history, tracked from your project docs." },
  { term: "ADR", meaning: "An architecture decision record, a short note saying what was decided and why." },
];

export const TAB_GUIDE: readonly { tab: string; purpose: string }[] = [
  { tab: "Home", purpose: "The landing view: what needs you, what is running, what it cost and what changed, each with a way to send an agent." },
  { tab: "Terminal", purpose: "Your live agent terminals, the place to talk to an agent." },
  { tab: "Calls", purpose: "Every tool call the agents made, with cost, timing and failures." },
  { tab: "Work", purpose: "Your tracker's beads as a graph, a board and a factory floor." },
  { tab: "History", purpose: "Commits and the days they landed, linked to the work they belong to." },
  { tab: "Calendar", purpose: "What happened on each day, so you can see yesterday at a glance." },
  { tab: "Health", purpose: "Checks on your repo and tracker, with the blockers that need a person." },
  { tab: "Archive", purpose: "Finished beads, kept for lookup." },
];

export const FIRST_RUN_INTRO = {
  beads: "Beads is a small task tracker that lives in your repo (a .beads folder); Osiris reads it to show your work.",
  herdr: "Herdr runs your agent terminals (Claude, Codex, Gemini and others) side by side; Osiris watches them through it.",
} as const;
