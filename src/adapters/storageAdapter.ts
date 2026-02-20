import { STORAGE_KEYS } from "../config/constants";
import type { BrowserEntry, FileEntry, StorageAdapter } from "../types/contracts";

interface NativeFileDescriptor {
  id?: string;
  name: string;
  uri: string;
  sizeBytes?: number;
  isDirectory?: boolean;
}

interface NativeStorageBridge {
  pickFolder?: () => Promise<string> | string;
  listMarkdownFiles?: (
    treeUri: string,
  ) => Promise<NativeFileDescriptor[]> | NativeFileDescriptor[];
  listFolderContents?: (
    treeUri: string,
  ) => Promise<NativeFileDescriptor[]> | NativeFileDescriptor[];
  readFile?: (uri: string) => Promise<string> | string;
}

interface BrowserFileRecord {
  relPath: string;
  entry: FileEntry;
  file: File;
}

function detectNativeBridge(
  windowRef?: Window,
): NativeStorageBridge | undefined {
  const candidates: unknown[] = [
    windowRef?.evenAndroidStorage,
    windowRef?.evenStorageBridge,
    windowRef?.AndroidMarkdownFs,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate as NativeStorageBridge;
    }
  }

  return undefined;
}

export class StorageAdapterImpl implements StorageAdapter {
  private readonly windowRef: Window | undefined;
  private readonly nativeBridge: NativeStorageBridge | undefined;

  /** All .md files from the picked folder, keyed by root folder URI. */
  private readonly allBrowserFiles = new Map<string, BrowserFileRecord[]>();

  constructor(windowRef?: Window) {
    this.windowRef =
      windowRef ?? (typeof window !== "undefined" ? window : undefined);
    this.nativeBridge = detectNativeBridge(this.windowRef);
  }

  async pickFolder(): Promise<string> {
    if (this.nativeBridge?.pickFolder) {
      const treeUri = await this.nativeBridge.pickFolder();
      if (!treeUri) {
        throw new Error("Folder selection was cancelled.");
      }
      return treeUri;
    }

    return this.pickFolderViaInput();
  }

  async listMarkdownFiles(folderUri: string): Promise<FileEntry[]> {
    if (this.nativeBridge?.listMarkdownFiles) {
      const nativeFiles = await this.nativeBridge.listMarkdownFiles(folderUri);
      return this.normalizeNativeFiles(nativeFiles);
    }

    // Browser fallback: return direct .md children of this folder
    const contents = await this.listFolderContents(folderUri);
    return contents
      .filter((e) => e.kind === "file")
      .map((e): FileEntry => ({
        id: e.uri,
        name: e.name,
        uri: e.uri,
        sizeBytes: e.sizeBytes,
      }));
  }

  async listFolderContents(folderUri: string): Promise<BrowserEntry[]> {
    if (this.nativeBridge?.listFolderContents) {
      const items = await this.nativeBridge.listFolderContents(folderUri);
      return this.normalizeNativeBrowserEntries(items);
    }

    if (this.nativeBridge?.listMarkdownFiles) {
      // Native bridge without folder support — flat file list only
      const nativeFiles = await this.nativeBridge.listMarkdownFiles(folderUri);
      return this.normalizeNativeFiles(nativeFiles).map(
        (f): BrowserEntry => ({
          kind: "file",
          name: f.name,
          uri: f.uri,
          sizeBytes: f.sizeBytes,
        }),
      );
    }

    return this.listBrowserFolderContents(folderUri);
  }

  async getAllFiles(rootFolderUri: string): Promise<BrowserEntry[]> {
    if (this.nativeBridge?.listMarkdownFiles) {
      const nativeFiles = await this.nativeBridge.listMarkdownFiles(rootFolderUri);
      return this.normalizeNativeFiles(nativeFiles).map(
        (f): BrowserEntry => ({
          kind: "file",
          name: f.name,
          uri: f.uri,
          sizeBytes: f.sizeBytes,
        }),
      );
    }

    const { rootUri } = this.parsefolderUri(rootFolderUri);
    const records = this.allBrowserFiles.get(rootUri);
    if (!records) return [];

    return records.map(
      (r): BrowserEntry => ({
        kind: "file",
        name: r.entry.name,
        uri: r.entry.uri,
        sizeBytes: r.entry.sizeBytes,
      }),
    );
  }

