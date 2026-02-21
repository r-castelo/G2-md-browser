import { STORAGE_KEYS } from "../config/constants";
import { GDRIVE_PREFIX } from "../config/gdriveConfig";
import type { GoogleDriveService } from "../services/googleDriveService";
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

const FSAPI_PREFIX = "fsapi://";
const HANDLE_DB_NAME = "g2_md_browser_handles";
const HANDLE_STORE = "dir_handles";
const HANDLE_KEY = "root";

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

/**
 * Check if the File System Access API (showDirectoryPicker) is available.
 */
function hasFSAPI(): boolean {
  return typeof showDirectoryPicker === "function";
}

// --- IndexedDB helpers for persisting FileSystemDirectoryHandle ---

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => {
        db.close();
        const handle = req.result as FileSystemDirectoryHandle | undefined;
        resolve(handle ?? null);
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

export class StorageAdapterImpl implements StorageAdapter {
  private readonly windowRef: Window | undefined;
  private readonly nativeBridge: NativeStorageBridge | undefined;
  private gdrive: GoogleDriveService | null = null;

  /** All .md files from the picked folder, keyed by root folder URI. */
  private readonly allBrowserFiles = new Map<string, BrowserFileRecord[]>();

  /** Active FSAPI directory handle, keyed by root folder URI. */
  private readonly fsapiHandles = new Map<string, FileSystemDirectoryHandle>();

  constructor(windowRef?: Window, gdrive?: GoogleDriveService) {
    this.windowRef =
      windowRef ?? (typeof window !== "undefined" ? window : undefined);
    this.nativeBridge = detectNativeBridge(this.windowRef);
    this.gdrive = gdrive ?? null;
  }

  /**
   * Pick a folder from Google Drive. Returns a gdrive:// URI.
   * If not authenticated, initiates OAuth redirect (never returns).
   */
  async pickGDriveFolder(): Promise<string> {
    if (!this.gdrive) throw new Error("Google Drive not configured");
    if (!this.gdrive.isAuthenticated()) {
      await this.gdrive.startAuth();
      // startAuth() redirects — this line is unreachable
      throw new Error("Redirecting to Google sign-in...");
    }
    return `${GDRIVE_PREFIX}root`;
  }

  async pickFolder(): Promise<string> {
    // Tier 1: Native bridge (Even Realities host app)
    if (this.nativeBridge?.pickFolder) {
      const treeUri = await this.nativeBridge.pickFolder();
      if (!treeUri) {
        throw new Error("Folder selection was cancelled.");
      }
      return treeUri;
    }

    // Tier 2: File System Access API (showDirectoryPicker)
    if (hasFSAPI()) {
      try {
        return await this.pickFolderViaFSAPI();
      } catch (err) {
        // If user cancelled, re-throw
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("Folder selection was cancelled.");
        }
        // If FSAPI failed (e.g. Android WebView not supporting it yet),
        // fall through to webkitdirectory input
        console.warn("[storage] showDirectoryPicker failed, falling back:", err);
      }
    }

    // Tier 3: webkitdirectory input (desktop browsers)
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

    // Google Drive path
    if (folderUri.startsWith(GDRIVE_PREFIX)) {
      return this.listGDriveFolderContents(folderUri);
    }

    // FSAPI path
    if (folderUri.startsWith(FSAPI_PREFIX)) {
      return this.listFSAPIFolderContents(folderUri);
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

    // Google Drive path
    if (rootFolderUri.startsWith(GDRIVE_PREFIX)) {
      return this.getAllGDriveFiles(rootFolderUri);
    }

    // FSAPI path
    if (rootFolderUri.startsWith(FSAPI_PREFIX)) {
      return this.getAllFSAPIFiles(rootFolderUri);
    }

    const { rootUri } = this.parseFolderUri(rootFolderUri);
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

    // Google Drive path
    if (uri.startsWith(GDRIVE_PREFIX)) {
      return this.readGDriveFile(uri);
    }

    // FSAPI path
    if (uri.startsWith(FSAPI_PREFIX)) {
      return this.readFSAPIFile(uri);
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

    // If it's a Google Drive URI, verify we still have a refresh token
    if (value.startsWith(GDRIVE_PREFIX)) {
      if (!this.gdrive?.isAuthenticated()) {
        this.windowRef.localStorage.removeItem(STORAGE_KEYS.folderUri);
        return null;
      }
      return value;
    }

    // If it's an FSAPI URI, restore the directory handle from IndexedDB
    if (value.startsWith(FSAPI_PREFIX)) {
      const restored = await this.restoreFSAPIHandle(value);
      if (!restored) {
        // Handle expired or permission denied — clear persisted URI
        this.windowRef.localStorage.removeItem(STORAGE_KEYS.folderUri);
        return null;
      }
    }

    return value;
  }

  // --- Private: File System Access API ---

  private async pickFolderViaFSAPI(): Promise<string> {
    const handle = await showDirectoryPicker({ mode: "read" });
    const folderUri = `${FSAPI_PREFIX}${handle.name}-${Date.now()}`;

    this.fsapiHandles.set(folderUri, handle);

    // Persist handle in IndexedDB for cross-session restoration
    try {
      await persistDirectoryHandle(handle);
    } catch (err) {
      console.warn("[storage] Failed to persist directory handle:", err);
    }

    return folderUri;
  }

  /**
   * Restore an FSAPI directory handle from IndexedDB and re-request permission.
   * Returns true if successful, false if handle is gone or permission denied.
   */
  private async restoreFSAPIHandle(folderUri: string): Promise<boolean> {
    try {
      const handle = await loadDirectoryHandle();
      if (!handle) return false;

      // Re-request read permission — may show a brief confirmation dialog
      const perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") return false;

      this.fsapiHandles.set(folderUri, handle);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Navigate to a subdirectory handle from the root handle.
   */
  private async resolveSubdirHandle(
    folderUri: string,
  ): Promise<FileSystemDirectoryHandle> {
    const { rootUri, subPath } = this.parseFolderUri(folderUri);
    const rootHandle = this.fsapiHandles.get(rootUri);
    if (!rootHandle) {
      throw new Error(
        "Folder access is no longer valid. Please select the folder again.",
      );
    }

    if (!subPath) return rootHandle;

    // Walk down the path segments
    let current = rootHandle;
    for (const segment of subPath.split("/")) {
      current = await current.getDirectoryHandle(segment);
    }
    return current;
  }

  /**
   * List direct children of a FSAPI-backed folder.
   */
  private async listFSAPIFolderContents(
    folderUri: string,
  ): Promise<BrowserEntry[]> {
    const dirHandle = await this.resolveSubdirHandle(folderUri);
    const { rootUri, subPath } = this.parseFolderUri(folderUri);

    const folders: BrowserEntry[] = [];
    const files: BrowserEntry[] = [];

    for await (const [name, childHandle] of dirHandle.entries()) {
      if (childHandle.kind === "directory") {
        folders.push({
          kind: "folder",
          name,
          uri: subPath
            ? `${rootUri}/${subPath}/${name}`
            : `${rootUri}/${name}`,
          sizeBytes: 0,
        });
      } else if (name.toLowerCase().endsWith(".md")) {
        const file = await childHandle.getFile();
        files.push({
          kind: "file",
          name,
          uri: subPath
            ? `${rootUri}/${subPath}/${name}`
            : `${rootUri}/${name}`,
          sizeBytes: file.size,
        });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...files];
  }

  /**
   * Recursively list all .md files under a FSAPI-backed folder.
   */
  private async getAllFSAPIFiles(
    rootFolderUri: string,
  ): Promise<BrowserEntry[]> {
    const { rootUri } = this.parseFolderUri(rootFolderUri);
    const rootHandle = this.fsapiHandles.get(rootUri);
    if (!rootHandle) return [];

    const results: BrowserEntry[] = [];
    await this.walkFSAPIDir(rootHandle, rootUri, "", results);
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  private async walkFSAPIDir(
    dirHandle: FileSystemDirectoryHandle,
    rootUri: string,
    currentPath: string,
    results: BrowserEntry[],
  ): Promise<void> {
    for await (const [name, childHandle] of dirHandle.entries()) {
      const childPath = currentPath ? `${currentPath}/${name}` : name;
      if (childHandle.kind === "directory") {
        await this.walkFSAPIDir(childHandle, rootUri, childPath, results);
      } else if (name.toLowerCase().endsWith(".md")) {
        const file = await childHandle.getFile();
        results.push({
          kind: "file",
          name,
          uri: `${rootUri}/${childPath}`,
          sizeBytes: file.size,
        });
      }
    }
  }

  /**
   * Read a file from a FSAPI-backed folder.
   * URI format: "fsapi://name-123/path/to/file.md"
   */
  private async readFSAPIFile(uri: string): Promise<string> {
    const { rootUri, subPath } = this.parseFolderUri(uri);
    if (!subPath) {
      throw new Error(`Invalid FSAPI file URI: ${uri}`);
    }

    const rootHandle = this.fsapiHandles.get(rootUri);
    if (!rootHandle) {
      throw new Error(
        "Folder access is no longer valid. Please select the folder again.",
      );
    }

    // Walk to the file: "path/to/file.md" → ["path", "to"] dirs + "file.md" file
    const segments = subPath.split("/");
    const fileName = segments.pop()!;
    let current: FileSystemDirectoryHandle = rootHandle;
    for (const segment of segments) {
      current = await current.getDirectoryHandle(segment);
    }
    const fileHandle = await current.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file.text();
  }

  // --- Private: Google Drive ---

  private async listGDriveFolderContents(
    folderUri: string,
  ): Promise<BrowserEntry[]> {
    if (!this.gdrive) throw new Error("Google Drive not configured");

    const folderId = folderUri.slice(GDRIVE_PREFIX.length);
    const items = await this.gdrive.listFolder(folderId);

    const folders: BrowserEntry[] = [];
    const files: BrowserEntry[] = [];

    for (const item of items) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        folders.push({
          kind: "folder",
          name: item.name,
          uri: `${GDRIVE_PREFIX}${item.id}`,
          sizeBytes: 0,
        });
      } else if (item.name.toLowerCase().endsWith(".md")) {
        files.push({
          kind: "file",
          name: item.name,
          uri: `${GDRIVE_PREFIX}${item.id}`,
          sizeBytes: parseInt(item.size ?? "0", 10),
        });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...files];
  }

  private async getAllGDriveFiles(
    rootFolderUri: string,
  ): Promise<BrowserEntry[]> {
    if (!this.gdrive) throw new Error("Google Drive not configured");

    const folderId = rootFolderUri.slice(GDRIVE_PREFIX.length);
    const items = await this.gdrive.listAllMdFiles(folderId);

    return items
      .filter((f) => f.name.toLowerCase().endsWith(".md"))
      .map(
        (f): BrowserEntry => ({
          kind: "file",
          name: f.name,
          uri: `${GDRIVE_PREFIX}${f.id}`,
          sizeBytes: parseInt(f.size ?? "0", 10),
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async readGDriveFile(uri: string): Promise<string> {
    if (!this.gdrive) throw new Error("Google Drive not configured");

    const fileId = uri.slice(GDRIVE_PREFIX.length);
    return this.gdrive.readFile(fileId);
  }

  // --- Private: browser fallback (webkitdirectory) ---

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
    const { rootUri, subPath } = this.parseFolderUri(folderUri);

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

  // --- Private: URI parsing ---

  /**
   * Parse a folder URI into root URI and optional sub-path.
   * Works for "webfolder://", "fsapi://", and "gdrive://" schemes.
   *
   * "fsapi://name-123" → { rootUri: "fsapi://name-123", subPath: "" }
   * "fsapi://name-123/sub/path" → { rootUri: "fsapi://name-123", subPath: "sub/path" }
   * "webfolder://x-123" → { rootUri: "webfolder://x-123", subPath: "" }
   * "gdrive://folderId" → { rootUri: "gdrive://folderId", subPath: "" }
   */
  private parseFolderUri(folderUri: string): {
    rootUri: string;
    subPath: string;
  } {
    // Google Drive URIs: each folder has its own ID, no sub-path parsing
    if (folderUri.startsWith(GDRIVE_PREFIX)) {
      return { rootUri: folderUri, subPath: "" };
    }

    // Check FSAPI handles first
    for (const rootUri of this.fsapiHandles.keys()) {
      if (folderUri === rootUri) {
        return { rootUri, subPath: "" };
      }
      if (folderUri.startsWith(rootUri + "/")) {
        return { rootUri, subPath: folderUri.slice(rootUri.length + 1) };
      }
    }

    // Check browser file cache
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

  // --- Private: webkitdirectory helpers ---

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

  // --- Private: native bridge helpers ---

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
