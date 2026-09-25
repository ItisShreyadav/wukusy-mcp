#!/usr/bin/env node
// Opens Chrome at the Wukusy login page; you log in by hand, and the session cookie is
// saved for the MCP server. The password never touches this script.
import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { SESSION_FILE } from './client.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://wukusy.app/login');
console.log('Log in to Wukusy in the Chrome window that just opened. Waiting up to 5 minutes...');
await page.waitForURL(/\/dropshiper\//, { timeout: 5 * 60_000 });
await mkdir(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
await context.storageState({ path: SESSION_FILE });
await chmod(SESSION_FILE, 0o600);
console.log(`Session saved to ${SESSION_FILE}`);
await browser.close();
