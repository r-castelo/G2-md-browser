import { Controller } from "./app/controller";
import { STORAGE_KEYS } from "./config/constants";
import { GDRIVE_PREFIX } from "./config/gdriveConfig";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { StorageAdapterImpl } from "./adapters/storageAdapter";
import { GoogleDriveService } from "./services/googleDriveService";
import { WakeLockServiceImpl } from "./services/wakeLockService";
import { PhoneUI, setPhoneState } from "./phone/phoneUI";

async function bootstrap(): Promise<void> {
  setPhoneState("connecting", "Connecting to glasses...", "Open this page from Even App dev mode");

  // --- Google Drive: handle OAuth redirect before anything else ---
  const gdrive = new GoogleDriveService();
  const wasOAuthRedirect = await gdrive.handleRedirectIfPresent();

  const glass = new GlassAdapterImpl();
  const storage = new StorageAdapterImpl(undefined, gdrive);
  const wakeLock = new WakeLockServiceImpl();
  const controller = new Controller({ glass, storage, wakeLock });

  let phoneUI: PhoneUI | null = null;

  const initPhoneUI = (): PhoneUI => {
    if (phoneUI) return phoneUI;

    phoneUI = new PhoneUI({
      storage,
      onFileSelect: (entry) => {
        controller.openFileFromPhone(entry).catch((err: unknown) => {
          console.error("Failed to open file from phone:", err);
        });
      },
      onFolderChange: async () => {
        await controller.changeFolderFromPhone();
        const rootUri = controller.getRootFolderUri();
        if (rootUri && phoneUI) {
          await phoneUI.showFolder(rootUri);
        }
      },
      onGDriveSelect: async () => {
        try {
          const gdriveUri = await storage.pickGDriveFolder();
          // If we get here, user is already authenticated
          await storage.persistFolderUri(gdriveUri);
          localStorage.setItem(STORAGE_KEYS.storageSource, "gdrive");

          // Reload the folder in the controller
          await controller.changeFolderFromPhone();
          const rootUri = controller.getRootFolderUri() ?? gdriveUri;
          if (phoneUI) {
            await phoneUI.showFolder(rootUri);
          }
        } catch (err: unknown) {
          // startAuth() redirects — if we get an error, it's a real failure
          const msg = String(err);
          if (!msg.includes("Redirecting")) {
            setPhoneState("error", "Google Drive failed", msg);
          }
        }
      },
      isGDriveAuthenticated: () => gdrive.isAuthenticated(),
      onGDriveSignOut: () => {
        gdrive.signOut();
        localStorage.removeItem(STORAGE_KEYS.storageSource);
        localStorage.removeItem(STORAGE_KEYS.folderUri);
      },
    });

    return phoneUI;
  };

  // --- Handle post-OAuth redirect: set up Google Drive folder ---
  if (wasOAuthRedirect) {
    console.log("[main] Returned from Google OAuth redirect");
    const gdriveUri = `${GDRIVE_PREFIX}root`;
    await storage.persistFolderUri(gdriveUri);
    localStorage.setItem(STORAGE_KEYS.storageSource, "gdrive");

    await controller.start();

    const ui = initPhoneUI();
    await ui.showFolder(gdriveUri);
    return;
  }

  // --- Normal boot ---
  await controller.start();

  const rootUri = controller.getRootFolderUri();
  if (rootUri) {
    const ui = initPhoneUI();
    await ui.showFolder(rootUri);
  } else {
    setPhoneState("connected", "Connected", "No folder selected yet.");
  }
}

void bootstrap().catch((error: unknown) => {
  setPhoneState("error", "Failed to start", String(error));
  console.error("G2 Markdown Browser failed to start", error);
});
