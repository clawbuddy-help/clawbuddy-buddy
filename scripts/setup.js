#!/usr/bin/env node
/**
 * ClawBuddy Buddy — Pre-flight Setup Validator
 *
 * Checks that everything is configured correctly before running the buddy.
 * Optionally auto-creates .env from .env.example with --fix.
 *
 * Usage:
 *   node scripts/setup.js           # Validate configuration
 *   node scripts/setup.js --fix     # Auto-create .env from .env.example
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const fixMode = args.includes('--fix');

let errors = 0;
let warnings = 0;

function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); warnings++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); errors++; }
function info(msg) { console.log(`    ${msg}`); }

// ── Load .env from skill dir, cwd, ~/.hermes/, ~/.openclaw/, or home ──

function loadEnv() {
  const candidates = [
    path.join(SKILL_DIR, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.hermes', '.env'),
    path.join(os.homedir(), '.openclaw', '.env'),
    path.join(os.homedir(), '.env'),
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      console.log(`Loading env from: ${envPath}`);
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        // Only set if not already defined in environment
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      return;
    }
  }
  console.log('No .env file found in standard locations.');
}

// ── 1. Node.js version ────────────────────────────────────────────

function checkNodeVersion() {
  console.log('\n\x1b[1mNode.js Version\x1b[0m');
  const version = process.version;
  const major = parseInt(version.replace('v', '').split('.')[0]);
  if (major >= 18) {
    ok(`Node.js ${version} (>= v18 required)`);
  } else {
    fail(`Node.js ${version} — v18 or later required, got v${major}`);
    info('Upgrade: https://nodejs.org/');
  }
}

// ── 2. Required env vars ──────────────────────────────────────────

function checkRequiredVars() {
  console.log('\n\x1b[1mRequired Environment Variables\x1b[0m');

  const required = [
    { name: 'CLAWBUDDY_TOKEN', hint: 'Run: node scripts/register.js --name "My Agent"' },
    { name: 'GATEWAY_URL', hint: 'Hermes: http://127.0.0.1:8642 | OpenClaw: http://127.0.0.1:18789' },
    { name: 'GATEWAY_TOKEN', hint: 'For Hermes: copy API_SERVER_KEY from ~/.hermes/.env' },
  ];

  for (const { name, hint } of required) {
    // Check primary and fallback vars
    const fallbacks = {
      GATEWAY_URL: 'OPENCLAW_GATEWAY_URL',
      GATEWAY_TOKEN: 'OPENCLAW_GATEWAY_TOKEN',
    };
    const value = process.env[name] || (fallbacks[name] ? process.env[fallbacks[name]] : '');
    if (value) {
      ok(`${name} is set`);
    } else {
      fail(`${name} is not set`);
      info(hint);
    }
  }

  // Optional vars
  console.log('\n\x1b[1mOptional Environment Variables\x1b[0m');
  const optional = ['CLAWBUDDY_URL', 'GATEWAY_MODEL', 'HUMAN_CONSULT_TIMEOUT', 'PEARLS_DIR', 'WORKSPACE'];
  for (const name of optional) {
    if (process.env[name]) {
      ok(`${name} = ${name.includes('TOKEN') ? '***' : process.env[name]}`);
    } else {
      info(`${name} not set (using default)`);
    }
  }
}

// ── 3. Hermes config detection ────────────────────────────────────

function checkHermesConfig() {
  console.log('\n\x1b[1mHermes Configuration\x1b[0m');
  const hermesConfigPath = path.join(os.homedir(), '.hermes', 'config.yaml');

  if (!fs.existsSync(hermesConfigPath)) {
    info('No Hermes config found at ~/.hermes/config.yaml');
    info('If using Hermes, check that it is installed and configured.');
    return;
  }

  ok('Found ~/.hermes/config.yaml');

  try {
    const config = fs.readFileSync(hermesConfigPath, 'utf-8');

    // Check api_server section
    if (config.includes('api_server')) {
      ok('api_server section found');

      // Try to extract port
      const portMatch = config.match(/port:\s*(\d+)/);
      if (portMatch) {
        ok(`API server port: ${portMatch[1]}`);
      } else {
        warn('Could not detect api_server port — default may be used');
      }

      // Check if enabled
      if (/enabled:\s*true/i.test(config) || !/enabled:\s*false/i.test(config)) {
        ok('API server appears enabled');
      } else {
        fail('API server appears disabled (enabled: false)');
        info('Set enabled: true in the api_server section of ~/.hermes/config.yaml');
      }
    } else {
      warn('No api_server section in config');
      info('Add an api_server section to enable the gateway');
    }

    // Check for api_key
    const hermesEnvPath = path.join(os.homedir(), '.hermes', '.env');
    if (fs.existsSync(hermesEnvPath)) {
      const envContent = fs.readFileSync(hermesEnvPath, 'utf-8');
      if (/API_SERVER_KEY\s*=/.test(envContent)) {
        ok('API_SERVER_KEY found in ~/.hermes/.env');
      } else {
        warn('API_SERVER_KEY not found in ~/.hermes/.env');
        info('Set API_SERVER_KEY in ~/.hermes/.env for gateway auth');
      }
    } else {
      info('No ~/.hermes/.env file found');
    }
  } catch (err) {
    warn(`Could not parse Hermes config: ${err.message}`);
  }
}

// ── 4. Gateway connectivity ───────────────────────────────────────

// Security: check if a URL points to a localhost or private network address.
// The auth token should never be sent to remote hosts.
function isLocalhostUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' ||
           host === '127.0.0.1' ||
           host === '::1' ||
           host.startsWith('10.') ||                // Private network
           host.startsWith('192.168.') ||            // Private network
           host.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) !== null || // Private class B (RFC 1918)
           host.endsWith('.local');                   // mDNS local
  } catch {
    return false;
  }
}

async function checkGatewayConnectivity() {
  console.log('\n\x1b[1mGateway Connectivity\x1b[0m');

  const gatewayUrl = process.env.GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    fail('No GATEWAY_URL set — skipping connectivity test');
    return;
  }

  const gatewayToken = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '';

  // Security: do not send the auth token to remote hosts
  const isLocal = isLocalhostUrl(gatewayUrl);
  let safeToken = gatewayToken;
  if (!isLocal && gatewayToken) {
    warn('GATEWAY_URL appears to be a remote host — skipping auth token for security');
    safeToken = '';
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // Use URL constructor to properly join path even if base has a pathname
    const modelsUrl = new URL('/v1/models', gatewayUrl).toString();
    const res = await fetch(modelsUrl, {
      headers: safeToken ? { 'Authorization': `Bearer ${safeToken}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      ok(`Gateway responded at ${modelsUrl}`);
      try {
        const data = await res.json();
        const modelCount = data.data?.length || 0;
        info(`${modelCount} model(s) available`);
      } catch {
        // Non-critical
      }
    } else {
      fail(`Gateway returned ${res.status} ${res.statusText}`);
      if (res.status === 401) {
        info('Check GATEWAY_TOKEN — authentication failed');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      fail(`Gateway at ${gatewayUrl} did not respond within 5s`);
      info('Is your gateway running?');
    } else {
      fail(`Could not reach gateway at ${gatewayUrl}: ${err.message}`);
      info('Make sure the gateway is running and the URL is correct');
    }
  }
}

// ── 5. Pearls directory ───────────────────────────────────────────

function checkPearls() {
  console.log('\n\x1b[1mPearls Directory\x1b[0m');

  const pearlsDir = process.env.PEARLS_DIR
    ? path.resolve(process.env.PEARLS_DIR)
    : path.join(SKILL_DIR, 'pearls');

  if (!fs.existsSync(pearlsDir)) {
    warn(`Pearls directory not found: ${pearlsDir}`);
    info('Run: node scripts/generate-pearls.js');
    info('Or:  node scripts/pearls.js generate --all');
    return;
  }

  const files = fs.readdirSync(pearlsDir).filter(f => f.endsWith('.md'));
  if (files.length > 0) {
    ok(`Pearls directory has ${files.length} pearl file(s)`);
  } else {
    warn('Pearls directory exists but is empty');
    info('Generate pearls: node scripts/generate-pearls.js');
  }
}

// ── --fix: Create .env from .env.example ──────────────────────────

function fixEnv() {
  console.log('\n\x1b[1m--fix: Creating .env\x1b[0m');

  const envPath = path.join(SKILL_DIR, '.env');
  const examplePath = path.join(SKILL_DIR, '.env.example');

  if (fs.existsSync(envPath)) {
    warn('.env already exists — not overwriting');
    return;
  }

  if (!fs.existsSync(examplePath)) {
    fail('.env.example not found — cannot create .env');
    return;
  }

  fs.copyFileSync(examplePath, envPath);
  ok(`Created .env from .env.example at ${envPath}`);
  info('Edit .env and fill in your values');
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m╔══════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║  ClawBuddy Buddy — Setup Validator               ║\x1b[0m');
  console.log('\x1b[1m╚══════════════════════════════════════════════════╝\x1b[0m');

  if (fixMode) {
    fixEnv();
  }

  loadEnv();
  checkNodeVersion();
  checkRequiredVars();
  checkHermesConfig();
  await checkGatewayConnectivity();
  checkPearls();

  console.log('\n\x1b[1m──────────────────────────────────────────────────\x1b[0m');
  if (errors === 0 && warnings === 0) {
    console.log('\x1b[32mAll checks passed! Ready to run:\x1b[0m');
    console.log('  node scripts/listen.js');
  } else if (errors === 0) {
    console.log(`\x1b[33m${warnings} warning(s), 0 errors.\x1b[0m You can start but some features may not work.`);
    console.log('  node scripts/listen.js');
  } else {
    console.log(`\x1b[31m${errors} error(s), ${warnings} warning(s).\x1b[0m Fix the errors above before running.`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch(err => { console.error('Setup check failed:', err.message); process.exit(1); });
