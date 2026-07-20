// Headless-browser JSON client for the Sofascore API.
// Sofascore's WAF rejects non-browser TLS fingerprints (plain fetch/curl get 403),
// so requests are issued as same-origin fetches inside a real Chromium page.
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const BASE = 'https://www.sofascore.com';
const WARMUP_PATH = '/api/v1/odds/providers/AU/web';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome(configuredPath) {
  const candidates = [configuredPath, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome or Edge executable found. Set "chromePath" in config.json or the CHROME_PATH env var.'
  );
}

class BrowserClient {
  constructor({ chromePath, concurrency = 6, requestDelayMs = 60 } = {}) {
    this.chromePath = chromePath;
    this.concurrency = concurrency;
    this.requestDelayMs = requestDelayMs;
    this.browser = null;
    this.page = null;
  }

  async start() {
    const executablePath = findChrome(this.chromePath);
    this.browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--mute-audio',
        // CI runners (GitHub Actions) need the sandbox disabled.
        ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ],
    });
    this.page = await this.browser.newPage();
    const ua = await this.browser.userAgent();
    await this.page.setUserAgent(ua.replace(/HeadlessChrome/i, 'Chrome'));
    const response = await this.page.goto(BASE + WARMUP_PATH, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    if (!response || !response.ok()) {
      const status = response ? response.status() : 'no response';
      throw new Error(`Sofascore warmup request failed (${status}). The site may be blocking this machine.`);
    }
    return executablePath;
  }

  // Fetch a Sofascore API path (e.g. "/api/v1/event/123/votes") as parsed JSON.
  // Returns null on 404 (endpoint valid but no data); throws on other failures.
  async getJson(path) {
    const result = await this.page.evaluate(async (p) => {
      try {
        const res = await fetch(p, { headers: { Accept: 'application/json' } });
        if (res.status === 404) return { ok: true, data: null };
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, data: await res.json() };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    }, path);
    if (!result.ok) {
      throw new Error(`GET ${path} failed: ${result.status || result.error}`);
    }
    return result.data;
  }

  // Run getJson over many paths with limited concurrency and polite spacing.
  // Returns a Map of path -> data (missing entries failed; failures are collected, not thrown).
  async getMany(paths, onProgress) {
    const results = new Map();
    const errors = [];
    let next = 0;
    let done = 0;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const worker = async () => {
      while (next < paths.length) {
        const index = next++;
        const path = paths[index];
        try {
          results.set(path, await this.getJson(path));
        } catch (e) {
          errors.push({ path, error: e.message });
        }
        done++;
        if (onProgress) onProgress(done, paths.length);
        if (this.requestDelayMs) await delay(this.requestDelayMs);
      }
    };
    const workers = Array.from({ length: Math.min(this.concurrency, paths.length) }, worker);
    await Promise.all(workers);
    return { results, errors };
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}

module.exports = { BrowserClient, findChrome };
