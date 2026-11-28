/**
 * The modal the automation forms and the approval dialog share: a title on
 * top, a body that scrolls, and a footer that stays on screen (the form styles
 * are the view's: .autoSet). A press and a click both outside the box close it,
 * as Esc does; the caller decides what a close means.
 */
export function dialogShell(): { dialog: HTMLDialogElement; head: HTMLHeadingElement; body: HTMLDivElement; foot: HTMLDivElement } {
  const dialog = document.createElement("dialog");
  dialog.className = "autoDialog";
  const head = document.createElement("h2");
  head.className = "autoDialogHead";
  const body = document.createElement("div");
  body.className = "autoSet autoDialogBody";
  const foot = document.createElement("div");
  foot.className = "autoSet autoDialogFoot";
  dialog.append(head, body, foot);
  // Only a press and a click both outside the box close it: not its own padding, nor a text selection dragged out.
  const outside = (event: MouseEvent) => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => { pressedOutside = outside(event); });
  dialog.addEventListener("click", (event) => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
  document.body.append(dialog);
  return { dialog, head, body, foot };
}
