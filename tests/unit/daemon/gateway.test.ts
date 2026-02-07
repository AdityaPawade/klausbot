/**
 * Gateway module unit tests
 *
 * Tests exported functions accessible without triggering side effects.
 * Private helpers (categorizeError, summarizeToolUse, buildPromptWithMedia)
 * are internal and tested via integration tests.
 */
import { describe, expect, it, vi } from "vitest";

// Mock all heavy dependencies to prevent import side effects
vi.mock("../../../src/utils/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../../src/telegram/index.js", () => ({
  streamToTelegram: vi.fn(),
  canStreamToChat: vi.fn(),
  bot: {
    api: { sendMessage: vi.fn(), sendChatAction: vi.fn() },
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
  },
  createRunner: vi.fn(),
  registerSkillCommands: vi.fn(),
  getInstalledSkillNames: vi.fn().mockReturnValue([]),
  translateSkillCommand: vi.fn((t: string) => t),
}));

vi.mock("../../../src/daemon/index.js", () => ({
  MessageQueue: vi.fn(),
  queryClaudeCode: vi.fn(),
  ensureDataDir: vi.fn(),
  spawnBackgroundAgent: vi.fn(),
}));

vi.mock("../../../src/config/index.js", () => ({
  getJsonConfig: vi.fn().mockReturnValue({ streaming: { enabled: false } }),
}));

vi.mock("../../../src/pairing/index.js", () => ({
  initPairingStore: vi.fn(),
  createPairingMiddleware: vi.fn(),
  handleStartCommand: vi.fn(),
  getPairingStore: vi.fn(),
}));

vi.mock("../../../src/memory/index.js", () => ({
  initializeHome: vi.fn(),
  initializeEmbeddings: vi.fn(),
  migrateEmbeddings: vi.fn(),
  closeDb: vi.fn(),
  invalidateIdentityCache: vi.fn(),
  runMigrations: vi.fn(),
  getOrchestrationInstructions: vi.fn(),
  storeConversation: vi.fn(),
  buildConversationContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../../../src/memory/home.js", () => ({
  KLAUSBOT_HOME: "/tmp/test",
}));

vi.mock("../../../src/bootstrap/index.js", () => ({
  needsBootstrap: vi.fn().mockReturnValue(false),
  DEFAULT_BOOTSTRAP_CONTENT: "",
}));

vi.mock("../../../src/platform/index.js", () => ({
  validateRequiredCapabilities: vi.fn(),
}));

vi.mock("../../../src/cron/index.js", () => ({
  startScheduler: vi.fn(),
  stopScheduler: vi.fn(),
  loadCronStore: vi.fn().mockReturnValue({ jobs: [] }),
}));

vi.mock("../../../src/heartbeat/index.js", () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  shouldCollectNote: vi.fn().mockReturnValue(false),
  getNoteCollectionInstructions: vi.fn(),
}));

vi.mock("../../../src/utils/git.js", () => ({
  autoCommitChanges: vi.fn(),
}));

vi.mock("../../../src/utils/index.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  sendLongMessage: vi.fn(),
  markdownToTelegramHtml: vi.fn((t: string) => t),
  splitTelegramMessage: vi.fn((t: string) => [t]),
}));

vi.mock("../../../src/media/index.js", () => ({
  transcribeAudio: vi.fn(),
  isTranscriptionAvailable: vi.fn(),
  saveImage: vi.fn(),
  withRetry: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../../../src/daemon/task-watcher.js", () => ({
  startTaskWatcher: vi.fn().mockReturnValue(() => {}),
}));

import { getLastActiveChatId } from "../../../src/daemon/gateway.js";

describe("gateway", () => {
  describe("module import", () => {
    it("loads without errors with all dependencies mocked", () => {
      // If we got here, the module loaded successfully
      expect(getLastActiveChatId).toBeTypeOf("function");
    });
  });

  describe("getLastActiveChatId", () => {
    it("initially returns null (no messages processed)", () => {
      // lastActiveChatId starts as null before any processMessage calls
      expect(getLastActiveChatId()).toBeNull();
    });
  });
});
