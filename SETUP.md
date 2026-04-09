# 🚀 Nexastra AI Client Hunting Agent — Setup Guide

## API Keys You Need (3 total)

---

### 1️⃣ Google Maps Places API Key

**What it does:** Lets the agent search for businesses on Google Maps.

**How to get it:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **"Places API (New)"** and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **+ CREATE CREDENTIALS → API Key**
7. Copy the API key
8. *(Optional but recommended)* Click "Edit API Key" → restrict it to "Places API (New)" only

**Cost:** Google gives you $200/month free credit. Each search costs ~$0.032, so you can do ~6,000 searches/month for free.

---

### 2️⃣ Google Gemini API Key

**What it does:** Powers the AI brain — analyzes websites, scores leads, decides the right service, and writes personalized emails.

**How to get it:**
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Select your Google Cloud project (or create one)
5. Copy the API key

**Cost:** Gemini Flash is free for up to 15 requests/minute. More than enough for this agent.

---

### 3️⃣ Gmail OAuth2 Credentials

**What it does:** Lets the agent send emails from your Gmail account.

**How to get it:**

#### Step A: Create OAuth Credentials
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Make sure you're in the same project as step 1
3. Go to **APIs & Services → Library**, search for **"Gmail API"** and **Enable** it
4. Go to **APIs & Services → OAuth consent screen**
   - Choose **"External"** user type
   - Fill in app name: "Nexastra Client Hunter"
   - Add your email as test user
   - Save
5. Go to **Credentials → + CREATE CREDENTIALS → OAuth 2.0 Client ID**
   - Application type: **"Web application"**
   - Name: "Nexastra Client Hunter"
   - Authorized redirect URIs: `http://localhost:3000/auth/callback`
   - Click Create
6. Copy the **Client ID** and **Client Secret**

#### Step B: Get Refresh Token
1. Start the agent: `npm start`
2. Open `http://localhost:3000` in your browser
3. Click the **"Connect Gmail"** button on the dashboard
4. Sign in with your Google account and grant permissions
5. The refresh token will be saved automatically to your `.env` file

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template
cp .env.example .env

# 3. Fill in your API keys in .env

# 4. Start the agent
npm start

# 5. Open the dashboard
# http://localhost:3000
```

---

## How It Works

```
┌─────────────────────────────────────────────────┐
│          DAILY AUTOMATED PIPELINE               │
│                                                 │
│  1. 🔍 Discover leads on Google Maps            │
│  2. 📊 Score & qualify each lead (AI)           │
│  3. 🧠 Decide: AI Agent or WhatsApp solution    │
│  4. ✉️  Generate personalized email pitch (AI)  │
│  5. 📤 Send via Gmail                           │
│  6. 📋 Track everything in dashboard            │
│  7. 🔄 Follow up automatically                  │
└─────────────────────────────────────────────────┘
```

## Troubleshooting

- **"API key not valid"** → Make sure you enabled the correct APIs in Google Cloud Console
- **"Gmail auth failed"** → Re-connect Gmail from the dashboard
- **"Rate limit exceeded"** → Reduce `DAILY_LIMIT` in `.env`
