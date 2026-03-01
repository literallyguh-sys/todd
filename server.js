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

// ── Catch-all: serve the app ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Todd Generator running on http://localhost:${PORT}`);

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