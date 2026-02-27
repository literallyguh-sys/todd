# Todd Generator 3000 🎭

A meme creator with a community gallery, voting, and online hosting.

---

## 🚀 How to Deploy (Step by Step)

### Step 1 — Set up Supabase (database + image storage)

1. Go to **https://supabase.com** and create a free account
2. Click **"New Project"**, give it a name like `todd-generator`, set a password
3. Wait ~2 minutes for it to provision

**Create the database tables:**
4. In your project, go to **SQL Editor** (left sidebar)
5. Paste the entire contents of `supabase_setup.sql` and click **Run**

**Create the image storage bucket:**
6. Go to **Storage** (left sidebar)
7. Click **"New bucket"**, name it exactly: `gallery`
8. Check **"Public bucket"** ✓ (so images are publicly accessible)
9. Click **Create bucket**

**Get your API keys:**
10. Go to **Settings → API** (left sidebar)
11. Copy:
    - **Project URL** (looks like `https://xxxx.supabase.co`)
    - **anon public** key (long string starting with `eyJ...`)
    - Keep these — you'll need them in Step 3

---

### Step 2 — Push code to GitHub

1. Go to **https://github.com** and create a free account (if you don't have one)
2. Click **"New repository"**, name it `todd-generator`, make it **Public**
3. On your computer, open a terminal/command prompt in the `todd-project` folder
4. Run these commands:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/todd-generator.git
git push -u origin main
```

(Replace `YOUR_USERNAME` with your GitHub username)

---

### Step 3 — Deploy on Render (free hosting)

1. Go to **https://render.com** and create a free account
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account and select the `todd-generator` repo
4. Render will auto-detect the settings from `render.yaml`
5. Scroll down to **Environment Variables** and add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |

6. Click **"Create Web Service"**
7. Wait ~3 minutes for the first deploy
8. Your site will be live at: `https://todd-generator.onrender.com` (or similar)

---

## 📁 Project Structure

```
todd-project/
├── server.js              ← Express backend (API routes)
├── package.json           ← Node.js dependencies
├── render.yaml            ← Render deployment config
├── supabase_setup.sql     ← Run this in Supabase SQL Editor
├── .gitignore
└── public/
    ├── index.html         ← The full Todd Generator app
    └── bg-pattern.png     ← Background image
```

---

## 🔧 How it works

- **Frontend** (`public/index.html`): Konva.js canvas editor, gallery UI
- **Backend** (`server.js`): Express server with 3 API endpoints:
  - `GET /api/posts` — fetch all gallery posts (sorted by score)
  - `POST /api/posts` — publish a new post (uploads image to Supabase Storage)
  - `POST /api/vote` — vote up/down on a post (one vote per IP)
- **Database**: Supabase PostgreSQL stores post metadata and votes
- **Images**: Stored in Supabase Storage bucket "gallery"

---

## 💡 Notes

- Free Render tier spins down after 15 min of inactivity — first load may take ~30s
- Supabase free tier: 500MB database, 1GB storage — plenty for a gallery
- Votes are tracked by IP address
