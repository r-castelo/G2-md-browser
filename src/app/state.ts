import { BROWSER_TEXT, MENU_ITEMS } from "../config/constants";
import type { AppMode, BrowserEntry, ReaderView } from "../types/contracts";

export type MenuAction = "BACK_TO_FILES" | "TOP_OF_FILE" | "CHANGE_FOLDER" | "CLOSE_MENU" | "NONE";

/** What the user selected in the browser list. */
export type BrowserSelection =
  | { action: "back" }
  | { action: "open_folder"; entry: BrowserEntry }
  | { action: "open_file"; entry: BrowserEntry }
  | null;

export interface AppState {
  mode: AppMode;
  entries: BrowserEntry[];
  folderStack: string[];
  fileName: string;
  pages: string[][];
  currentPage: number;
  menuItems: readonly string[];
  errorMessage: string | null;
}

export class AppStateMachine {
  private state: AppState;

  constructor() {
    this.state = {
      mode: "BOOT",
      entries: [],
      folderStack: [],
      fileName: "",
      pages: [[""]],
      currentPage: 0,
      menuItems: MENU_ITEMS,
      errorMessage: null,
    };
  }

  get mode(): AppMode {
    return this.state.mode;
  }

  get snapshot(): Readonly<AppState> {
    return this.state;
  }

  // --- Mode transitions ---

  setFolderPick(): void {
    this.state.mode = "FOLDER_PICK";
    this.state.folderStack = [];
    this.state.errorMessage = null;
  }

  setBrowserEntries(entries: BrowserEntry[], folderUri: string): void {
    this.state.mode = "BROWSER";
    this.state.entries = [...entries];
    this.state.errorMessage = null;

    // Initialize folder stack if empty (root folder)
    if (this.state.folderStack.length === 0) {
      this.state.folderStack = [folderUri];
    }
  }

  setError(message: string): void {
    this.state.mode = "ERROR";
    this.state.errorMessage = message;
  }

  // --- Folder navigation ---

  pushFolder(folderUri: string): void {
    this.state.folderStack.push(folderUri);
  }

  popFolder(): string | null {
    if (this.state.folderStack.length <= 1) return null;
    this.state.folderStack.pop();
    return this.state.folderStack[this.state.folderStack.length - 1] ?? null;
  }

  isAtRoot(): boolean {
    return this.state.folderStack.length <= 1;
  }

  /** Get a display-friendly path showing the current subfolder relative to root. */
  getCurrentPath(): string {
    if (this.state.folderStack.length <= 1) return "/";

    const root = this.state.folderStack[0] ?? "";
    const current = this.state.folderStack[this.state.folderStack.length - 1] ?? "";

    // For webfolder:// URIs: "webfolder://root-123/sub/path" → "sub/path"
    if (current.startsWith(root + "/")) {
      return "/" + current.slice(root.length + 1);
    }

    // For native URIs, try to extract the last path segments
    const parts = current.split("/");
    const rootParts = root.split("/");
    if (parts.length > rootParts.length) {
      return "/" + parts.slice(rootParts.length).join("/");
    }

    return "/";
  }

  // --- Browser ---

  /** Whether the ".." back item is shown (not at root). */
  private get hasBackItem(): boolean {
    return !this.isAtRoot();
  }

  /**
   * Get the browser entry at a given display index.
   * Index 0 = ".." if not at root, otherwise the first entry.
   * The firmware reports this index via listEvent.currentSelectItemIndex.
   */
  getEntryAtIndex(displayIndex: number): BrowserSelection {
    if (this.hasBackItem && displayIndex === 0) {
      return { action: "back" };
    }

    const entryIdx = this.hasBackItem ? displayIndex - 1 : displayIndex;
    const entry = this.state.entries[entryIdx];
    if (!entry) return null;

    if (entry.kind === "folder") {
      return { action: "open_folder", entry };
    }

    return { action: "open_file", entry };
  }

  /**
   * Build the list of display strings for the glasses list container.
   * Firmware handles selection highlighting — no ">" marker needed.
   */
  getBrowserItems(): string[] {
    const items: string[] = [];

    if (this.hasBackItem) {
      items.push(BROWSER_TEXT.parentFolder);
    }

    if (this.state.entries.length === 0 && !this.hasBackItem) {
      return ["No items found"];
    }

    for (const entry of this.state.entries) {
      if (entry.kind === "folder") {
        const display = entry.name + BROWSER_TEXT.folderSuffix;
        const name = display.length > 48
          ? `${display.slice(0, 45)}...`
          : display;
        items.push(name);
      } else {
        const name = entry.name.length > 48
          ? `${entry.name.slice(0, 45)}...`
          : entry.name;
        items.push(name);
      }
    }

    return items;
  }

  // --- Reader ---

  enterReader(fileName: string, pages: string[][]): void {
    this.state.mode = "READER";
    this.state.fileName = fileName;
    this.state.pages = pages;
    this.state.currentPage = 0;
    this.state.errorMessage = null;
  }

  nextPage(): boolean {
    if (this.state.currentPage >= this.state.pages.length - 1) {
      return false;
    }
    this.state.currentPage++;
    return true;
  }

  prevPage(): boolean {
    if (this.state.currentPage <= 0) {
      return false;
    }
    this.state.currentPage--;
    return true;
  }

  goToPage(page: number): void {
    this.state.currentPage = Math.max(
      0,
      Math.min(page, this.state.pages.length - 1),
    );
  }

  resetToTop(): void {
    this.state.currentPage = 0;
  }

  getReaderView(linesPerPage: number): ReaderView {
    const page = this.state.pages[this.state.currentPage] ?? [""];
    const padded = [...page];
    while (padded.length < linesPerPage) {
      padded.push("");
    }

    return {
      currentPage: this.state.currentPage,
      totalPages: this.state.pages.length,
      pageText: padded.join("\n"),
      fileName: this.state.fileName,
    };
  }

  // --- Menu ---

  openMenu(): void {
    if (this.state.mode !== "READER") return;
    this.state.mode = "MENU";
  }

  closeMenu(): void {
    if (this.state.mode !== "MENU") return;
    this.state.mode = "READER";
  }

  /**
   * Build menu display items. Firmware handles selection highlighting.
   */
  getMenuItems(): string[] {
    return [...this.state.menuItems];
  }

  backToBrowser(): void {
    this.state.mode = "BROWSER";
  }
}
