#!/usr/bin/env node
'use strict';
/**
 * Dependency security checker.
 *
 * Blocking rules (exit 1):
 *   - Package first published < MIN_PACKAGE_AGE_DAYS ago (brand-new / typosquat risk)
 *   - npm audit reports HIGH or CRITICAL vulnerabilities
 *
 * Warnings (non-blocking):
 *   - Latest version published < MIN_VERSION_AGE_DAYS ago (recently changed — verify intent)
 *   - Registry fetch failed for a package (network issue or scoped private package)
 *
 * Requires Node 18+ (built-in fetch).
 * Run: node scripts/check-deps.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Thresholds ─────────────────────────────────────────────────────────────────

const MIN_PACKAGE_AGE_DAYS = 14;  // package must exist for at least this long
const MIN_VERSION_AGE_DAYS = 3;   // latest published version must be at least this old
const REGISTRY = 'https://registry.npmjs.org';

// ── Helpers ────────────────────────────────────────────────────────────────────

function ageInDays(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}

async function fetchRegistry(name) {
  const encoded = name.startsWith('@')
    ? name.replace('/', '%2F')
    : encodeURIComponent(name);
  const res = await fetch(`${REGISTRY}/${encoded}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from registry`);
  return res.json();
}

function readPackageJson() {
  const pkgPath = path.resolve('package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('package.json not found. Run from the project root.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const pkg = readPackageJson();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const names = Object.keys(deps);

  if (names.length === 0) {
    console.log('No dependencies found.');
    process.exit(0);
  }

  console.log(`\nChecking ${names.length} package(s) against ${REGISTRY}...\n`);

  const issues = [];    // blocking — will exit 1
  const warnings = [];  // non-blocking — printed but don't fail

  for (const name of names) {
    process.stdout.write(`  ${name} ... `);
    try {
      const info = await fetchRegistry(name);
      const created = info.time?.created;
      const latest = info['dist-tags']?.latest;
      const latestPublished = latest ? info.time?.[latest] : null;
      const flags = [];

      if (created) {
        const packageAge = ageInDays(created);
        if (packageAge < MIN_PACKAGE_AGE_DAYS) {
          issues.push(
            `[YOUNG PACKAGE] "${name}" — first published ${packageAge.toFixed(1)} days ago ` +
            `(${created.slice(0, 10)}). Minimum is ${MIN_PACKAGE_AGE_DAYS} days. ` +
            `Risk: typosquatting / supply-chain attack.`
          );
          flags.push(`YOUNG (${packageAge.toFixed(0)}d)`);
        }
      }

      if (latestPublished) {
        const versionAge = ageInDays(latestPublished);
        if (versionAge < MIN_VERSION_AGE_DAYS) {
          warnings.push(
            `[RECENT RELEASE] "${name}@${latest}" was published ${versionAge.toFixed(1)} days ago ` +
            `(${latestPublished.slice(0, 10)}). Verify this release is legitimate before upgrading.`
          );
          flags.push(`RECENT v${latest} (${versionAge.toFixed(0)}d)`);
        }
      }

      console.log(flags.length ? `⚠  ${flags.join(', ')}` : 'OK');
    } catch (err) {
      console.log(`skipped (${err.message})`);
      warnings.push(`[SKIPPED] "${name}": registry check failed — ${err.message}`);
    }
  }

  // ── npm audit ────────────────────────────────────────────────────────────────

  console.log('\nRunning npm audit --audit-level=high ...\n');
  let auditFailed = false;
  try {
    execSync('npm audit --audit-level=high', { stdio: 'inherit' });
  } catch {
    auditFailed = true;
    issues.push(
      '[VULNERABILITIES] npm audit found HIGH or CRITICAL vulnerabilities. ' +
      'Run "npm audit" for details, or "npm audit fix" to auto-patch.'
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log();

  if (warnings.length) {
    console.warn('── Warnings (non-blocking) ──────────────────────────────────────────');
    warnings.forEach((w) => console.warn(' ⚠', w));
    console.log();
  }

  if (issues.length) {
    console.error('── Blocking Issues ──────────────────────────────────────────────────');
    issues.forEach((issue) => console.error(' ✗', issue));
    console.error(
      `\n${issues.length} blocking issue(s) found. ` +
      'Resolve before adding or upgrading these packages.\n'
    );
    process.exit(1);
  }

  console.log('All checks passed ✓\n');
}

main().catch((err) => {
  console.error('\ncheck-deps crashed:', err.message);
  process.exit(1);
});
