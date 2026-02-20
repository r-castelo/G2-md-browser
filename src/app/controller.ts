import { APP_TEXT, MENU_ITEMS, STORAGE_KEYS, TEXT_LAYOUT } from "../config/constants";
import { normalizeMarkdown } from "../domain/markdown";
import { paginate, wrapLines } from "../domain/paginate";
import { AppStateMachine } from "./state";
import type {
  GestureEvent,
  GlassAdapter,
  StorageAdapter,
  Unsubscribe,
} from "../types/contracts";

export interface ControllerOptions {
  glass: GlassAdapter;
  storage: StorageAdapter;
}

export class Controller {
  private readonly glass: GlassAdapter;
  private readonly storage: StorageAdapter;
  private readonly state = new AppStateMachine();

  private unsubscribeGesture: Unsubscribe | null = null;
  private gestureQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(options: ControllerOptions) {
    this.glass = options.glass;
    this.storage = options.storage;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.glass.connect();

    this.unsubscribeGesture = this.glass.onGesture((gesture) => {
      this.gestureQueue = this.gestureQueue
        .then(() => this.handleGesture(gesture))
        .catch((err: unknown) => {
          console.error("Gesture handling failed:", err);
        });
    });

    await this.bootstrapFolder();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeGesture?.();
    this.unsubscribeGesture = null;
  }

  /** Triggered from phone UI to re-pick a folder. */
  async changeFolderFromPhone(): Promise<void> {
    await this.promptAndLoadFolder();
  }

  /** Triggered from phone UI to open a file directly on glasses. */
  async openFileFromPhone(entry: { name: string; uri: string }): Promise<void> {
    await this.openFile(entry);
  }

  /** Get the current root folder URI (first in folder stack). */
  getRootFolderUri(): string | null {
    const stack = this.state.snapshot.folderStack;
    return stack.length > 0 ? (stack[0] ?? null) : null;
  }

  // --- Bootstrap ---

  private async bootstrapFolder(): Promise<void> {
    const persisted = await this.storage.loadFolderUri();
    if (!persisted) {
      await this.promptAndLoadFolder();
      return;
    }

    try {
      await this.loadFolder(persisted);
    } catch {
      await this.storage.persistFolderUri("");
      await this.promptAndLoadFolder();
    }
  }

  private async promptAndLoadFolder(): Promise<void> {
    this.state.setFolderPick();

    const folderUri = await this.storage.pickFolder();
    await this.storage.persistFolderUri(folderUri);
    await this.loadFolder(folderUri);
  }

  private async loadFolder(folderUri: string): Promise<void> {
    const entries = await this.storage.listFolderContents(folderUri);
    this.state.setBrowserEntries(entries, folderUri);

    if (entries.length === 0) {
      await this.glass.showMessage(APP_TEXT.emptyFolder);
      return;
    }

    await this.renderBrowser();
  }

  // --- Gesture dispatch ---

  private async handleGesture(gesture: GestureEvent): Promise<void> {
    const mode = this.state.mode;

    if (mode === "BROWSER") {
      await this.handleBrowser(gesture);
      return;
    }

    if (mode === "READER") {
      await this.handleReader(gesture);
      return;
    }

    if (mode === "MENU") {
      await this.handleMenu(gesture);
      return;
    }

    if (mode === "ERROR" && gesture.kind === "TAP") {
      await this.promptAndLoadFolder();
    }
  }

  // --- Browser mode ---

  private async handleBrowser(gesture: GestureEvent): Promise<void> {
    // Scroll events only fire at list boundaries (firmware handles scroll internally)
    if (gesture.kind === "SCROLL_FWD" || gesture.kind === "SCROLL_BACK") {
      // List scroll is handled by firmware — no action needed
      return;
    }

    if (gesture.kind === "TAP") {
      await this.handleBrowserTap(gesture.listIndex);
    }
  }

  private async handleBrowserTap(listIndex?: number): Promise<void> {
    // Use firmware-reported index if available, fall back to 0
    const idx = listIndex ?? 0;
    const selection = this.state.getEntryAtIndex(idx);
    if (!selection) return;

    if (selection.action === "back") {
      await this.navigateBack();
      return;
    }

    if (selection.action === "open_folder") {
      await this.enterFolder(selection.entry.uri);
      return;
    }

    // open_file
    await this.openFile(selection.entry);
  }

  private async enterFolder(folderUri: string): Promise<void> {
    this.state.pushFolder(folderUri);
    const entries = await this.storage.listFolderContents(folderUri);
    this.state.setBrowserEntries(entries, folderUri);
    await this.renderBrowser();
  }

  private async navigateBack(): Promise<void> {
    const parentUri = this.state.popFolder();
    if (!parentUri) return;

    const entries = await this.storage.listFolderContents(parentUri);
    this.state.setBrowserEntries(entries, parentUri);
    await this.renderBrowser();
  }

