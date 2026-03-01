// autopush.js — watches for file changes and auto-commits + pushes to GitHub
// Usage: node autopush.js

const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const WATCH_PATHS = ['public', 'server.js'];
const DEBOUNCE_MS = 3000; // wait 3s after last change before committing

let timer = null;
let pending = new Set();

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.log(stderr.trim());
      if (err) reject(err); else resolve();
    });
  });
}

async function commitAndPush(files) {
  const label = [...files].join(', ');
  const msg   = `auto: ${new Date().toISOString().slice(0,19).replace('T',' ')}`;
  console.log(`\n[autopush] Changes detected: ${label}`);
  console.log(`[autopush] Committing: "${msg}"`);
  try {
    await run('git add -A');
    await run(`git diff --cached --quiet || git commit -m "${msg}"`);
    await run('git push');
    console.log('[autopush] Pushed to GitHub. Render will deploy shortly.\n');
  } catch (e) {
    console.error('[autopush] Git error:', e.message);
  }
}

function onChange(filename) {
  if (!filename) return;
  pending.add(filename);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const files = new Set(pending);
    pending.clear();
    commitAndPush(files);
  }, DEBOUNCE_MS);
}

// Watch each path
WATCH_PATHS.forEach(p => {
  const full = path.join(__dirname, p);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    fs.watch(full, { recursive: true }, (_, filename) => onChange(filename));
    console.log(`[autopush] Watching directory: ${p}/`);
  } else {
    fs.watch(full, (_, filename) => onChange(filename || p));
    console.log(`[autopush] Watching file: ${p}`);
  }
});

console.log('[autopush] Ready. Save any file to trigger a deploy.\n');
