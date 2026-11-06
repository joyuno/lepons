export type FileHistory = { paths: string[]; index: number };

export function navigate(history: FileHistory, action: "back" | "forward" | { open: string }): FileHistory {
  if (action === "back") return { ...history, index: Math.max(0, history.index - 1) };
  if (action === "forward") return { ...history, index: Math.min(history.paths.length - 1, history.index + 1) };
  if (history.paths[history.index] === action.open) return history;
  const paths = [...history.paths.slice(0, history.index + 1), action.open];
  return { paths, index: paths.length - 1 };
}
