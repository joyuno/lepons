// The phone's first connection, one step at a time. No DOM: main.ts paints it, the tests read it.

export type SetupStep = "password" | "totp" | "app" | "pair" | "done";

/** What is true now, never what was clicked: closing midway resumes from this. */
export interface SetupFacts {
  hasPassword: boolean;
  /** A key whose code was once typed back correctly, or one from before this check existed. */
  totpReady: boolean;
  /** 다음 was pressed on the download step. */
  appSeen: boolean;
  paired: boolean;
}

const order = ["password", "totp", "app", "pair"] as const;

/**
 * The page 폰 앱 받기 sends the phone to. Checked 2026-11-04: it opens and holds the
 * APK. The site's own releases/latest/download/Lepons-Android.apk was 404 that day,
 * the release's file carrying a version in its name.
 */
export const APP_PAGE = "https://github.com/joyuno/lepons/releases/latest";

function finished(step: (typeof order)[number], facts: SetupFacts): boolean {
  if (step === "password") return facts.hasPassword;
  if (step === "totp") return facts.totpReady;
  // A paired phone has the app, whatever this PC remembers about the page.
  if (step === "app") return facts.appSeen || facts.paired;
  return facts.paired;
}

/** The next step not done yet, after `step` or from the start; steps done are not repeated. */
export function stepAfter(step: SetupStep | undefined, facts: SetupFacts): SetupStep {
  const from = step === undefined ? 0 : order.indexOf(step as (typeof order)[number]) + 1;
  return order.slice(from).find((candidate) => !finished(candidate, facts)) ?? "done";
}

export const firstUnfinished = (facts: SetupFacts): SetupStep => stepAfter(undefined, facts);

/** 이전 walks every step, done or not, to look at it again. Undefined where there is no going back. */
export function stepBefore(step: SetupStep): SetupStep | undefined {
  return step === "done" ? undefined : order[order.indexOf(step) - 1];
}

/** "1/4", and nothing on the closing page. */
export const progressText = (step: SetupStep): string => (step === "done" ? "" : `${order.indexOf(step) + 1}/${order.length}`);

/** How much of the walk this step stands for, for the bar that fills as it goes. */
export const progressShare = (step: SetupStep): number => (step === "done" ? 1 : (order.indexOf(step) + 1) / order.length);

/** Which way a step change reads: on through the walk, or back. */
export function stepForward(from: SetupStep, to: SetupStep): boolean {
  const place = (step: SetupStep) => (step === "done" ? order.length : order.indexOf(step));
  return place(to) >= place(from);
}

/** Main refuses a short password too; here the mismatch it cannot see is caught. */
export function passwordProblem(password: string, again: string): "short" | "mismatch" | undefined {
  if (password.length < 8) return "short";
  return password === again ? undefined : "mismatch";
}

/** Authenticator apps show "123 456". */
export const cleanCode = (text: string): string => text.replace(/\s/g, "");

export const codeShaped = (code: string): boolean => /^\d{6}$/.test(code);

/** Four and four, for typing by hand; apps ignore the spaces. */
export const keyInGroups = (key: string): string => key.replace(/(.{4})(?=.)/g, "$1 ");