  async readFile(uri: string): Promise<string> {
    if (this.nativeBridge?.readFile) {
      return this.nativeBridge.readFile(uri);
    }

    for (const records of this.allBrowserFiles.values()) {
      const match = records.find((r) => r.entry.uri === uri);
      if (match) {
        return match.file.text();
      }
    }

    throw new Error(`File not found: ${uri}`);
  }

  async persistFolderUri(uri: string): Promise<void> {
    if (!this.windowRef?.localStorage) {
      return;
    }

    if (!uri) {
      this.windowRef.localStorage.removeItem(STORAGE_KEYS.folderUri);
      return;
    }

    this.windowRef.localStorage.setItem(STORAGE_KEYS.folderUri, uri);
  }

  async loadFolderUri(): Promise<string | null> {
    if (!this.windowRef?.localStorage) {
      return null;
    }

    const value = this.windowRef.localStorage.getItem(STORAGE_KEYS.folderUri);
    if (!value || value.trim().length === 0) {
      return null;
    }

    return value;
  }

  // --- Private: browser fallback ---

  private async pickFolderViaInput(): Promise<string> {
    if (!this.windowRef?.document) {
      throw new Error("Browser APIs are unavailable.");
    }

    const files = await this.promptForFiles(this.windowRef.document);
    if (files.length === 0) {
      throw new Error("No files were selected.");
    }

    return this.cacheBrowserFiles(files);
  }

