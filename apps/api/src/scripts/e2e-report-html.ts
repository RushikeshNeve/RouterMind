/**
 * Renders a ReportStep[] into a single self-contained HTML file (inline CSS
 * only, screenshots embedded as base64 data URIs) -- no external assets, so
 * the report still opens correctly if moved or shared outside this repo.
 */

export interface HttpExchange {
  readonly label: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
}

export interface ReportStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly screenshotPngBase64?: string;
  readonly httpExchanges?: readonly HttpExchange[];
  readonly note?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2) ?? "undefined");
}

function renderExchange(exchange: HttpExchange): string {
  const { request, response } = exchange;
  const statusClass =
    response.status < 300 ? "status-ok" : response.status < 500 ? "status-warn" : "status-fail";
  return `
    <div class="exchange">
      <div class="exchange-head">
        <span class="method">${escapeHtml(request.method)}</span>
        <span class="url">${escapeHtml(request.url)}</span>
        <span class="status ${statusClass}">${response.status}</span>
      </div>
      <p class="exchange-label">${escapeHtml(exchange.label)}</p>
      ${
        request.body !== undefined
          ? `<details open><summary>Request body</summary><pre>${renderJson(request.body)}</pre></details>`
          : ""
      }
      <details open><summary>Response body</summary><pre>${renderJson(response.body)}</pre></details>
    </div>`;
}

function renderStep(step: ReportStep, index: number): string {
  return `
    <section class="step" id="${step.id}">
      <h2><span class="step-number">${index + 1}</span>${escapeHtml(step.title)}</h2>
      <p class="description">${escapeHtml(step.description)}</p>
      ${step.note ? `<div class="note">${escapeHtml(step.note)}</div>` : ""}
      ${
        step.screenshotPngBase64
          ? `<img class="screenshot" src="data:image/png;base64,${step.screenshotPngBase64}" alt="${escapeHtml(step.title)}" />`
          : ""
      }
      ${step.httpExchanges && step.httpExchanges.length > 0 ? step.httpExchanges.map(renderExchange).join("\n") : ""}
    </section>`;
}

export function buildHtmlReport(options: {
  readonly title: string;
  readonly generatedAt: string;
  readonly steps: readonly ReportStep[];
}): string {
  const { title, generatedAt, steps } = options;
  const nav = steps
    .map((step, index) => `<a href="#${step.id}">${index + 1}. ${escapeHtml(step.title)}</a>`)
    .join("\n");
  const body = steps.map((step, index) => renderStep(step, index)).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f8fafc;
    color: #0f172a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d121c; color: #e2e8f0; }
  }
  header {
    padding: 24px 32px;
    border-bottom: 1px solid rgba(100,116,139,0.25);
  }
  header h1 { margin: 0 0 4px; font-size: 1.4rem; }
  header p { margin: 0; color: #64748b; font-size: 0.85rem; }
  .layout { display: flex; max-width: 1400px; margin: 0 auto; }
  nav {
    position: sticky;
    top: 0;
    align-self: flex-start;
    width: 280px;
    flex-shrink: 0;
    padding: 24px 16px;
    max-height: 100vh;
    overflow-y: auto;
  }
  nav a {
    display: block;
    padding: 6px 10px;
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
    font-size: 0.85rem;
    margin-bottom: 2px;
  }
  nav a:hover { background: rgba(100,116,139,0.15); }
  main { flex: 1; min-width: 0; padding: 24px 32px 80px; }
  .step {
    border: 1px solid rgba(100,116,139,0.25);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 24px;
    background: rgba(255,255,255,0.6);
  }
  @media (prefers-color-scheme: dark) {
    .step { background: rgba(255,255,255,0.03); }
  }
  .step h2 { margin: 0 0 8px; font-size: 1.05rem; display: flex; align-items: center; gap: 10px; }
  .step-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #0ea5a4;
    color: white;
    font-size: 0.8rem;
    flex-shrink: 0;
  }
  .description { color: #475569; margin: 0 0 12px; font-size: 0.9rem; }
  @media (prefers-color-scheme: dark) { .description { color: #94a3b8; } }
  .note {
    background: rgba(245,158,11,0.12);
    border: 1px solid rgba(245,158,11,0.4);
    color: #92400e;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 0.85rem;
    margin-bottom: 12px;
    white-space: pre-wrap;
  }
  @media (prefers-color-scheme: dark) {
    .note { color: #fcd34d; background: rgba(245,158,11,0.08); }
  }
  .screenshot {
    display: block;
    max-width: 100%;
    border: 1px solid rgba(100,116,139,0.3);
    border-radius: 8px;
    margin-bottom: 12px;
  }
  .exchange {
    border: 1px solid rgba(100,116,139,0.2);
    border-radius: 8px;
    padding: 10px 14px;
    margin-top: 10px;
    background: rgba(100,116,139,0.06);
    overflow-x: auto;
  }
  .exchange-head { display: flex; align-items: center; gap: 8px; font-family: ui-monospace, monospace; font-size: 0.8rem; flex-wrap: wrap; }
  .method { font-weight: 700; color: #0ea5a4; }
  .url { color: inherit; word-break: break-all; }
  .status { margin-left: auto; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  .status-ok { background: rgba(16,185,129,0.15); color: #059669; }
  .status-warn { background: rgba(245,158,11,0.18); color: #b45309; }
  .status-fail { background: rgba(239,68,68,0.15); color: #dc2626; }
  .exchange-label { margin: 6px 0; font-size: 0.8rem; color: #64748b; }
  details summary { cursor: pointer; font-size: 0.8rem; font-weight: 600; margin-top: 4px; }
  pre {
    margin: 6px 0 0;
    padding: 10px;
    background: rgba(15,23,42,0.85);
    color: #e2e8f0;
    border-radius: 6px;
    font-size: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p>Generated ${escapeHtml(generatedAt)} against local dev servers + Docker Postgres/Redis. Real Playwright browser automation and direct HTTP calls -- nothing here is mocked or simulated.</p>
</header>
<div class="layout">
  <nav>${nav}</nav>
  <main>${body}</main>
</div>
</body>
</html>`;
}
