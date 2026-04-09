# ============================================================
#  NEXASTRA AI CLIENT HUNTING AGENT — CONFIGURATION
# ============================================================

# ---------- OpenStreetMap ----------
# (100% Free - No API Key Required)

# ---------- Google Gemini AI ----------
GEMINI_API_KEY=YOUR_GEMINI_API_KEY

# ---------- Gmail OAuth2 ----------
GMAIL_CLIENT_ID=YOUR_GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET=YOUR_GMAIL_CLIENT_SECRET
GMAIL_REDIRECT_URI=http://localhost:3001/auth/callback
GMAIL_REFRESH_TOKEN=YOUR_GMAIL_REFRESH_TOKEN

# ---------- Your Business Info ----------
YOUR_NAME= M.irtaza
YOUR_COMPANY=Nexastra
YOUR_EMAIL=irtazamir728@gmail.com
YOUR_WEBSITE=https://yourwebsite.com
YOUR_PHONE=+923125186728

# ---------- Target Locations ----------
TARGET_LOCATIONS=uae,australia,canada

# ---------- Target Niches ----------
TARGET_NICHES=restaurants,salons,gyms,real estate agencies,dental clinics,law firms,auto repair shops,spas,tutoring centers,pet grooming

# ---------- Scheduler ----------
DISCOVERY_CRON=0 9 * * *
FOLLOW_UP_CRON=0 14 * * *
DAILY_LIMIT=50

# ---------- Server ----------
PORT=3001
