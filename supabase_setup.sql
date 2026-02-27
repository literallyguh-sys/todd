-- ============================================================
-- Todd Generator 3000 — Supabase Database Setup
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT 'Anonymous',
  msg         text NOT NULL DEFAULT '',
  image_url   text NOT NULL,
  date        timestamptz NOT NULL DEFAULT now(),
  up          integer NOT NULL DEFAULT 0,
  down        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Votes table (one per IP per post)
CREATE TABLE IF NOT EXISTS votes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  voter_ip    text NOT NULL,
  dir         text NOT NULL CHECK (dir IN ('up', 'down')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(post_id, voter_ip)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_votes_post_ip ON votes(post_id, voter_ip);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- Enable Row Level Security (keep data safe)
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read posts (public gallery)
CREATE POLICY "Public read posts" ON posts FOR SELECT USING (true);

-- Allow server (service role) to insert/update posts and votes
-- The anon key used server-side with RLS bypass is fine since Express is the only writer
CREATE POLICY "Server insert posts" ON posts FOR INSERT WITH CHECK (true);
CREATE POLICY "Server update posts" ON posts FOR UPDATE USING (true);
CREATE POLICY "Server insert votes" ON votes FOR INSERT WITH CHECK (true);
CREATE POLICY "Server update votes" ON votes FOR UPDATE USING (true);
CREATE POLICY "Server read votes"   ON votes FOR SELECT USING (true);