  private promptForFiles(doc: Document): Promise<File[]> {
    return new Promise((resolve, reject) => {
      const input = doc.createElement("input");
      input.type = "file";
      input.accept = ".md,text/markdown";
      input.multiple = true;
      input.webkitdirectory = true;
      input.style.display = "none";

      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "Select markdown folder";
      button.style.cssText = [
        "position:fixed",
        "left:24px",
        "right:24px",
        "bottom:48px",
        "padding:16px",
        "border:none",
        "border-radius:12px",
        "background:#34c759",
        "color:#000",
        "font:600 16px -apple-system, sans-serif",
        "z-index:9999",
        "cursor:pointer",
        "-webkit-tap-highlight-color:transparent",
      ].join(";");

      let settled = false;

      const cleanup = () => {
        input.onchange = null;
        input.onerror = null;
        button.onclick = null;
        input.remove();
        button.remove();
      };

      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      };

      input.onchange = () => {
        const selected = input.files ? Array.from(input.files) : [];
        if (selected.length === 0 || settled) return;
        settled = true;
        cleanup();
        resolve(selected);
      };

      input.onerror = () => fail("Failed to open folder picker.");

      button.onclick = () => {
        try {
          input.click();
        } catch {
          fail("Failed to open folder picker.");
        }
      };

      doc.body.appendChild(input);
      doc.body.appendChild(button);

      // Try auto-opening; some WebViews block this until user tap
      try {
        input.click();
      } catch {
        // User can tap the button
      }
    });
  }

  /**
   * Cache ALL .md files from the picked folder (not just direct children).
   * Returns the root folder URI.
   */
  private cacheBrowserFiles(files: File[]): string {
    const mdFiles = files.filter((f) =>
      f.name.toLowerCase().endsWith(".md"),
    );

    const rootSegment = this.extractRootSegment(mdFiles[0]);
    const folderUri = `webfolder://${encodeURIComponent(rootSegment)}-${Date.now()}`;

    const records = mdFiles.map((f, i): BrowserFileRecord => {
      const relPath = this.relativePath(f, rootSegment);
      const uri = `${folderUri}#${encodeURIComponent(relPath)}-${i}`;
      return {
        relPath,
        entry: {
          id: uri,
          name: f.name,
          uri,
          sizeBytes: f.size,
        },
        file: f,
      };
    });

    this.allBrowserFiles.set(folderUri, records);
    return folderUri;
  }

  /**
   * List contents of a browser-backed folder.
   * folderUri is either the root URI or "rootUri/subpath".
   */
  private listBrowserFolderContents(folderUri: string): BrowserEntry[] {
    // Parse: "webfolder://root-123" or "webfolder://root-123/sub/path"
    const { rootUri, subPath } = this.parsefolderUri(folderUri);

    const allRecords = this.allBrowserFiles.get(rootUri);
    if (!allRecords) {
      throw new Error(
        "Folder access is no longer valid. Please select the folder again.",
      );
    }

    const folders = new Set<string>();
    const files: BrowserEntry[] = [];

    for (const record of allRecords) {
      // Get the relative path within the current subfolder
      const relFromCurrent = subPath
        ? (record.relPath.startsWith(subPath + "/")
          ? record.relPath.slice(subPath.length + 1)
          : null)
        : record.relPath;

      if (relFromCurrent === null) continue;

      const slashIdx = relFromCurrent.indexOf("/");
      if (slashIdx === -1) {
        // Direct child file
        files.push({
          kind: "file",
          name: relFromCurrent,
          uri: record.entry.uri,
          sizeBytes: record.entry.sizeBytes,
        });
      } else {
        // File is deeper — extract the immediate subfolder name
        const subfolderName = relFromCurrent.slice(0, slashIdx);
        folders.add(subfolderName);
      }
    }

    // Build folder entries
    const folderEntries: BrowserEntry[] = [...folders]
      .sort((a, b) => a.localeCompare(b))
      .map((name): BrowserEntry => ({
        kind: "folder",
        name,
        uri: subPath ? `${rootUri}/${subPath}/${name}` : `${rootUri}/${name}`,
        sizeBytes: 0,
      }));

    // Sort files
    files.sort((a, b) => a.name.localeCompare(b.name));

    // Folders first, then files
    return [...folderEntries, ...files];
  }

  /**
   * Parse a folder URI into root URI and optional sub-path.
   * "webfolder://x-123" → { rootUri: "webfolder://x-123", subPath: "" }
   * "webfolder://x-123/sub/path" → { rootUri: "webfolder://x-123", subPath: "sub/path" }
   */
  private parsefolderUri(folderUri: string): {
    rootUri: string;
    subPath: string;
  } {
    // Find the root URI among our cached folders
    for (const rootUri of this.allBrowserFiles.keys()) {
      if (folderUri === rootUri) {
        return { rootUri, subPath: "" };
      }
      if (folderUri.startsWith(rootUri + "/")) {
        return { rootUri, subPath: folderUri.slice(rootUri.length + 1) };
      }
    }

    // Might be a native URI — return as-is
    return { rootUri: folderUri, subPath: "" };
  }

  private extractRootSegment(file: File | undefined): string {
    if (!file) return "markdown";
    const path = this.webkitRelativePath(file);
    if (!path) return "markdown";
    const [root] = path.split("/");
    return root || "markdown";
  }

  private relativePath(file: File, root: string): string {
    const path = this.webkitRelativePath(file);
    if (!path) return file.name;
    const prefix = `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : file.name;
  }

  private webkitRelativePath(file: File): string {
    return (file as File & { webkitRelativePath?: string })
      .webkitRelativePath ?? "";
  }

  private normalizeNativeFiles(files: NativeFileDescriptor[]): FileEntry[] {
    return files
      .filter((f) => f.name.toLowerCase().endsWith(".md"))
      .map(
        (f): FileEntry => ({
          id: f.id ?? f.uri,
          name: f.name,
          uri: f.uri,
          sizeBytes: f.sizeBytes ?? 0,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private normalizeNativeBrowserEntries(
    items: NativeFileDescriptor[],
  ): BrowserEntry[] {
    const folders: BrowserEntry[] = [];
    const files: BrowserEntry[] = [];

    for (const item of items) {
      if (item.isDirectory) {
        folders.push({
          kind: "folder",
          name: item.name,
          uri: item.uri,
          sizeBytes: 0,
        });
      } else if (item.name.toLowerCase().endsWith(".md")) {
        files.push({
          kind: "file",
          name: item.name,
          uri: item.uri,
          sizeBytes: item.sizeBytes ?? 0,
        });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...files];
  }
}
