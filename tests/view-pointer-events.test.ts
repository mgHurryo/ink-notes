// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView } from "../src/view";
import { registerDocumentPointerEndEvents } from "../src/ink-input";

interface PointerView {
  onDocumentPointerEnd(event: PointerEvent): void;
  pageElement: HTMLElement;
  activePointerId: number | null;
  register(callback: () => void): void;
  finishPointerInput(includeFinalSample: boolean): void;
  capturePointer(pointerId: number): void;
  releasePointer(pointerId: number): void;
}

const registeredCleanups: (() => void)[][] = [];

function frameDocument(): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  return frame.contentDocument!;
}

function setup(ownerDocument = document) {
  const view = Object.create(InkView.prototype) as PointerView;
  const page = ownerDocument.createElement("div");
  ownerDocument.body.append(page);
  const cleanups: (() => void)[] = [];
  registeredCleanups.push(cleanups);
  let migrated!: () => void;
  const stopMigration = vi.fn();
  page.onWindowMigrated = (listener) => {
    migrated = () => listener(page.ownerDocument.defaultView!);
    return stopMigration;
  };
  Object.assign(view, {
    pageElement: page,
    activePointerId: 7,
    register: (cleanup: () => void) => cleanups.push(cleanup),
    finishPointerInput: vi.fn(() => { view.activePointerId = null; }),
  });
  return { view, page, cleanups, migrate: () => migrated(), stopMigration };
}

function endPointer(target: EventTarget, type = "pointerup", pointerId = 7): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

afterEach(() => {
  for (const cleanups of registeredCleanups.splice(0)) {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  }
  document.body.replaceChildren();
});

describe("pointer completion event registration", () => {
  it.each(["pointerup", "pointercancel"])("finishes uncaptured input outside the page in its owner document on %s", (type) => {
    const owner = frameDocument();
    const { view, page, cleanups } = setup(owner);
    registerDocumentPointerEndEvents(page, (cleanup) => cleanups.push(cleanup), (event) => view.onDocumentPointerEnd(event));

    endPointer(document.body, type);
    expect(view.activePointerId).toBe(7);
    endPointer(owner.body, type);
    expect(view.finishPointerInput).toHaveBeenCalledExactlyOnceWith(false);
    expect(view.activePointerId).toBeNull();
  });

  it("moves document listeners with the view and removes them on unload", () => {
    const { view, page, cleanups, migrate, stopMigration } = setup();
    registerDocumentPointerEndEvents(page, (cleanup) => cleanups.push(cleanup), (event) => view.onDocumentPointerEnd(event));
    const destination = frameDocument();
    destination.body.append(destination.adoptNode(page));
    migrate();

    endPointer(document.body);
    expect(view.activePointerId).toBe(7);
    endPointer(destination.body);
    expect(view.finishPointerInput).toHaveBeenCalledOnce();

    cleanups.splice(0).forEach((cleanup) => cleanup());
    view.activePointerId = 7;
    endPointer(document.body);
    endPointer(destination.body);
    expect(view.activePointerId).toBe(7);
    expect(view.finishPointerInput).toHaveBeenCalledOnce();
    expect(stopMigration).toHaveBeenCalledOnce();
  });

  it("does not finalize a page ending again when it bubbles to the document", () => {
    const { view, page, cleanups } = setup();
    page.addEventListener("pointerup", () => view.finishPointerInput(true));
    registerDocumentPointerEndEvents(page, (cleanup) => cleanups.push(cleanup), (event) => view.onDocumentPointerEnd(event));

    endPointer(page);
    expect(view.finishPointerInput).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("ignores document endings for another pointer", () => {
    const { view, page, cleanups } = setup();
    registerDocumentPointerEndEvents(page, (cleanup) => cleanups.push(cleanup), (event) => view.onDocumentPointerEnd(event));
    endPointer(document.body, "pointercancel", 8);
    expect(view.finishPointerInput).not.toHaveBeenCalled();
    expect(view.activePointerId).toBe(7);
  });
});

describe("pointer capture exceptions", () => {
  it.each(["capturePointer", "releasePointer"] as const)("tolerates expected cross-window DOMExceptions in %s", (method) => {
    const owner = frameDocument();
    const { view, page } = setup(owner);
    const otherWindow = owner.defaultView! as Window & typeof globalThis;
    page.hasPointerCapture = () => method === "releasePointer";
    for (const name of ["NotFoundError", "InvalidStateError"]) {
      const error = new otherWindow.DOMException("inactive pointer", name);
      expect(error instanceof DOMException).toBe(false);
      page.setPointerCapture = page.releasePointerCapture = () => { throw error; };
      expect(() => view[method](7)).not.toThrow();
    }
  });

  it.each(["capturePointer", "releasePointer"] as const)("propagates unexpected errors in %s", (method) => {
    const { view, page } = setup();
    page.hasPointerCapture = () => method === "releasePointer";
    const namedError = new Error("not a DOMException");
    namedError.name = "NotFoundError";
    for (const error of [new TypeError("broken capture"), namedError, new DOMException("unexpected", "SecurityError")]) {
      page.setPointerCapture = page.releasePointerCapture = () => { throw error; };
      expect(() => view[method](7)).toThrow(error);
    }
  });
});
