import type { DialogRequest } from "../shared/ipc.ts";

/** The parts of Electron's MessageBoxOptions the in-app dialog shows. */
export interface AskOptions {
  type?: DialogRequest["type"];
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

/**
 * The in-app dialog's question, from what dialog.showMessageBox would have
 * been given. No buttons means one OK, and Esc then answers 0, both as the
 * native box does.
 */
export function dialogRequest(requestId: string, options: AskOptions, ok: string): DialogRequest {
  const buttons = options.buttons?.length ? options.buttons : [ok];
  const button = (id: number | undefined) => (Number.isInteger(id) && id! >= 0 && id! < buttons.length ? id! : 0);
  return {
    requestId,
    type: options.type ?? "none",
    message: options.message,
    ...(options.detail ? { detail: options.detail } : {}),
    buttons,
    defaultId: button(options.defaultId),
    cancelId: button(options.cancelId),
  };
}

/** The page's answer, trusted only as far as being one of the buttons. */
export function replyIndex(request: DialogRequest, response: unknown): number {
  return typeof response === "number" && Number.isInteger(response) && response >= 0 && response < request.buttons.length
    ? response
    : request.cancelId;
}
