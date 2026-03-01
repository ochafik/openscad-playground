/**
 * Minimal MCP Apps client for running the OpenSCAD playground inside an MCP host iframe.
 * Implements the JSON-RPC over postMessage protocol directly (no SDK dependency).
 */

export function isMcpMode(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return false; // cross-origin check failed = we're in an iframe
  }
}

export interface OpenSCADCommand {
  type: string;
  [key: string]: unknown;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export class McpAppClient {
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
  }>();

  // Handlers set by consumer (may be set after connect — buffered notifications replay on assignment)
  private _ontoolinput?: (params: { arguments?: Record<string, unknown> }) => void;
  private _ontoolresult?: (params: { content?: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }) => void;
  onhostcontextchanged?: (ctx: Record<string, unknown>) => void;

  // Buffer notifications received before handlers are registered
  private bufferedToolInput: Array<{ arguments?: Record<string, unknown> }> = [];
  private bufferedToolResult: Array<{ content?: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }> = [];

  set ontoolinput(handler: typeof this._ontoolinput) {
    this._ontoolinput = handler;
    if (handler && this.bufferedToolInput.length > 0) {
      for (const params of this.bufferedToolInput) handler(params);
      this.bufferedToolInput = [];
    }
  }
  get ontoolinput() { return this._ontoolinput; }

  set ontoolresult(handler: typeof this._ontoolresult) {
    this._ontoolresult = handler;
    if (handler && this.bufferedToolResult.length > 0) {
      for (const params of this.bufferedToolResult) handler(params);
      this.bufferedToolResult = [];
    }
  }
  get ontoolresult() { return this._ontoolresult; }

  private hostContext: Record<string, unknown> = {};
  private connected = false;

  constructor(private parent: Window) {
    window.addEventListener('message', this.handleMessage);
  }

  async connect(): Promise<Record<string, unknown>> {
    const result = await this.request('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'OpenSCAD Playground', version: '0.1.0' },
      appCapabilities: {
        permissions: { clipboardWrite: {} },
      },
    });
    this.hostContext = result?.hostContext ?? {};
    this.connected = true;
    this.notify('ui/notifications/initialized', {});

    // Report initial size
    this.notifySizeChanged(document.documentElement.scrollWidth, document.documentElement.scrollHeight);

    // Watch for resizes
    const ro = new ResizeObserver(() => {
      this.notifySizeChanged(document.documentElement.scrollWidth, document.documentElement.scrollHeight);
    });
    ro.observe(document.documentElement);

    return this.hostContext;
  }

  getHostContext(): Record<string, unknown> {
    return this.hostContext;
  }

  // ─── Server tool calls ─────────────────────────────────────────────

  async callServerTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.request('tools/call', { name, arguments: args });
    return result;
  }

  async updateModelContext(content: ContentBlock[]): Promise<void> {
    await this.request('ui/update-model-context', { content });
  }

  async openLink(url: string): Promise<void> {
    await this.request('ui/open-link', { url });
  }

  async requestDisplayMode(mode: 'inline' | 'fullscreen' | 'pip'): Promise<void> {
    await this.request('ui/request-display-mode', { mode });
  }

  // ─── Internal protocol ─────────────────────────────────────────────

  private handleMessage = (event: MessageEvent) => {
    if (event.source !== this.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      // Response to our request
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error?.message ?? 'Unknown error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ('method' in msg && !('id' in msg)) {
      // Notification from host
      this.handleNotification(msg);
    } else if ('method' in msg && 'id' in msg) {
      // Request from host
      this.handleHostRequest(msg);
    }
  };

  private handleNotification(msg: { method: string; params?: any }) {
    switch (msg.method) {
      case 'ui/notifications/tool-input':
        if (this._ontoolinput) this._ontoolinput(msg.params ?? {});
        else this.bufferedToolInput.push(msg.params ?? {});
        break;
      case 'ui/notifications/tool-input-partial':
        break; // Intentionally ignored — we wait for the final tool-input
      case 'ui/notifications/tool-result':
        if (this._ontoolresult) this._ontoolresult(msg.params ?? {});
        else this.bufferedToolResult.push(msg.params ?? {});
        break;
      case 'ui/notifications/tool-cancelled':
        break;
      case 'ui/notifications/host-context-changed':
        Object.assign(this.hostContext, msg.params ?? {});
        this.onhostcontextchanged?.(this.hostContext);
        break;
    }
  }

  private handleHostRequest(msg: { id: number | string; method: string; params?: any }) {
    // Respond to host requests
    switch (msg.method) {
      case 'ui/resource-teardown':
        this.sendResponse(msg.id, {});
        break;
      case 'ping':
        this.sendResponse(msg.id, {});
        break;
      default:
        // Unknown request, respond with empty result
        this.sendResponse(msg.id, {});
    }
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
      this.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }

  // Target origin '*' is required: the MCP App runs in a sandboxed iframe
  // whose host origin is not known in advance (varies by MCP host implementation).
  private notify(method: string, params: any) {
    this.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  private sendResponse(id: number | string, result: any) {
    this.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
  }

  private notifySizeChanged(width: number, height: number) {
    if (this.connected) {
      this.notify('ui/notifications/size-changed', { width, height });
    }
  }

  destroy() {
    window.removeEventListener('message', this.handleMessage);
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Client destroyed'));
    }
    this.pendingRequests.clear();
  }
}

