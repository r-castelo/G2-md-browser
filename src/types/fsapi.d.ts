/**
 * Type declarations for the File System Access API.
 * These APIs are available in modern browsers but not yet in TypeScript's
 * default DOM lib. We declare only the subset we use.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
  entries(): AsyncIterableIterator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >;
  values(): AsyncIterableIterator<
    FileSystemDirectoryHandle | FileSystemFileHandle
  >;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface FileSystemFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

interface ShowDirectoryPickerOptions {
  mode?: "read" | "readwrite";
  startIn?: string;
}

declare function showDirectoryPicker(
  options?: ShowDirectoryPickerOptions,
): Promise<FileSystemDirectoryHandle>;