  private async renderBrowser(): Promise<void> {
    const items = this.state.getBrowserItems();
    const entries = this.state.snapshot.entries;
    const total = (this.state.isAtRoot() ? 0 : 1) + entries.length;

    let status: string;
    if (total === 0) {
      status = "Empty folder";
    } else if (this.state.isAtRoot()) {
      status = `${total} items`;
    } else {
      const path = this.state.getCurrentPath();
      status = path.length > 40 ? `...${path.slice(-37)}` : path;
    }

    await this.glass.showBrowser(items, status);
  }

  // --- Open file ---

  private async openFile(entry: { name: string; uri: string }): Promise<void> {
    try {
      const raw = await this.storage.readFile(entry.uri);
      const lines = normalizeMarkdown(raw);
      const wrapped = wrapLines(lines, TEXT_LAYOUT.CHARS_PER_LINE);
      const pages = paginate(wrapped, TEXT_LAYOUT.LINES_PER_PAGE);

      this.state.enterReader(entry.name, pages);
      await this.restoreReadingState(entry.name);
      await this.renderReaderFull();
    } catch (err: unknown) {
      console.error(`Failed to read file: ${entry.uri}`, err);
      this.state.backToBrowser();
      await this.renderBrowser();
    }
  }

  // --- Reader mode ---

  private async handleReader(gesture: GestureEvent): Promise<void> {
    if (gesture.kind === "SCROLL_FWD") {
      if (this.state.nextPage()) {
        await this.renderReaderUpdate();
        await this.persistReadingState();
      }
      return;
    }

    if (gesture.kind === "SCROLL_BACK") {
      if (this.state.prevPage()) {
        await this.renderReaderUpdate();
        await this.persistReadingState();
      }
      return;
    }

    if (gesture.kind === "TAP") {
      this.state.openMenu();
      await this.renderMenu();
    }
  }

  private async renderReaderFull(): Promise<void> {
    const view = this.state.getReaderView(TEXT_LAYOUT.LINES_PER_PAGE);
    const status = this.formatReaderStatus(view.currentPage, view.totalPages, view.fileName);
    await this.glass.showReader(view.pageText, status);
  }

  private async renderReaderUpdate(): Promise<void> {
    const view = this.state.getReaderView(TEXT_LAYOUT.LINES_PER_PAGE);
    const status = this.formatReaderStatus(view.currentPage, view.totalPages, view.fileName);
    await this.glass.updateReaderText(view.pageText, status);
  }

  private formatReaderStatus(
    page: number,
    total: number,
    fileName: string,
  ): string {
    const name =
      fileName.length > 20 ? `${fileName.slice(0, 17)}...` : fileName;
    const text = `${name}  ${page + 1}/${total}`;
    const STATUS_CHARS = 40;
    return text.length < STATUS_CHARS
      ? " ".repeat(STATUS_CHARS - text.length) + text
      : text;
  }

  // --- Menu mode ---

  private async handleMenu(gesture: GestureEvent): Promise<void> {
    // Firmware handles list scroll internally
    if (gesture.kind === "SCROLL_FWD" || gesture.kind === "SCROLL_BACK") {
      return;
    }

    if (gesture.kind === "TAP") {
      const idx = gesture.listIndex ?? 0;
      await this.handleMenuTap(idx);
    }
  }

  private async handleMenuTap(listIndex: number): Promise<void> {
    const menuItem = MENU_ITEMS[listIndex];

    if (menuItem === "Back to files") {
      this.state.backToBrowser();
      await this.renderBrowser();
      return;
    }

    if (menuItem === "Top of file") {
      this.state.resetToTop();
      this.state.closeMenu();
      await this.renderReaderFull();
      return;
    }

    // Close menu (default)
    this.state.closeMenu();
    await this.renderReaderFull();
  }

  private async renderMenu(): Promise<void> {
    const items = this.state.getMenuItems();
    await this.glass.showMenu(items, "Swipe: move  Tap: select");
  }

  // --- Reading state persistence ---

  private async persistReadingState(): Promise<void> {
    try {
      const snap = this.state.snapshot;
      const data = JSON.stringify({
        fileName: snap.fileName,
        currentPage: snap.currentPage,
      });
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEYS.readingState, data);
      }
    } catch {
      // Best effort
    }
  }

  private async restoreReadingState(fileName: string): Promise<void> {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      const raw = window.localStorage.getItem(STORAGE_KEYS.readingState);
      if (!raw) return;

      const data = JSON.parse(raw) as {
        fileName?: string;
        currentPage?: number;
      };
      if (
        data.fileName === fileName &&
        typeof data.currentPage === "number"
      ) {
        this.state.goToPage(data.currentPage);
      }
    } catch {
      // Best effort
    }
  }
}
