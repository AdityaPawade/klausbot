/**
 * ClaudeCodeBackend — wraps the existing Claude Code CLI spawn logic.
 *
 * Zero behavior change vs. the current implementation: this just delegates
 * to queryClaudeCode and streamClaudeResponse and re-shapes the return values
 * as BackendResponse / BackendStreamResult.
 *
 * Keeping this backend means we can flip back to Claude Code at any time by
 * setting `backend: "claude-code"` in klausbot.json.
 */

import { queryClaudeCode } from "../daemon/spawner.js";
import { streamClaudeResponse } from "../telegram/streaming.js";
import type {
  BackendOptions,
  BackendResponse,
  BackendRescueHandle,
  BackendStreamOptions,
  BackendStreamResult,
  LLMBackend,
} from "./types.js";
import type { RescueHandle } from "../daemon/spawner.js";

function adaptRescueHandle(handle: RescueHandle): BackendRescueHandle {
  return {
    getAccumulated: handle.getAccumulated,
    completion: handle.completion.then((r) => ({
      result: r.result,
      cost_usd: r.cost_usd,
      session_id: r.session_id,
      duration_ms: r.duration_ms,
      is_error: r.is_error,
      toolUse: r.toolUse,
      rescued: r.rescued,
    })),
    sessionId: handle.sessionId,
    toolUseSoFar: handle.toolUseSoFar,
    kill: handle.kill,
  };
}

export class ClaudeCodeBackend implements LLMBackend {
  readonly id = "claude-code";

  async health(): Promise<{ ok: boolean; message?: string }> {
    // Existing platform/capabilities.ts already enforces `claude` is installed
    // at startup. If we got here, it's available.
    return { ok: true };
  }

  async query(
    prompt: string,
    options: BackendOptions = {},
  ): Promise<BackendResponse> {
    const adaptedOnRescue = options.onRescue
      ? (handle: RescueHandle) => options.onRescue!(adaptRescueHandle(handle))
      : undefined;

    const response = await queryClaudeCode(prompt, {
      timeout: options.timeout,
      model: options.model,
      additionalInstructions: options.additionalInstructions,
      chatId: options.chatId,
      rescueThresholdMs: options.rescueThresholdMs,
      onRescue: adaptedOnRescue,
      inactivityTimeoutMs: options.inactivityTimeoutMs,
      resumeSessionId: options.resumeSessionId,
    });

    return {
      result: response.result,
      cost_usd: response.cost_usd,
      session_id: response.session_id,
      duration_ms: response.duration_ms,
      is_error: response.is_error,
      toolUse: response.toolUse,
      rescued: response.rescued,
    };
  }

  async stream(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<BackendStreamResult> {
    const adaptedOnRescue = options.onRescue
      ? (handle: RescueHandle) => options.onRescue!(adaptRescueHandle(handle))
      : undefined;

    const result = await streamClaudeResponse(
      prompt,
      {
        model: options.model,
        additionalInstructions: options.additionalInstructions,
        signal: options.signal,
        chatId: options.chatId,
        rescueThresholdMs: options.rescueThresholdMs,
        onRescue: adaptedOnRescue,
        timeout: options.timeout,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        resumeSessionId: options.resumeSessionId,
      },
      onChunk,
    );

    return {
      result: result.result,
      cost_usd: result.cost_usd,
      session_id: result.session_id,
      toolUse: result.toolUse,
      messageSent: result.messageSent,
      rescued: result.rescued,
    };
  }
}
