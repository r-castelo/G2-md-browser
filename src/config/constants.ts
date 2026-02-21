export const DISPLAY = {
  WIDTH: 576,
  HEIGHT: 288,
} as const;

export const GLASS_LAYOUT = {
  x: 8,
  y: 4,
  width: 560,
  height: 248,
  statusY: 256,
  statusHeight: 28,
} as const;

export const TEXT_LAYOUT = {
  /** Characters per display line. ~64 chars fills a 560px container at SDK default font. */
  CHARS_PER_LINE: 64,
  /** Lines per page. Aim for ~320-400 chars per page for comfortable reading. */
  LINES_PER_PAGE: 8,
} as const;

export const TIMING = {
  /** Scroll cooldown to prevent duplicate events (ms). Per Nick Ustinov notes. */
  SCROLL_COOLDOWN_MS: 300,
  /** Timeout waiting for EvenAppBridge connection (ms). */
  BRIDGE_TIMEOUT_MS: 15_000,
} as const;

export const CONTAINER_IDS = {
  content: 1,
  status: 2,
  statusRight: 3,
} as const;

export const CONTAINER_NAMES = {
  content: "content",
  status: "status",
  statusRight: "statusR",
} as const;

export const STORAGE_KEYS = {
  folderUri: "g2_md_browser.folder_uri",
  readingState: "g2_md_browser.reading",
  favorites: "g2_md_browser.favorites",
  storageSource: "g2_md_browser.storage_source",
} as const;

export const MENU_ITEMS = [
  "Back to files",
  "Top of file",
  "Close menu",
] as const;

export const BROWSER_TEXT = {
  parentFolder: "..",
  folderSuffix: "/",
} as const;

export const APP_TEXT = {
  pickFolderPrompt: "Select a folder with markdown files",
  emptyFolder: "No .md files found",
  invalidFolder: "Folder access expired, please reselect",
  readFailure: "Unable to open markdown file",
} as const;
