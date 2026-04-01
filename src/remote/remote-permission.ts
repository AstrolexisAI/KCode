/**
 * Remote Permission Bridge for KCode Remote Mode.
 * Bridges permission requests from a remote agent back to the local TUI
 * for user approval. Implements a timeout with default-deny policy.
 */

/** A permission request from the remote agent */
export interface PermissionRequest {
  /** Unique request ID */
  id: string;
  /** Type of tool requesting permission */
  tool: string;
  /** Human-readable description of what the tool wants to do */
  description: string;
  /** The command or operation details */
  detail: string;
  /** Working directory context */
  cwd?: string;
}

/** Result of a permission decision */
export interface PermissionResult {
  /** The request ID this result corresponds to */
  requestId: string;
  /** Whether the operation was approved */
  approved: boolean;
  /** Reason for denial (if denied) */
  reason?: string;
}

/** Callback for presenting a permission request to the user */
export type PermissionPromptFn = (request: PermissionRequest) => Promise<boolean>;

/** Default timeout for permission requests: 30 seconds */
export const PERMISSION_TIMEOUT_MS = 30_000;

/**
 * Remote Permission Bridge.
 * Manages pending permission requests from a remote session,
 * bridging them to a local prompt function.
 */
export class RemotePermissionBridge {
  private promptFn: PermissionPromptFn;
  private pendingRequests: Map<
    string,
    {
      resolve: (result: PermissionResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private timeoutMs: number;

  constructor(promptFn: PermissionPromptFn, timeoutMs: number = PERMISSION_TIMEOUT_MS) {
    this.promptFn = promptFn;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Handle an incoming permission request from the remote agent.
   * Presents it to the user via the prompt function with a timeout.
   * If the timeout expires, the request is denied by default.
   *
   * @param request The permission request from the remote
   * @returns PermissionResult with approval or denial
   */
  async handleRequest(request: PermissionRequest): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      // Set up timeout - default deny
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        resolve({
          requestId: request.id,
          approved: false,
          reason: "Permission request timed out (30s). Defaulting to deny.",
        });
      }, this.timeoutMs);

      this.pendingRequests.set(request.id, { resolve, timer });

      // Prompt the user
      this.promptFn(request)
        .then((approved) => {
          const pending = this.pendingRequests.get(request.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(request.id);
            resolve({
              requestId: request.id,
              approved,
              reason: approved ? undefined : "User denied the request.",
            });
          }
          // If not in pendingRequests, timeout already fired
        })
        .catch(() => {
          const pending = this.pendingRequests.get(request.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(request.id);
            resolve({
              requestId: request.id,
              approved: false,
              reason: "Error prompting user. Defaulting to deny.",
            });
          }
        });
    });
  }

  /**
   * Cancel a pending permission request.
   */
  cancel(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        approved: false,
        reason: "Request cancelled.",
      });
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Cancel all pending permission requests.
   */
  cancelAll(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId: id,
        approved: false,
        reason: "All requests cancelled (session ending).",
      });
    }
    this.pendingRequests.clear();
  }

  /**
   * Get the number of currently pending requests.
   */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }
}

/**
 * Create a simple console-based permission prompt for non-TUI usage.
 * Always denies in non-interactive mode.
 */
export function createAutoPrompt(autoApprove: boolean = false): PermissionPromptFn {
  return async (_request: PermissionRequest) => {
    return autoApprove;
  };
}
