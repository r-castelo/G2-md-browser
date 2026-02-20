import { Controller } from "./app/controller";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { StorageAdapterImpl } from "./adapters/storageAdapter";
import { PhoneUI, setPhoneState } from "./phone/phoneUI";

async function bootstrap(): Promise<void> {
  setPhoneState("connecting", "Connecting to glasses...", "Open this page from Even App dev mode");

  const glass = new GlassAdapterImpl();
  const storage = new StorageAdapterImpl();
  const controller = new Controller({ glass, storage });

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
    });

    return phoneUI;
  };

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
