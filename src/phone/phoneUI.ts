import { STORAGE_KEYS } from "../config/constants";
import { GDRIVE_PREFIX } from "../config/gdriveConfig";
import type { BrowserEntry, StorageAdapter } from "../types/contracts";

export interface PhoneUIOptions {
  storage: StorageAdapter;
  onFileSelect: (entry: BrowserEntry) => void;
  onFolderChange: () => Promise<void>;
  onGDriveSelect?: () => Promise<void>;
  isGDriveAuthenticated?: () => boolean;
  onGDriveSignOut?: () => void;
}

type ActiveTab = "files" | "favorites";

export class PhoneUI {
  private readonly storage: StorageAdapter;
  private readonly onFileSelect: (entry: BrowserEntry) => void;
  private readonly onFolderChange: () => Promise<void>;
  private readonly onGDriveSelect: (() => Promise<void>) | null;
  private readonly isGDriveAuthenticated: (() => boolean) | null;
  private readonly onGDriveSignOut: (() => void) | null;

  private rootUri = "";
  private currentUri = "";
  private folderStack: string[] = [];
  private folderNames = new Map<string, string>();
  private favorites = new Set<string>();
  private allFilesCache: BrowserEntry[] | null = null;
  private searchQuery = "";
  private activeTab: ActiveTab = "files";

  // DOM elements
  private readonly fileListEl: HTMLElement;
  private readonly breadcrumbsEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly browserEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly tabFilesBtn: HTMLElement;
  private readonly tabFavoritesBtn: HTMLElement;
  private readonly confirmDialog: HTMLElement;
  private readonly confirmFilename: HTMLElement;
  private readonly confirmYes: HTMLElement;
  private readonly confirmNo: HTMLElement;

  private pendingFileEntry: BrowserEntry | null = null;

  constructor(options: PhoneUIOptions) {
    this.storage = options.storage;
    this.onFileSelect = options.onFileSelect;
    this.onFolderChange = options.onFolderChange;
    this.onGDriveSelect = options.onGDriveSelect ?? null;
    this.isGDriveAuthenticated = options.isGDriveAuthenticated ?? null;
    this.onGDriveSignOut = options.onGDriveSignOut ?? null;

    this.fileListEl = document.getElementById("file-list")!;
    this.breadcrumbsEl = document.getElementById("breadcrumbs")!;
    this.searchInput = document.getElementById("search-input") as HTMLInputElement;
    this.browserEl = document.getElementById("phone-browser")!;
    this.statusEl = document.getElementById("status-screen")!;
    this.tabFilesBtn = document.getElementById("tab-files")!;
    this.tabFavoritesBtn = document.getElementById("tab-favorites")!;
    this.confirmDialog = document.getElementById("confirm-dialog")!;
    this.confirmFilename = document.getElementById("confirm-filename")!;
    this.confirmYes = document.getElementById("confirm-yes")!;
    this.confirmNo = document.getElementById("confirm-no")!;

    this.loadFavorites();
    this.bindEvents();
  }

  async showFolder(rootUri: string): Promise<void> {
    this.rootUri = rootUri;
    this.currentUri = rootUri;
    this.folderStack = [rootUri];
    this.allFilesCache = null;
    this.searchQuery = "";
    this.searchInput.value = "";
    this.activeTab = "files";

    this.statusEl.classList.add("hidden");
    this.browserEl.classList.remove("hidden");

    this.updateTabs();
    this.updateGDriveStatus();
    await this.renderCurrentView();
  }

  // --- Event binding ---

