/**
 * Google Drive service — handles OAuth 2.0 (redirect + PKCE) and Drive API calls.
 *
 * Design:
 * - No popups — uses full-page redirect to Google's consent screen
 * - PKCE (S256) for public client security (no client secret in browser)
 * - Refresh token persisted in localStorage for cross-session auth
 * - Access token kept in memory only (short-lived, ~1 hour)
 * - All Drive API calls use the read-only scope
 */

import { GDRIVE_CONFIG, GDRIVE_STORAGE_KEYS } from "../config/gdriveConfig";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export class GoogleDriveService {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  // --- PKCE ---

  /**
   * Generate a cryptographically random code_verifier (43-128 chars, URL-safe).
   */
  private generateCodeVerifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return this.base64urlEncode(bytes);
  }

  /**
   * Derive code_challenge from code_verifier using SHA-256.
   */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return this.base64urlEncode(new Uint8Array(digest));
  }

  private base64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // --- OAuth Redirect Flow ---

  /**
   * Initiate OAuth: build auth URL, save state to localStorage, redirect.
   * This does a full-page navigation — the function never returns normally.
   */
  async startAuth(): Promise<void> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);
    const state = crypto.randomUUID();

    localStorage.setItem(GDRIVE_STORAGE_KEYS.codeVerifier, codeVerifier);
    localStorage.setItem(GDRIVE_STORAGE_KEYS.preAuthState, state);

    const params = new URLSearchParams({
      client_id: GDRIVE_CONFIG.CLIENT_ID,
      redirect_uri: GDRIVE_CONFIG.REDIRECT_URI,
      response_type: "code",
      scope: GDRIVE_CONFIG.SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    window.location.href = `${GDRIVE_CONFIG.AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Check if the current URL contains an OAuth authorization code.
   * Call once at app startup. Returns true if a code was found and tokens were exchanged.
   */
  async handleRedirectIfPresent(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) return false;

    // Verify CSRF state
    const savedState = localStorage.getItem(GDRIVE_STORAGE_KEYS.preAuthState);
    if (state !== savedState) {
      console.error("[gdrive] State mismatch — possible CSRF attack");
      this.cleanupRedirectParams();
      return false;
    }

    // Get code verifier for PKCE
    const codeVerifier = localStorage.getItem(GDRIVE_STORAGE_KEYS.codeVerifier);
    if (!codeVerifier) {
      console.error("[gdrive] No code_verifier found");
      this.cleanupRedirectParams();
      return false;
    }

    try {
      await this.exchangeCodeForTokens(code, codeVerifier);
      console.log("[gdrive] OAuth completed successfully");
    } catch (err) {
      console.error("[gdrive] Token exchange failed:", err);
      this.cleanupRedirectParams();
      return false;
    }

    this.cleanupRedirectParams();
    return true;
  }

  /**
   * Exchange authorization code for access + refresh tokens.
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<void> {
    const response = await fetch(GDRIVE_CONFIG.TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GDRIVE_CONFIG.CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: GDRIVE_CONFIG.REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;

    if (data.refresh_token) {
      localStorage.setItem(
        GDRIVE_STORAGE_KEYS.refreshToken,
        data.refresh_token,
      );
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  private async refreshAccessToken(): Promise<void> {
    const refreshToken = localStorage.getItem(
      GDRIVE_STORAGE_KEYS.refreshToken,
    );
    if (!refreshToken) {
      throw new Error("No refresh token available. Please sign in again.");
    }

    const response = await fetch(GDRIVE_CONFIG.TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GDRIVE_CONFIG.CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      // Refresh token revoked or expired — clear it
      localStorage.removeItem(GDRIVE_STORAGE_KEYS.refreshToken);
      throw new Error("Session expired. Please sign in again.");
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
  }

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    await this.refreshAccessToken();
    return this.accessToken!;
  }

  /**
   * Whether the user has a stored refresh token (previously authenticated).
   */
  isAuthenticated(): boolean {
    return !!localStorage.getItem(GDRIVE_STORAGE_KEYS.refreshToken);
  }

  /**
   * Sign out: clear all tokens.
   */
  signOut(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    localStorage.removeItem(GDRIVE_STORAGE_KEYS.refreshToken);
    localStorage.removeItem(GDRIVE_STORAGE_KEYS.codeVerifier);
    localStorage.removeItem(GDRIVE_STORAGE_KEYS.preAuthState);
  }

  // --- Google Drive API ---

  /**
   * List direct children of a folder (folders + .md files).
   * Use parentId = "root" for the user's My Drive root.
   */
  async listFolder(parentId: string): Promise<DriveFile[]> {
    const token = await this.getAccessToken();

    // Query: direct children, not trashed, folders or .md files
    const q = `'${parentId}' in parents and trashed = false and (mimeType = '${DRIVE_FOLDER_MIME}' or name contains '.md')`;

    const allFiles: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q,
        fields: "files(id,name,mimeType,size),nextPageToken",
        orderBy: "folder,name",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const response = await fetch(
        `${GDRIVE_CONFIG.API_BASE}/files?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!response.ok) {
        throw new Error(`Drive API error: ${response.status}`);
      }

      const data = (await response.json()) as DriveListResponse;
      if (data.files) {
        allFiles.push(...data.files);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return allFiles;
  }

  /**
   * Recursively list all .md files under a folder.
   * Used for search and favorites functionality.
   */
  async listAllMdFiles(parentId: string): Promise<DriveFile[]> {
    const allMdFiles: DriveFile[] = [];
    await this.walkDriveFolder(parentId, allMdFiles);
    return allMdFiles;
  }

  private async walkDriveFolder(
    folderId: string,
    results: DriveFile[],
  ): Promise<void> {
    const items = await this.listFolder(folderId);

    for (const item of items) {
      if (item.mimeType === DRIVE_FOLDER_MIME) {
        await this.walkDriveFolder(item.id, results);
      } else if (item.name.toLowerCase().endsWith(".md")) {
        results.push(item);
      }
    }
  }

  /**
   * Read a file's text content by file ID.
   */
  async readFile(fileId: string): Promise<string> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `${GDRIVE_CONFIG.API_BASE}/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status}`);
    }

    return response.text();
  }

  // --- Helpers ---

  private cleanupRedirectParams(): void {
    // Remove OAuth params from URL without page reload
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    url.searchParams.delete("scope");
    window.history.replaceState({}, "", url.pathname + url.hash);

    localStorage.removeItem(GDRIVE_STORAGE_KEYS.codeVerifier);
    localStorage.removeItem(GDRIVE_STORAGE_KEYS.preAuthState);
  }
}
