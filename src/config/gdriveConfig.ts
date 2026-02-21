/**
 * Google Drive OAuth 2.0 and API configuration.
 *
 * Before using Google Drive, the developer must:
 * 1. Create a project at https://console.cloud.google.com/
 * 2. Enable the Google Drive API
 * 3. Create an OAuth 2.0 Client ID (type: Web application)
 * 4. Add the redirect URI below to authorized redirect URIs
 * 5. Paste the Client ID below
 */

export const GDRIVE_CONFIG = {
  /** Replace with your OAuth 2.0 Client ID from Google Cloud Console. */
  CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",

  /** Must exactly match the authorized redirect URI in Google Cloud Console. */
  REDIRECT_URI: "https://r-castelo.github.io/G2-md-browser/",

  SCOPES: "https://www.googleapis.com/auth/drive.readonly",

  AUTH_ENDPOINT: "https://accounts.google.com/o/oauth2/v2/auth",
  TOKEN_ENDPOINT: "https://oauth2.googleapis.com/token",

  API_BASE: "https://www.googleapis.com/drive/v3",
} as const;

export const GDRIVE_PREFIX = "gdrive://";

export const GDRIVE_STORAGE_KEYS = {
  refreshToken: "g2_md_browser.gdrive_refresh_token",
  codeVerifier: "g2_md_browser.gdrive_code_verifier",
  preAuthState: "g2_md_browser.gdrive_pre_auth_state",
} as const;