  private bindEvents(): void {
    // Search
    let debounce: ReturnType<typeof setTimeout> | null = null;
    this.searchInput.addEventListener("input", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.searchQuery = this.searchInput.value.trim();
        void this.renderCurrentView();
      }, 200);
    });

    // Tab buttons
    this.tabFilesBtn.addEventListener("click", () => {
      if (this.activeTab === "files") return;
      this.activeTab = "files";
      this.updateTabs();
      void this.renderCurrentView();
    });

    this.tabFavoritesBtn.addEventListener("click", () => {
      if (this.activeTab === "favorites") return;
      this.activeTab = "favorites";
      this.updateTabs();
      void this.renderCurrentView();
    });

    // Change folder
    const changeFolderBtn = document.getElementById("btn-change-folder");
    if (changeFolderBtn) {
      changeFolderBtn.addEventListener("click", () => {
        void this.handleFolderChange();
      });
    }

    // Source picker dialog
    this.bindSourcePicker();

    // Google Drive sign out
    const gdriveSignoutBtn = document.getElementById("btn-gdrive-signout");
    if (gdriveSignoutBtn) {
      gdriveSignoutBtn.addEventListener("click", () => {
        this.onGDriveSignOut?.();
        // Clear persisted folder and show source picker
        localStorage.removeItem(STORAGE_KEYS.folderUri);
        localStorage.removeItem(STORAGE_KEYS.storageSource);
        this.updateGDriveStatus();
        void this.handleFolderChange();
      });
    }

    // Confirm dialog
    this.confirmYes.addEventListener("click", () => {
      this.confirmDialog.classList.add("hidden");
      if (this.pendingFileEntry) {
        this.onFileSelect(this.pendingFileEntry);
        this.pendingFileEntry = null;
      }
    });

    this.confirmNo.addEventListener("click", () => {
      this.confirmDialog.classList.add("hidden");
      this.pendingFileEntry = null;
    });

    // Dismiss on overlay tap (outside the sheet)
    this.confirmDialog.addEventListener("click", (e) => {
      if (e.target === this.confirmDialog) {
        this.confirmDialog.classList.add("hidden");
        this.pendingFileEntry = null;
      }
    });
  }

  private async handleFolderChange(): Promise<void> {
    // If Google Drive is available, show source picker
    if (this.onGDriveSelect) {
      this.showSourcePicker();
      return;
    }

    // No Google Drive option — go straight to local folder picker
    await this.pickLocalFolder();
  }

  private async pickLocalFolder(): Promise<void> {
    this.browserEl.classList.add("hidden");
    this.statusEl.classList.remove("hidden");
    setPhoneState("connecting", "Selecting folder...");

    try {
      await this.onFolderChange();
    } catch (err: unknown) {
      setPhoneState("error", "Failed to change folder", String(err));
    }
  }

  private showSourcePicker(): void {
    const picker = document.getElementById("source-picker");
    if (picker) {
      picker.classList.remove("hidden");
    }
  }

  private hideSourcePicker(): void {
    const picker = document.getElementById("source-picker");
    if (picker) {
      picker.classList.add("hidden");
    }
  }

  private bindSourcePicker(): void {
    const picker = document.getElementById("source-picker");
    const localBtn = document.getElementById("source-local");
    const gdriveBtn = document.getElementById("source-gdrive");
    const cancelBtn = document.getElementById("source-cancel");

    if (localBtn) {
      localBtn.addEventListener("click", () => {
        this.hideSourcePicker();
        void this.pickLocalFolder();
      });
    }

    if (gdriveBtn) {
      gdriveBtn.addEventListener("click", () => {
        this.hideSourcePicker();
        if (this.onGDriveSelect) {
          this.browserEl.classList.add("hidden");
          this.statusEl.classList.remove("hidden");
          setPhoneState("connecting", "Connecting to Google Drive...");
          void this.onGDriveSelect().catch((err: unknown) => {
            setPhoneState("error", "Google Drive failed", String(err));
          });
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        this.hideSourcePicker();
      });
    }

    // Dismiss on overlay tap
    if (picker) {
      picker.addEventListener("click", (e) => {
        if (e.target === picker) {
          this.hideSourcePicker();
        }
      });
    }
  }

  private updateGDriveStatus(): void {
    const statusEl = document.getElementById("gdrive-status");
    if (!statusEl) return;

    const isGDrive = this.rootUri.startsWith(GDRIVE_PREFIX);
    statusEl.classList.toggle("hidden", !isGDrive);
  }

  // --- Folder navigation ---

  private async navigateTo(folderUri: string, folderName?: string): Promise<void> {
    this.folderStack.push(folderUri);
    if (folderName) {
      this.folderNames.set(folderUri, folderName);
    }
    this.currentUri = folderUri;
    this.searchQuery = "";
    this.searchInput.value = "";
    await this.renderCurrentView();
  }

  private async navigateUp(targetUri: string): Promise<void> {
    const idx = this.folderStack.indexOf(targetUri);
    if (idx >= 0) {
      this.folderStack = this.folderStack.slice(0, idx + 1);
      this.currentUri = targetUri;
    }
    this.searchQuery = "";
    this.searchInput.value = "";
    await this.renderCurrentView();
  }

  // --- UI state ---

  private updateTabs(): void {
    this.tabFilesBtn.classList.toggle("active", this.activeTab === "files");
    this.tabFavoritesBtn.classList.toggle("active", this.activeTab === "favorites");
  }

  private showConfirm(entry: BrowserEntry): void {
    this.pendingFileEntry = entry;
    this.confirmFilename.textContent = entry.name;
    this.confirmDialog.classList.remove("hidden");
  }

  // --- Rendering ---

  private async renderCurrentView(): Promise<void> {
    if (this.activeTab === "favorites") {
      await this.renderFavorites();
      return;
    }

    if (this.searchQuery.length > 0) {
      await this.renderSearchResults();
      return;
    }

    await this.renderCurrentFolder();
  }

  private async renderCurrentFolder(): Promise<void> {
    const entries = await this.storage.listFolderContents(this.currentUri);
    this.renderBreadcrumbs();

    this.fileListEl.innerHTML = "";

    // Prepend ".." parent folder entry when not at root
    if (this.folderStack.length > 1) {
      const parentItem = this.createParentItem();
      this.fileListEl.appendChild(parentItem);
    }

    if (entries.length === 0 && this.folderStack.length <= 1) {
      const empty = document.createElement("div");
      empty.className = "file-list-empty";
      empty.textContent = "No items in this folder";
      this.fileListEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const item = this.createFileItem(entry, false);
      this.fileListEl.appendChild(item);
    }
  }

  private async renderSearchResults(): Promise<void> {
    if (!this.allFilesCache) {
      this.allFilesCache = await this.storage.getAllFiles(this.rootUri);
    }

    const q = this.searchQuery.toLowerCase();
    const matches = this.allFilesCache.filter((f) =>
      f.name.toLowerCase().includes(q),
    );

    this.renderBreadcrumbs();
    this.renderEntries(matches, true);
  }

  private async renderFavorites(): Promise<void> {
    if (!this.allFilesCache) {
      this.allFilesCache = await this.storage.getAllFiles(this.rootUri);
    }

    const q = this.searchQuery.toLowerCase();
    let favFiles = this.allFilesCache.filter((f) => this.favorites.has(f.uri));

    if (q.length > 0) {
      favFiles = favFiles.filter((f) => f.name.toLowerCase().includes(q));
    }

    this.breadcrumbsEl.innerHTML = "";
    this.renderEntries(favFiles, true, favFiles.length === 0 ? "No favorites yet" : undefined);
  }

  private renderBreadcrumbs(): void {
    this.breadcrumbsEl.innerHTML = "";

    if (this.searchQuery.length > 0 && this.activeTab === "files") {
      const span = document.createElement("span");
      span.className = "crumb current";
      span.textContent = `Search: "${this.searchQuery}"`;
      this.breadcrumbsEl.appendChild(span);
      return;
    }

    if (this.activeTab === "favorites") return;

    for (let i = 0; i < this.folderStack.length; i++) {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = " / ";
        this.breadcrumbsEl.appendChild(sep);
      }

      const crumb = document.createElement("span");
      const isLast = i === this.folderStack.length - 1;
      crumb.className = isLast ? "crumb current" : "crumb";
      crumb.textContent = i === 0
        ? (this.rootUri.startsWith(GDRIVE_PREFIX) ? "Google Drive" : "root")
        : this.extractFolderName(this.folderStack[i]!, this.folderStack[i - 1]!);

      if (!isLast) {
        const targetUri = this.folderStack[i]!;
        crumb.addEventListener("click", () => {
          void this.navigateUp(targetUri);
        });
      }

      this.breadcrumbsEl.appendChild(crumb);
    }
  }

  private renderEntries(entries: BrowserEntry[], showPath: boolean, emptyText?: string): void {
    this.fileListEl.innerHTML = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "file-list-empty";
      empty.textContent = emptyText ?? (showPath ? "No files match your search" : "No items in this folder");
      this.fileListEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const item = this.createFileItem(entry, showPath);
      this.fileListEl.appendChild(item);
    }
  }

  private createFileItem(entry: BrowserEntry, showPath: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "file-item";

    // Icon
    const icon = document.createElement("div");
    icon.className = `file-item-icon ${entry.kind}`;
    icon.textContent = entry.kind === "folder" ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
    row.appendChild(icon);

    // Info
    const info = document.createElement("div");
    info.className = "file-item-info";

    const name = document.createElement("div");
    name.className = "file-item-name";
    name.textContent = entry.kind === "folder" ? `${entry.name}/` : entry.name;
    info.appendChild(name);

    if (showPath && entry.kind === "file") {
      const path = document.createElement("div");
      path.className = "file-item-path";
      path.textContent = this.extractRelPath(entry.uri);
      info.appendChild(path);
    }

    row.appendChild(info);

    // Star button (files only)
    if (entry.kind === "file") {
      const star = document.createElement("button");
      star.className = `file-item-star ${this.favorites.has(entry.uri) ? "active" : ""}`;
      star.textContent = this.favorites.has(entry.uri) ? "\u2605" : "\u2606";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFavorite(entry.uri);
        star.className = `file-item-star ${this.favorites.has(entry.uri) ? "active" : ""}`;
        star.textContent = this.favorites.has(entry.uri) ? "\u2605" : "\u2606";
      });
      row.appendChild(star);
    }

    // Tap handler
    row.addEventListener("click", () => {
      if (entry.kind === "folder") {
        void this.navigateTo(entry.uri, entry.name);
      } else {
        this.showConfirm(entry);
      }
    });

    return row;
  }

  private createParentItem(): HTMLElement {
    const row = document.createElement("div");
    row.className = "file-item file-item-parent";

    const icon = document.createElement("div");
    icon.className = "file-item-icon folder";
    icon.textContent = "..";
    row.appendChild(icon);

    const info = document.createElement("div");
    info.className = "file-item-info";
    const name = document.createElement("div");
    name.className = "file-item-name";
    name.textContent = "..";
    info.appendChild(name);
    row.appendChild(info);

    row.addEventListener("click", () => {
      this.folderStack.pop();
      this.currentUri = this.folderStack[this.folderStack.length - 1]!;
      this.searchQuery = "";
      this.searchInput.value = "";
      void this.renderCurrentView();
    });

    return row;
  }

  // --- Favorites ---

  private toggleFavorite(uri: string): void {
    if (this.favorites.has(uri)) {
      this.favorites.delete(uri);
    } else {
      this.favorites.add(uri);
    }
    this.saveFavorites();

    // Re-render favorites tab if active (file may have been removed)
    if (this.activeTab === "favorites") {
      void this.renderCurrentView();
    }
  }

  private loadFavorites(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.favorites);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        this.favorites = new Set(arr);
      }
    } catch {
      // ignore
    }
  }

  private saveFavorites(): void {
    try {
      localStorage.setItem(
        STORAGE_KEYS.favorites,
        JSON.stringify([...this.favorites]),
      );
    } catch {
      // ignore
    }
  }

  // --- Helpers ---

  private extractFolderName(uri: string, parentUri: string): string {
    // Check stored folder names first (used for Google Drive)
    const storedName = this.folderNames.get(uri);
    if (storedName) return storedName;

    if (uri.startsWith(parentUri + "/")) {
      const remainder = uri.slice(parentUri.length + 1);
      const slashIdx = remainder.indexOf("/");
      return slashIdx === -1 ? remainder : remainder.slice(0, slashIdx);
    }
    const parts = uri.split("/");
    return parts[parts.length - 1] ?? uri;
  }

  private extractRelPath(uri: string): string {
    // Google Drive URIs only have a file ID — no path to extract
    if (uri.startsWith(GDRIVE_PREFIX)) {
      return "Google Drive";
    }

    const hashIdx = uri.indexOf("#");
    if (hashIdx !== -1) {
      const fragment = uri.slice(hashIdx + 1);
      try {
        return decodeURIComponent(fragment).replace(/-\d+$/, "");
      } catch {
        return fragment;
      }
    }
    const parts = uri.split("/");
    return parts.length >= 2 ? parts.slice(-2).join("/") : uri;
  }
}

// --- Helper shared with main.ts ---

type PhoneState = "connecting" | "connected" | "error";

export function setPhoneState(state: PhoneState, text: string, detail?: string): void {
  const dot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const statusDetail = document.getElementById("status-detail");

  if (dot) {
    dot.className = `status-indicator ${state}`;
  }
  if (statusText) {
    statusText.textContent = text;
  }
  if (statusDetail) {
    statusDetail.textContent = detail ?? "";
  }
}