// ─── Host style helpers ──────────────────────────────────────────────────

/** Apply host CSS variables to the document root. */
export function applyHostStyleVariables(
  variables: Record<string, string>,
  root: HTMLElement = document.documentElement,
) {
  for (const [key, value] of Object.entries(variables)) {
    root.style.setProperty(key, value);
  }
}

/** Set color-scheme and data-theme on the document root. */
export function applyDocumentTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

let _fontStyleEl: HTMLStyleElement | null = null;
/** Inject host font CSS (@font-face / @import rules). */
export function applyHostFonts(fontCss: string) {
  if (!_fontStyleEl) {
    _fontStyleEl = document.createElement('style');
    _fontStyleEl.id = 'mcp-host-fonts';
    document.head.appendChild(_fontStyleEl);
  }
  _fontStyleEl.textContent = fontCss;
}

/** Apply all styles from hostContext in one call. */
export function applyHostStyles(ctx: Record<string, unknown>) {
  const theme = ctx.theme as string | undefined;
  if (theme === 'light' || theme === 'dark') {
    applyDocumentTheme(theme);
  }

  const styles = ctx.styles as { variables?: Record<string, string>; css?: { fonts?: string } } | undefined;
  if (styles?.variables) {
    applyHostStyleVariables(styles.variables);
  }
  if (styles?.css?.fonts) {
    applyHostFonts(styles.css.fonts);
  }
}

// ─── Command poller ─────────────────────────────────────────────────────

export interface McpCommandProcessor {
  /** Process a command. Return value is used for request-response commands. */
  processCommand(command: OpenSCADCommand): Promise<unknown>;
  captureScreenshot(): Promise<string | null>;
  getContextState(): Record<string, unknown>;
}

/**
 * Starts the command polling loop using long-polling.
 * The server holds the poll request for up to 30s until commands arrive.
 *
 * For request-response commands (those with a requestId), the result from
 * processCommand() is submitted back via the submit_result tool.
 *
 * For fire-and-forget commands, state flows back to the LLM via model context updates.
 */
export function startCommandPoller(
  client: McpAppClient,
  viewUUID: string,
  processor: McpCommandProcessor,
): { stop: () => void; updateContext: () => Promise<void> } {
  let running = true;

  async function pollLoop() {
    while (running) {
      try {
        // Long-poll: server holds this request until commands arrive or 30s timeout
        const result = await client.callServerTool('poll_commands', { viewUUID });
        const text = result?.content?.[0]?.text;
        if (!text) continue;

        const { commands } = JSON.parse(text) as { commands: OpenSCADCommand[] };
        if (!commands || commands.length === 0) continue;

        let hasFireAndForget = false;

        for (const command of commands) {
          const commandResult = await processor.processCommand(command);

          // If this is a request-response command, submit the result back
          if ('requestId' in command && command.requestId) {
            try {
              await client.callServerTool('submit_result', {
                requestId: command.requestId as string,
                data: commandResult ?? {},
              });
            } catch (e) {
              console.warn('Failed to submit result:', e);
            }
          } else {
            hasFireAndForget = true;
          }
        }

        // Update model context after fire-and-forget commands
        if (hasFireAndForget) {
          await updateContext();
        }
      } catch (e) {
        console.warn('Poll error:', e);
        // Back off on error to avoid tight error loops
        if (running) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async function updateContext() {
    try {
      const content: ContentBlock[] = [];

      // Add screenshot
      const screenshot = await processor.captureScreenshot();
      if (screenshot) {
        const base64 = screenshot.split(',')[1];
        if (base64) {
          content.push({ type: 'image', data: base64, mimeType: 'image/png' });
        }
      }

      // Add state info
      const state = processor.getContextState();
      content.push({ type: 'text', text: JSON.stringify(state, null, 2) });

      await client.updateModelContext(content);
    } catch (e) {
      console.warn('Failed to update model context:', e);
    }
  }

  // Start the loop (non-blocking)
  pollLoop();

  return { stop: () => { running = false; }, updateContext };
}
