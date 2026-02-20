export type Unsubscribe = () => void;

export type AppMode =
  | "BOOT"
  | "FOLDER_PICK"
  | "BROWSER"
  | "READER"
  | "MENU"
  | "ERROR";

export type GestureKind = "SCROLL_FWD" | "SCROLL_BACK" | "TAP";

export interface GestureEvent {
  kind: GestureKind;
  /** Firmware-reported list selection index (from listEvent on TAP). */
  listIndex?: number;
}

export interface FileEntry {
  id: string;
  name: string;
  uri: string;
  sizeBytes: number;
}

export interface BrowserEntry {
  kind: "file" | "folder";
  name: string;
  uri: string;
  sizeBytes: number;
}

export interface ReaderView {
  currentPage: number;
  totalPages: number;
  pageText: string;
  fileName: string;
}

export interface GlassAdapter {
  connect(): Promise<void>;
  onGesture(handler: (event: GestureEvent) => void): Unsubscribe;
  showBrowser(items: string[], statusText: string): Promise<void>;
  showReader(pageText: string, statusText: string): Promise<void>;
  updateReaderText(pageText: string, statusText: string): Promise<void>;
  showMenu(items: string[], statusText: string): Promise<void>;
  showMessage(text: string): Promise<void>;
}

export interface StorageAdapter {
  pickFolder(): Promise<string>;
  listMarkdownFiles(folderUri: string): Promise<FileEntry[]>;
  listFolderContents(folderUri: string): Promise<BrowserEntry[]>;
  /** Return ALL .md files recursively from the root folder (flat list). */
  getAllFiles(rootFolderUri: string): Promise<BrowserEntry[]>;
  readFile(uri: string): Promise<string>;
  persistFolderUri(uri: string): Promise<void>;
  loadFolderUri(): Promise<string | null>;
}
