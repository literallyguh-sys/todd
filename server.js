require("dotenv").config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase client ──
// These env vars are set in Render's dashboard (never hardcode them)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(express.json({ limit: '10mb' })); // images are large
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper: get visitor IP ──
function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/posts
// Returns all posts sorted by score, with the current user's vote attached
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  try {
    const ip = getIp(req);

    // Fetch all posts
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, name, msg, image_url, date, up, down')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch this user's votes
    const { data: votes } = await supabase
      .from('votes')
      .select('post_id, dir')
      .eq('voter_ip', ip);

    const myVoteMap = {};
    (votes || []).forEach(v => { myVoteMap[v.post_id] = v.dir; });

    // Attach myVote and sort by score
    const enriched = posts.map(p => ({ ...p, myVote: myVoteMap[p.id] || null }));
    enriched.sort((a, b) => (b.up - b.down) - (a.up - a.down));

    res.json(enriched);
  } catch (err) {
    console.error('GET /api/posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/posts
// Publishes a new post. Expects { name, msg, image } (image = base64 dataURL)
// Saves the image to Supabase Storage, stores metadata in DB
// ────────────────────────────────────────────────────────────────────────────
app.post('/api/posts', async (req, res) => {
  try {
    const { name, msg, image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    // Decode base64 image
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const filename = `post_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`;

    // Upload to Supabase Storage bucket "gallery"
    const { error: uploadError } = await supabase.storage
      .from('gallery')
      .upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });

    if (uploadError) throw uploadError;

    // Get the public URL
    const { data: urlData } = supabase.storage.from('gallery').getPublicUrl(filename);
    const imageUrl = urlData.publicUrl;

    // Insert post record
    const { data: post, error: insertError } = await supabase
      .from('posts')
      .insert({
        name:      name || 'Anonymous',
        msg:       msg  || '',
        image_url: imageUrl,
        date:      new Date().toISOString(),
        up:        0,
        down:      0
      })
      .select()
      .single();

    if (insertError) throw insertError;

    console.log(`[NEW POST] "${post.name}" — ${post.id}`);
    res.json({ ok: true, id: post.id });
  } catch (err) {
    console.error('POST /api/posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/vote
// { postId, dir: 'up'|'down' }
// One vote per IP per post. Changing vote undoes the previous one.
// ────────────────────────────────────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  try {
    const { postId, dir } = req.body;
    const ip = getIp(req);

    if (!postId || !['up', 'down'].includes(dir)) {
      return res.status(400).json({ error: 'Bad request' });
    }

    // Check for existing vote
    const { data: existing } = await supabase
      .from('votes')
      .select('id, dir')
      .eq('post_id', postId)
      .eq('voter_ip', ip)
      .single();

    const prev = existing ? existing.dir : null;
    if (prev === dir) {
      // Already voted this way — return current counts unchanged
      const { data: post } = await supabase.from('posts').select('up, down').eq('id', postId).single();
      return res.json({ ok: true, up: post.up, down: post.down, myVote: dir });
    }

    // Build the score delta
    let upDelta = 0, downDelta = 0;
    if (prev === 'up')   upDelta--;
    if (prev === 'down') downDelta--;
    if (dir  === 'up')   upDelta++;
    if (dir  === 'down') downDelta++;

    // Fetch current post counts
    const { data: post, error: fetchErr } = await supabase
      .from('posts').select('up, down').eq('id', postId).single();
    if (fetchErr) throw fetchErr;

    const newUp   = Math.max(0, post.up   + upDelta);
    const newDown = Math.max(0, post.down + downDelta);

    // Update post
    await supabase.from('posts').update({ up: newUp, down: newDown }).eq('id', postId);

    // Upsert vote record
    if (existing) {
      await supabase.from('votes').update({ dir }).eq('id', existing.id);
    } else {
      await supabase.from('votes').insert({ post_id: postId, voter_ip: ip, dir });
    }

    console.log(`[VOTE] ${ip} voted ${dir} on ${postId}`);
    res.json({ ok: true, up: newUp, down: newDown, myVote: dir });
  } catch (err) {
    console.error('POST /api/vote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/login
// Validates the admin password. Returns a signed session token.
// ────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const ADMIN_SESSIONS = new Set(); // in-memory session tokens

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  ADMIN_SESSIONS.add(token);
  res.json({ ok: true, token });
});

// Middleware to protect admin routes
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !ADMIN_SESSIONS.has(token)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/admin/posts
// Returns ALL posts (approved and pending) for admin review
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('gallery_posts')
      .select('id, name, message, image, created_at, votes_up, votes_down, approved')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/approve/:id
// Approves a post
// ────────────────────────────────────────────────────────────────────────────
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('gallery_posts')
      .update({ approved: true })
      .eq('id', req.params.id);
    if (error) throw error;
    console.log(`[ADMIN] Approved post ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/posts/:id
// Permanently deletes a post
// ────────────────────────────────────────────────────────────────────────────
app.delete('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('gallery_posts')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    console.log(`[ADMIN] Deleted post ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Scanner engine — runs every 3 min server-side, one scan serves all clients
// ────────────────────────────────────────────────────────────────────────────
const DS_API        = 'https://api.dexscreener.com';
const RC_API        = 'https://api.rugcheck.xyz/v1';
const SCAN_INTERVAL = 3 * 60 * 1000;
const TICKER_TTL    = 10 * 60 * 1000;
const BUNDLE_MAX_PCT = 10;
const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

let scanCache  = { pf: [], ps: [], cert: [], lastUpdated: 0, scanning: false };
let tickerCache = []; // [{address,ticker,icon,url,seenAt}]
let prevProfileAddresses = new Set();

function scanDelay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scanFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function isRiskyToken(report) {
  const risks = report.risks || [];
  // creator/deployer flag
  if (risks.some(r => {
    const n = (r.name || '').toLowerCase();
    return n.includes('creator') || n.includes('deployer');
  })) return true;
  // insider danger
  if (risks.some(r => {
    const n = (r.name || '').toLowerCase();
    return n.includes('insider') && r.level === 'danger';
  })) return true;
  return false;
}

async function heliusRpc(method, params) {
  if (!HELIUS_RPC) throw new Error('No Helius RPC configured');
  const r = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!r.ok) throw new Error('Helius HTTP ' + r.status);
  const json = await r.json();
  if (json.error) throw new Error('Helius RPC: ' + JSON.stringify(json.error));
  return json.result;
}

async function detectBundle(mintAddress) {
  try {
    // 1. Paginate signatures (up to 10 pages × 1000)
    let allSigs = [];
    let before;
    for (let page = 0; page < 10; page++) {
      const opts = { limit: 1000 };
      if (before) opts.before = before;
      const sigs = await heliusRpc('getSignaturesForAddress', [mintAddress, opts]);
      const valid = (sigs || []).filter(s => !s.err);
      allSigs = allSigs.concat(valid);
      if ((sigs || []).length < 1000) break;
      if (page === 9) return null; // >10k txns — inconclusive
      before = sigs[sigs.length - 1].signature;
    }

    // 2. Reverse to chronological, take first 100 (launch txns)
    allSigs.reverse();
    const launchSigs = allSigs.slice(0, 100);
    if (!launchSigs.length) return null;

    // 3. Batch-fetch transactions
    const batch = launchSigs.map((s, i) => ({
      jsonrpc: '2.0', id: i,
      method: 'getTransaction',
      params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    }));
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    });
    if (!r.ok) throw new Error('Helius batch HTTP ' + r.status);
    const txResponses = await r.json();

    // 4. Group buyers by slot
    const slotBuyers = new Map(); // slot → Set<wallet>
    for (const resp of (Array.isArray(txResponses) ? txResponses : [])) {
      const tx = resp.result;
      if (!tx) continue;
      const slot = tx.slot;
      const pre  = tx.meta?.preTokenBalances  || [];
      const post = tx.meta?.postTokenBalances || [];
      for (const b of post) {
        if (b.mint !== mintAddress || !b.owner) continue;
        const preEntry = pre.find(p => p.accountIndex === b.accountIndex);
        const preAmt  = preEntry?.uiTokenAmount?.uiAmount || 0;
        const postAmt = b.uiTokenAmount?.uiAmount || 0;
        if (postAmt > preAmt) {
          if (!slotBuyers.has(slot)) slotBuyers.set(slot, new Set());
          slotBuyers.get(slot).add(b.owner);
        }
      }
    }

    // 5. Bundle wallets = wallets in slots with ≥2 distinct buyers
    const bundleWallets = new Set();
    for (const [, wallets] of slotBuyers)
      if (wallets.size >= 2) for (const w of wallets) bundleWallets.add(w);

    if (!bundleWallets.size) return 0;

    // 6. Total supply
    const supplyResult = await heliusRpc('getTokenSupply', [mintAddress]);
    const totalSupply = supplyResult?.value?.uiAmount || 0;
    if (!totalSupply) return null;

    // 7. Sum current holdings for bundle wallets (5 concurrent)
    let bundleTotal = 0;
    const walletArr = [...bundleWallets];
    for (let i = 0; i < walletArr.length; i += 5) {
      await Promise.all(walletArr.slice(i, i + 5).map(async wallet => {
        try {
          const res = await heliusRpc('getTokenAccountsByOwner', [
            wallet, { mint: mintAddress }, { encoding: 'jsonParsed' }
          ]);
          for (const acc of (res?.value || []))
            bundleTotal += acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
        } catch (e) {}
      }));
    }

    return Math.round((bundleTotal / totalSupply) * 1000) / 10;
  } catch (e) {
    console.warn('[bundle] detection failed for', mintAddress, ':', e.message);
    return null;
  }
}

async function runScan() {
  if (scanCache.scanning) return;
  scanCache.scanning = true;
  console.log('[scan] Starting...');
  try {
    // Fetch paid profiles + boosts in parallel
    const [a, b] = await Promise.allSettled([
      scanFetch(`${DS_API}/token-profiles/latest/v1`),
      scanFetch(`${DS_API}/token-boosts/latest/v1`)
    ]);
    const tokens = [], seen = new Set();
    const addTokens = arr => {
      if (!Array.isArray(arr)) return;
      for (const t of arr)
        if (t.chainId === 'solana' && t.tokenAddress && !seen.has(t.tokenAddress)) {
          seen.add(t.tokenAddress); tokens.push(t);
        }
    };
    if (a.status === 'fulfilled') addTokens(a.value);
    if (b.status === 'fulfilled') addTokens(b.value);

    const profileByAddr = new Map(tokens.map(t => [t.tokenAddress, t]));
    const now = Date.now();

    // ── Update DEX PAID ticker with newly profiled tokens ──────────────────
    if (prevProfileAddresses.size > 0) {
      const newEntries = tokens
        .filter(t => !prevProfileAddresses.has(t.tokenAddress))
        .map(t => ({
          address: t.tokenAddress,
          ticker:  t.tokenAddress.slice(0, 6), // updated below with real symbol
          icon:    t.icon || '',
          url:     t.url || `https://dexscreener.com/solana/${t.tokenAddress}`,
          seenAt:  now
        }));
      if (newEntries.length) {
        tickerCache = [...newEntries, ...tickerCache];
        console.log(`[scan] ${newEntries.length} new DEX PAID entries`);
      }
    }
    prevProfileAddresses = new Set(tokens.map(t => t.tokenAddress));
    tickerCache = tickerCache.filter(e => now - e.seenAt < TICKER_TTL);

    // ── Phase 1: batch DexScreener — 30 addresses per call ─────────────────
    const DS_BATCH = 30;
    const candidates = [];      // [{profile,pair}] passing mcap+dex filter
    const tickerInfoMap = new Map(); // address → {ticker,icon} for strip updates

    for (let i = 0; i < tokens.length; i += DS_BATCH) {
      const addrs = tokens.slice(i, i + DS_BATCH).map(t => t.tokenAddress);
      try {
        const data = await scanFetch(`${DS_API}/latest/dex/tokens/${addrs.join(',')}`);
        for (const pair of (data.pairs || [])) {
          const mc   = pair.marketCap || pair.fdv || 0;
          const addr = pair.baseToken?.address || '';
          if (pair.chainId !== 'solana' || !addr) continue;

          // Collect real ticker symbols for the DEX PAID strip
          if (pair.baseToken?.symbol)
            tickerInfoMap.set(addr, {
              ticker: pair.baseToken.symbol,
              icon:   pair.info?.imageUrl || pair.baseToken?.imageUrl || ''
            });

          const profile = profileByAddr.get(addr);
          if (!profile) continue;
          if      (pair.dexId === 'pumpfun'  && mc >= 5000  && mc < 33000)  candidates.push({ profile, pair });
          else if (pair.dexId === 'pumpswap' && mc >= 10000 && mc < 100000) candidates.push({ profile, pair });
        }
      } catch (e) { console.warn('[scan] DS batch error:', e.message); }
      if (i + DS_BATCH < tokens.length) await scanDelay(300);
    }

    // Patch ticker entries with real symbols from DexScreener data
    tickerCache = tickerCache.map(e => {
      const info = tickerInfoMap.get(e.address);
      return info ? { ...e, ticker: info.ticker, icon: e.icon || info.icon } : e;
    });

    // ── Pass 1: parallel rugcheck — 5 concurrent ───────────────────────────
    const pass1 = [];
    const RC_BATCH = 5;
    for (let i = 0; i < candidates.length; i += RC_BATCH) {
      await Promise.all(candidates.slice(i, i + RC_BATCH).map(async ({ profile, pair }) => {
        try {
          const report = await scanFetch(`${RC_API}/tokens/${profile.tokenAddress}/report`);
          if (!isRiskyToken(report)) {
            const mc = pair.marketCap || pair.fdv || 0;
            pass1.push({
              address: profile.tokenAddress,
              name:    pair.baseToken?.name   || profile.tokenAddress.slice(0, 8),
              ticker:  pair.baseToken?.symbol || '???',
              icon:    profile.icon || pair.info?.imageUrl || pair.baseToken?.imageUrl || '',
              mcap:    mc,
              h1:      pair.priceChange?.h1 ?? null,
              url:     pair.url || profile.url || '',
              dex:     pair.dexId
            });
          }
        } catch (e) {}
      }));
    }
    console.log(`[scan] Pass 1 done — ${pass1.length} tokens. Starting pass 2 (Helius)...`);

    // ── Pass 2: Helius bundle detection — 3 concurrent ─────────────────────
    const newPf = [], newPs = [];
    if (HELIUS_RPC) {
      for (let i = 0; i < pass1.length; i += 3) {
        await Promise.all(pass1.slice(i, i + 3).map(async entry => {
          const bundlePct = await detectBundle(entry.address);
          if (bundlePct !== null && bundlePct >= BUNDLE_MAX_PCT) {
            console.log(`[bundle] Filtered ${entry.ticker}: ${bundlePct}%`);
            return;
          }
          const out = { ...entry, bundlePct };
          if (entry.dex === 'pumpfun') newPf.push(out);
          else                         newPs.push(out);
        }));
      }
    } else {
      for (const entry of pass1) {
        const out = { ...entry, bundlePct: null };
        if (entry.dex === 'pumpfun') newPf.push(out);
        else                         newPs.push(out);
      }
    }

    scanCache = { pf: newPf, ps: newPs, lastUpdated: Date.now(), scanning: false };
    console.log(`[scan] Done — ${newPf.length} pump.fun, ${newPs.length} pumpswap`);
  } catch (e) {
    console.error('[scan] Error:', e.message);
    scanCache.scanning = false;
  }
}

app.get('/api/scan-results', (req, res) => {
  res.json({ pf: scanCache.pf, ps: scanCache.ps, lastUpdated: scanCache.lastUpdated, scanning: scanCache.scanning });
});

app.get('/api/ticker', (req, res) => {
  const now = Date.now();
  res.json(tickerCache.filter(e => now - e.seenAt < TICKER_TTL));
});

// ── Catch-all: serve the app ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Todd Generator running on http://localhost:${PORT}`);
  // Start scan engine — first run immediately, then every 3 minutes
  runScan();
  setInterval(runScan, SCAN_INTERVAL);

  // ── Keep-alive ping ──
  // Pings the server every 10 minutes so Render's free tier never goes to sleep.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    const https = SELF_URL.startsWith('https') ? require('https') : require('http');
    https.get(SELF_URL + '/ping', (res) => {
      console.log(`[keep-alive] ping → ${res.statusCode}`);
    }).on('error', (e) => {
      console.warn(`[keep-alive] ping failed: ${e.message}`);
    });
  }, 10 * 60 * 1000); // every 10 minutes
});

// Simple ping endpoint for the keep-alive
app.get('/ping', (req, res) => res.send('pong'));