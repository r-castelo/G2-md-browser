# G2 Markdown Browser

A markdown file reader for [Even Realities G2](https://www.evenrealities.com/) smart glasses. Browse folders, search files, manage favorites on your phone, and read markdown documents on the glasses display with swipe-based page navigation.

## Features

### On the glasses (576x288 green monochrome display)

- **File browser** -- scroll and tap to navigate folders and open files
- **Folder navigation** -- nested folders with `..` to go back, trailing `/` convention
- **Reader** -- paginated text with swipe-forward / swipe-back page flips
- **Menu** -- tap while reading to access: back to files, jump to top, close menu
- **Status bar** -- shows current path when browsing, file name and page number when reading
- **Reading position persistence** -- reopening a file resumes where you left off

### On the phone (companion WebView)

- **File browser** -- see folder contents after connecting and selecting a root folder
- **Search** -- instant search across all `.md` files in the root and subfolders
- **Favorites** -- star files for quick access from a dedicated tab
- **Folder navigation** -- tap folders to enter, tap `..` to go back (same as glasses)
- **Confirmation dialog** -- tapping a file shows a confirmation sheet before opening it on the glasses, preventing accidental overwrites
- **Change folder** -- re-pick the root folder at any time

## Requirements

- [Even Realities G2](https://www.evenrealities.com/) smart glasses
- [Even App](https://apps.apple.com/app/even-app/) on your phone
- Node.js >= 18

## Getting started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run the simulator (points at localhost:5173)
npm run sim

# Generate a QR code to load on your phone via Even App
npm run qr
```

## Building

```bash
# Typecheck + build
npm run build

# Package as .ehpk for distribution
npm run pack
```

The `.ehpk` file can be loaded through Even App's developer mode.

## Testing

```bash
npm test
```

Runs unit tests for markdown normalization and text pagination.

## Project structure

```
src/
  adapters/
    glassAdapter.ts    # EvenHub SDK bridge -- containers, gestures, events
    storageAdapter.ts  # File system access -- folder picker, file listing, reading
  app/
    controller.ts      # Main app logic -- modes, gestures, rendering
    state.ts           # State machine -- browser, reader, menu states
  config/
    constants.ts       # Display layout, text limits, menu items, storage keys
  domain/
    markdown.ts        # Markdown normalization for the monochrome display
    paginate.ts        # Word wrapping and page splitting
  phone/
    phoneUI.ts         # Phone-side file browser, search, favorites
  types/
    contracts.ts       # Interfaces for glass and storage adapters
  main.ts              # Entry point -- wires adapters, controller, phone UI
index.html             # Phone WebView -- status screen, file browser, confirm dialog
tests/
  markdown.test.ts     # Markdown normalizer tests
  paginate.test.ts     # Wrapping and pagination tests
```

## How it works

The app runs as a WebView inside Even App. On launch it connects to the G2 glasses via the EvenHub SDK, then prompts you to pick a folder containing `.md` files.

**Glasses side:** The display uses two SDK containers -- a content area (list or text) and a status bar. The file browser is a `ListContainer` with firmware-managed scroll and selection. The reader is a `TextContainer` updated in-place with `textContainerUpgrade` for flash-free page flips.

**Phone side:** After connecting, the phone WebView shows a file browser with tabs for files and favorites. Tapping a file shows a confirmation dialog, then sends it to the glasses for reading. Search works across all subfolders instantly.

## SDK notes

Built on `@evenrealities/even_hub_sdk@0.0.7`. A few implementation details worth noting:

- `createStartUpPageContainer` is called exactly once; all subsequent updates use `rebuildPageContainer` (mode changes) or `textContainerUpgrade` (page flips)
- `CLICK_EVENT = 0` deserializes to `undefined` in the SDK -- both are handled as TAP
- List scroll is managed by firmware; the app receives `currentSelectItemIndex` on tap events
- 300ms scroll cooldown prevents duplicate gesture events

## License

MIT
