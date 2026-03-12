/**
 * Telegram file download helper using @grammyjs/files plugin
 */

import { Bot } from "grammy";
import { hydrateFiles } from "@grammyjs/files";
import { createChildLogger } from "../utils/index.js";

/** Type for hydrated file with download method */
interface HydratedFile {
  download(path?: string): Promise<string>;
}

const log = createChildLogger("media:download");

/**
 * Apply hydrateFiles plugin to bot API
 * Must be called before using downloadFile
 */
export function hydrateFilesOnBot(bot: Bot, token: string): void {
  bot.api.config.use(hydrateFiles(token));
  log.debug("hydrateFiles plugin applied to bot");
}

/**
 * Download a Telegram file to local filesystem
 * @param bot - Bot instance with hydrateFiles applied
 * @param fileId - Telegram file_id
 * @param destPath - Local path to save file
 * @returns Local file path
 * @throws Error if download fails
 */
export async function downloadFile(
  bot: Bot<any>,
  fileId: string,
  destPath: string,
): Promise<string> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.debug({ fileId, destPath, attempt }, "downloading file");

      // Get file info from Telegram (hydrateFiles adds download method at runtime)
      const file = await bot.api.getFile(fileId);

      // Download to local path (method added by hydrateFiles plugin)
      const hydratedFile = file as typeof file & HydratedFile;
      await hydratedFile.download(destPath);

      log.info({ fileId, destPath }, "file downloaded");
      return destPath;
    } catch (error: unknown) {
      // Extract message from any error shape (grammY may throw non-Error objects)
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null
            ? JSON.stringify(error)
            : String(error);

      const isTransient =
        message.includes("EAI_AGAIN") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ECONNRESET") ||
        message.includes("ECONNREFUSED") ||
        message.includes("fetch failed") ||
        message.includes("network") ||
        message === "" || // Empty error = likely network issue
        message === "{}";

      if (isTransient && attempt < MAX_RETRIES) {
        const delayMs = attempt * 2000;
        log.warn(
          { fileId, attempt, error: message || "(empty)", retryInMs: delayMs },
          "Transient download error, retrying",
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      log.error(
        { fileId, destPath, error: message || "(empty)" },
        "download failed",
      );
      throw new Error(
        `Failed to download file ${fileId}: ${message || "(unknown error)"}`,
      );
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`Failed to download file ${fileId}: max retries exceeded`);
}
