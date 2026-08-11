# SomLuul — Ready to deploy

## Core app: READY
- Auth (email/phone), session restore
- Feed posts (text/image/video), like, comment, share, delete
- Profiles (users + owner visible posts)
- Messenger + WebRTC voice/video
- Groups, Reels, Live, Marketplace, Pages
- User dashboard + Owner dashboard
- Monetization (Stripe when key set)
- Production guards (no OTP leak, JWT check, health API)

## Before public launch (REQUIRED on Vercel)
1. Set env: JWT_SECRET, OWNER_USERNAME, OWNER_PASSWORD, ALLOW_DEV_OTP=0
2. Set SUPABASE_* or GCS_* so data persists
3. Deploy → open /api/health → ok:true
4. Test: register, post, comment, message, view profile

## Optional later
- Twilio/SMTP for SMS/email OTP at scale
- Stripe live keys for real payments
- TURN server for hard-NAT video calls
- Native APK/IPA (use PWA for now)
