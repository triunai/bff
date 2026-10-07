// The three "needs you" figures count DIFFERENT things, so each carries its own noun. One text function per surface:
//  - header chip: agent sessions blocked on a person (fleet lanes waiting on a question, permission or your turn)
//  - GOAL rail:   decisions on the goal awaiting an answer (the goal doc's owner-gate items plus its OWNER DECISIONS list, NOT the bead-based Decisions panel)
//  - Health:      blocker rows that are not passing
const s = (n: number) => (n === 1 ? "" : "s");
export const agentsWaitingText = (n: number): string => (n > 0 ? `${n} agent${s(n)} waiting for you` : "");
export const decisionsWaitingText = (n: number): string => `${n} goal decision${s(n)} ${n === 1 ? "needs" : "need"} an answer`;
export const blockersText = (n: number): string => (n === 0 ? "No blockers" : `${n} blocker${s(n)}`);
